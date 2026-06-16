import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow } from "./overflow"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000
  const PRUNE_PROTECTED_TOOLS = ["skill"]

  export interface SessionMemory {
    sessionID: string
    sections: Record<string, string>
    totalTokens: number
    updatedAt: string
  }

  export const SESSION_MEMORY_SECTIONS = [
    "session_title",
    "current_state",
    "task_specification",
    "files_and_functions",
    "workflow",
    "errors_and_corrections",
    "codebase_documentation",
    "learnings",
    "key_results",
    "worklog",
  ] as const

  const SESSION_MEMORY_SECTION_CAP = 2000
  const SESSION_MEMORY_TOTAL_CAP = 12000
  const sessionMemoryStore = new Map<string, SessionMemory>()

  export const COMPACTABLE_TOOLS = new Set([
    "read", "bash", "grep", "glob", "webfetch", "edit", "write",
    "websearch", "codesearch", "apply_patch", "multiedit", "list", "lsp",
  ])

  export const NON_COMPACTABLE_TOOLS = new Set([
    "skill", "task", "todowrite", "plan_exit", "plan_enter", "question", "invalid",
  ])

  export function isCompactable(toolId: string): boolean {
    if (NON_COMPACTABLE_TOOLS.has(toolId)) return false
    return true
  }

  export const MICROCOMPACT_PRESERVE = 5

  function truncateToTokens(text: string, maxTokens: number): string {
    const estimated = Token.estimate(text)
    if (estimated <= maxTokens) return text
    return text.slice(0, maxTokens * 4)
  }

  export function getFullCompactionPrompt(userMessages: string[]): string {
    const verbatimBlock = userMessages.map((m, i) => `[User message ${i + 1}]: ${m}`).join("\n")

    return `Provide a detailed structured summary for continuing our conversation above.
The summary you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.
Respond in the same language as the user's messages in the conversation.

When constructing the summary, use this 9-section template:
---
## 1. Primary request and intent

[What is the user's primary goal? What are they ultimately trying to accomplish?]

## 2. Key technical concepts

[Important technical details, APIs, patterns, and architectural decisions discussed]

## 3. Files and code sections

[Structured list of files read, edited, or created, with relevant code snippets]

## 4. Errors and fixes

[Errors encountered and how they were resolved]

## 5. Problem-solving approaches

[Approaches tried, what worked, what didn't, and why]

## 6. ALL user messages (verbatim)

IMPORTANT: Include these user messages exactly as written to prevent task drift:
${verbatimBlock}

## 7. Pending tasks

[What work remains to be done?]

## 8. Current work (detailed)

[What is currently being worked on? Include specific details about the current state]

## 9. Next step with direct quotes

[What should the next agent do first? Include direct quotes from the user about their expectations]
---`
  }

  export function stripAnalysisBlocks(text: string): string {
    return text.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").replace(/\n{3,}/g, "\n\n")
  }

  function extractSessionMemoryFromMessages(
    sessionID: string,
    messages: MessageV2.WithParts[],
  ): SessionMemory {
    const sections: Record<string, string> = {}
    const userTexts: string[] = []
    const assistantTexts: string[] = []
    const toolResults: { tool: string; output: string }[] = []
    const files = new Set<string>()
    const errors: string[] = []

    for (const msg of messages) {
      if (msg.info.role === "user") {
        for (const part of msg.parts) {
          if (part.type === "text") userTexts.push(part.text)
        }
      }
      for (const part of msg.parts) {
        if (part.type === "text" && msg.info.role === "assistant") {
          assistantTexts.push(part.text)
        }
        if (part.type === "tool" && part.state.status === "completed") {
          toolResults.push({ tool: part.tool, output: part.state.output })
          if (["read", "edit", "write", "apply_patch", "multiedit"].includes(part.tool)) {
            const input = part.state.input as Record<string, unknown>
            if (typeof input.file_path === "string") files.add(input.file_path)
            if (typeof input.path === "string") files.add(input.path)
          }
          if (part.state.output.toLowerCase().includes("error") ||
              part.state.output.toLowerCase().includes("fail")) {
            errors.push(`[${part.tool}] ${part.state.output.slice(0, 500)}`)
          }
        }
        if (part.type === "tool" && part.state.status === "error") {
          errors.push(`[${part.tool}] ${part.state.error}`)
        }
      }
    }

    sections.session_title = truncateToTokens(
      userTexts[0]?.length ?? 0 > 100 ? (userTexts[0] ?? "Untitled").slice(0, 100) + "..." : (userTexts[0] ?? "Untitled session"),
      SESSION_MEMORY_SECTION_CAP,
    )

    const lastAssistant = assistantTexts[assistantTexts.length - 1] || ""
    const lastUser = userTexts[userTexts.length - 1] || ""
    sections.current_state = truncateToTokens(
      `Last user request: ${lastUser}\nLast assistant response: ${lastAssistant.slice(0, 1000)}`,
      SESSION_MEMORY_SECTION_CAP,
    )

    sections.task_specification = truncateToTokens(
      userTexts.map((t, i) => `[${i + 1}] ${t}`).join("\n"),
      SESSION_MEMORY_SECTION_CAP,
    )

    sections.files_and_functions = truncateToTokens(
      files.size > 0 ? Array.from(files).join("\n") : "No files accessed",
      SESSION_MEMORY_SECTION_CAP,
    )

    const toolSummary = toolResults.reduce<Record<string, number>>((acc, t) => {
      acc[t.tool] = (acc[t.tool] || 0) + 1
      return acc
    }, {})
    sections.workflow = truncateToTokens(
      `Tool usage: ${Object.entries(toolSummary).map(([k, v]) => `${k}(${v})`).join(", ")}\nTotal messages: ${messages.length}`,
      SESSION_MEMORY_SECTION_CAP,
    )

    sections.errors_and_corrections = truncateToTokens(
      errors.length > 0 ? errors.join("\n---\n") : "No errors encountered",
      SESSION_MEMORY_SECTION_CAP,
    )

    const readOutputs = toolResults
      .filter((t) => t.tool === "read" && t.output !== "[content cleared]")
      .map((t) => t.output.slice(0, 200))
    sections.codebase_documentation = truncateToTokens(
      readOutputs.length > 0 ? `Files read:\n${readOutputs.join("\n---\n")}` : "No codebase documentation gathered",
      SESSION_MEMORY_SECTION_CAP,
    )

    const learnings = assistantTexts
      .filter((t) => t.toLowerCase().includes("learn") || t.toLowerCase().includes("note") || t.toLowerCase().includes("important"))
      .map((t) => t.slice(0, 300))
    sections.learnings = truncateToTokens(
      learnings.length > 0 ? learnings.join("\n") : "No explicit learnings captured",
      SESSION_MEMORY_SECTION_CAP,
    )

    const bashResults = toolResults
      .filter((t) => t.tool === "bash" && t.output !== "[content cleared]")
      .map((t) => t.output.slice(0, 300))
    sections.key_results = truncateToTokens(
      bashResults.length > 0 ? bashResults.slice(-5).join("\n---\n") : "No key results",
      SESSION_MEMORY_SECTION_CAP,
    )

    const worklog = messages
      .filter((m) => m.info.role === "user")
      .map((m) => {
        const text = m.parts.find((p) => p.type === "text")
        return text && text.type === "text" ? `- ${text.text.slice(0, 200)}` : null
      })
      .filter(Boolean)
    sections.worklog = truncateToTokens(worklog.join("\n"), SESSION_MEMORY_SECTION_CAP)

    let totalTokens = 0
    for (const value of Object.values(sections)) {
      totalTokens += Token.estimate(value)
    }

    if (totalTokens > SESSION_MEMORY_TOTAL_CAP) {
      const ratio = SESSION_MEMORY_TOTAL_CAP / totalTokens
      for (const key of Object.keys(sections)) {
        const sectionTokens = Token.estimate(sections[key])
        const targetTokens = Math.floor(sectionTokens * ratio)
        sections[key] = truncateToTokens(sections[key], targetTokens)
      }
      totalTokens = 0
      for (const value of Object.values(sections)) {
        totalTokens += Token.estimate(value)
      }
    }

    return { sessionID, sections, totalTokens, updatedAt: new Date().toISOString() }
  }

  export interface Interface {
    readonly isOverflow: (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) => Effect.Effect<boolean>
    readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
    readonly process: (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<"continue" | "stop">
    readonly create: (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<void>
    readonly microcompact: (input: {
      sessionID: SessionID
      messages: MessageV2.WithParts[]
      budgetPercent: number
    }) => Effect.Effect<{ cleared: number; tokensFreed: number }>
    readonly isAutoCompactionDisabled: () => Effect.Effect<boolean>
    readonly getCircuitBreakerWarning: () => Effect.Effect<string | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Bus.Service
    | Config.Service
    | Session.Service
    | Agent.Service
    | Plugin.Service
    | SessionProcessor.Service
    | Provider.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const session = yield* Session.Service
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const processors = yield* SessionProcessor.Service
      const provider = yield* Provider.Service

      const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
        tokens: MessageV2.Assistant["tokens"]
        model: Provider.Model
      }) {
        return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
      })

      // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
      // calls, then erases output of older tool calls to free context space
      const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
        const cfg = yield* config.get()
        if (cfg.compaction?.prune === false) return
        log.info("pruning")

        const msgs = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (!msgs) return

        let total = 0
        let pruned = 0
        const toPrune: MessageV2.ToolPart[] = []
        let turns = 0

        loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
          const msg = msgs[msgIndex]
          if (msg.info.role === "user") turns++
          if (turns < 2) continue
          if (msg.info.role === "assistant" && msg.info.summary) break loop
          for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = msg.parts[partIndex]
            if (part.type === "tool")
              if (part.state.status === "completed") {
                if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
                if (part.state.time.compacted) break loop
                const estimate = Token.estimate(part.state.output)
                total += estimate
                if (total > PRUNE_PROTECT) {
                  pruned += estimate
                  toPrune.push(part)
                }
              }
          }
        }

        log.info("found", { pruned, total })
        if (pruned > PRUNE_MINIMUM) {
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned", { count: toPrune.length })
        }
      })

      let consecutiveFailures = 0
      let autoDisabled = false

      const recordCompactionFailure = Effect.fn("SessionCompaction.recordCompactionFailure")(function* () {
        const cfg = yield* config.get()
        const maxFailures = cfg.compaction?.max_failures ?? 3
        consecutiveFailures++
        log.info("compaction failure recorded", { consecutiveFailures, maxFailures })
        if (consecutiveFailures >= maxFailures) {
          autoDisabled = true
          log.warn("circuit breaker tripped — auto-compaction disabled", { consecutiveFailures })
        }
      })

      const recordCompactionSuccess = Effect.fn("SessionCompaction.recordCompactionSuccess")(function* () {
        consecutiveFailures = 0
        autoDisabled = false
      })

      const _isAutoCompactionDisabled = Effect.fn("SessionCompaction.isAutoCompactionDisabled")(function* () {
        return autoDisabled
      })

      const _getCircuitBreakerWarning = Effect.fn("SessionCompaction.getCircuitBreakerWarning")(function* () {
        if (autoDisabled) {
          return "Auto-compaction disabled after consecutive failures. Use /compact to retry." as string | undefined
        }
        return undefined
      })

      const microcompact = Effect.fn("SessionCompaction.microcompact")(function* (input: {
        sessionID: SessionID
        messages: MessageV2.WithParts[]
        budgetPercent: number
      }) {
        const cfg = yield* config.get()
        const threshold = cfg.compaction?.tier1_threshold ?? input.budgetPercent
        log.info("microcompact", { threshold, messageCount: input.messages.length })

        let cleared = 0
        let tokensFreed = 0

        const compactableParts: MessageV2.ToolPart[] = []
        for (let msgIndex = input.messages.length - 1; msgIndex >= 0; msgIndex--) {
          const msg = input.messages[msgIndex]
          for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = msg.parts[partIndex]
            if (
              part.type === "tool" &&
              part.state.status === "completed" &&
              !part.state.time.compacted &&
              isCompactable(part.tool)
            ) {
              compactableParts.push(part)
            }
          }
        }

        const toClear = compactableParts.slice(MICROCOMPACT_PRESERVE)

        for (const part of toClear) {
          if (part.state.status === "completed") {
            const estimate = Token.estimate(part.state.output)
            part.state.time.compacted = Date.now()
            part.state.output = "[content cleared]"
            yield* session.updatePart(part)
            cleared++
            tokensFreed += estimate
          }
        }

        log.info("microcompact done", { cleared, tokensFreed })
        return { cleared, tokensFreed }
      })

      const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
        parentID: MessageID
        messages: MessageV2.WithParts[]
        sessionID: SessionID
        auto: boolean
        overflow?: boolean
      }) {
        const parent = input.messages.findLast((m) => m.info.id === input.parentID)
        if (!parent || parent.info.role !== "user") {
          throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
        }
        const userMessage = parent.info

        let messages = input.messages
        let replay:
          | {
              info: MessageV2.User
              parts: MessageV2.Part[]
            }
          | undefined
        if (input.overflow) {
          const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
          for (let i = idx - 1; i >= 0; i--) {
            const msg = input.messages[i]
            if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
              replay = { info: msg.info, parts: msg.parts }
              messages = input.messages.slice(0, i)
              break
            }
          }
          const hasContent =
            replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
          if (!hasContent) {
            replay = undefined
            messages = input.messages
          }
        }

        const agent = yield* agents.get("compaction")
        const model = agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
        // Allow plugins to inject context or replace compaction prompt.
        const compacting = yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )
        const userMessages = messages
          .filter((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
          .flatMap((m) => m.parts.filter((p): p is MessageV2.TextPart => p.type === "text").map((p) => p.text))
        const defaultPrompt = getFullCompactionPrompt(userMessages)

        const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
        const msgs = structuredClone(messages)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
        const ctx = yield* InstanceState.context
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = yield* processor.process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            ...modelMessages,
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          model,
        })

        if (result === "compact") {
          processor.message.error = new MessageV2.ContextOverflowError({
            message: replay
              ? "Conversation history too large to compact - exceeds model context limit"
              : "Session too large to compact - context exceeds model limit even after stripping media",
          }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
          return "stop"
        }

        if (result === "continue" && input.auto) {
          if (replay) {
            const original = replay.info
            const replayMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: original.agent,
              model: original.model,
              format: original.format,
              tools: original.tools,
              system: original.system,
            })
            for (const part of replay.parts) {
              if (part.type === "compaction") continue
              const replayPart =
                part.type === "file" && MessageV2.isMedia(part.mime)
                  ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                  : part
              yield* session.updatePart({
                ...replayPart,
                id: PartID.ascending(),
                messageID: replayMsg.id,
                sessionID: input.sessionID,
              })
            }
          }

          if (!replay) {
            const info = yield* provider.getProvider(userMessage.model.providerID)
            if (
              (yield* plugin.trigger(
                "experimental.compaction.autocontinue",
                {
                  sessionID: input.sessionID,
                  agent: userMessage.agent,
                  model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                  provider: {
                    source: info.source,
                    info,
                    options: info.options,
                  },
                  message: userMessage,
                  overflow: input.overflow === true,
                },
                { enabled: true },
              )).enabled
            ) {
              const continueMsg = yield* session.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: input.sessionID,
                time: { created: Date.now() },
                agent: userMessage.agent,
                model: userMessage.model,
              })
              const text =
                (input.overflow
                  ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                  : "") +
                "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: continueMsg.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text,
                time: {
                  start: Date.now(),
                  end: Date.now(),
                },
              })
            }
          }
        }

        if (processor.message.error) {
          yield* recordCompactionFailure()
          return "stop"
        }
        if (result === "continue") {
          yield* recordCompactionSuccess()
          try {
            const memory = extractSessionMemoryFromMessages(input.sessionID, input.messages)
            sessionMemoryStore.set(input.sessionID, memory)
          } catch {
            log.warn("session memory extraction failed", { sessionID: input.sessionID })
          }
          yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
        }
        return result
      })

      const create = Effect.fn("SessionCompaction.create")(function* (input: {
        sessionID: SessionID
        agent: string
        model: { providerID: ProviderID; modelID: ModelID }
        auto: boolean
        overflow?: boolean
      }) {
        const msg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: input.model,
          sessionID: input.sessionID,
          agent: input.agent,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "compaction",
          auto: input.auto,
          overflow: input.overflow,
        })
      })

      return Service.of({
        isOverflow,
        prune,
        process: processCompaction,
        create,
        microcompact,
        isAutoCompactionDisabled: _isAutoCompactionDisabled,
        getCircuitBreakerWarning: _getCircuitBreakerWarning,
      })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(SessionProcessor.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(Config.defaultLayer),
    ),
  )
}
