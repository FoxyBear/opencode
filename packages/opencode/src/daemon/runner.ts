import { HeadlessSession, type HeadlessRunResult, type RunModel } from "./headless"
import { PersonaSession } from "../persona/session"
import { Log } from "../util/log"
import type { SessionID } from "../session/schema"

const log = Log.create({ service: "daemon.runner" })

export namespace Runner {
  export interface SessionExecutor {
    // SDD-04 SC-2: `sessionId`/`chatId`/`model` are additive/optional.
    execute(
      prompt: string,
      persona?: string,
      signal?: AbortSignal,
      onSessionCreated?: (sessionId: string) => void,
      sessionId?: string,
      chatId?: string,
      model?: RunModel,
    ): Promise<HeadlessRunResult>
  }

  export interface WireOptions {
    executor?: SessionExecutor
    getConfig?: () => Promise<any>
  }

  export function wire(opts: WireOptions = {}): void {
    const executor = opts.executor ?? buildDefaultExecutor()
    HeadlessSession.setRunner(async (prompt, persona, signal, onSessionCreated, sessionId, chatId, model) => {
      const effectivePersona = persona ?? (opts.getConfig ? await readConfigPersona(opts.getConfig) : undefined)
      log.info("runner invoked", { persona: effectivePersona, resume: !!sessionId, override: !!model })
      return executor.execute(prompt, effectivePersona, signal, onSessionCreated, sessionId, chatId, model)
    })
    log.info("headless runner wired")
  }

  async function readConfigPersona(getConfig: () => Promise<any>): Promise<string | undefined> {
    try {
      const cfg = await getConfig()
      const value = cfg?.persona
      return typeof value === "string" && value.length > 0 ? value : undefined
    } catch (err) {
      log.warn("failed to read config.persona", { error: String(err) })
      return undefined
    }
  }

  function buildDefaultExecutor(): SessionExecutor {
    return {
      // SDD-04: `_signal` is intentionally unused — the default executor does not
      // cancel sdk.session.prompt today (W-26 / FOLLOW-UP-1). `resumeSessionId`
      // resumes a chat's durable session (SDD-01); `overrideModel` is the chat
      // model override (SDD-02), taking precedence over persona frontmatter.
      async execute(prompt, persona, _signal, onSessionCreated, resumeSessionId, _chatId, overrideModel): Promise<HeadlessRunResult> {
        const start = Date.now()
        const { Server } = await import("../server/server")
        const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
        const { getConfig } = await import("../config/bridge")
        const { Provider } = await import("../provider/provider")
        const { Instance } = await import("../project/instance")
        const { InstanceBootstrap } = await import("../project/bootstrap")
        const { AppRuntime } = await import("../effect/app-runtime")

        return Instance.provide({
          directory: process.cwd(),
          init: () => AppRuntime.runPromise(InstanceBootstrap),
          async fn(): Promise<HeadlessRunResult> {
            const cfg = await getConfig().catch(() => ({}) as any)
            const configuredMcpServers = Object.keys(cfg?.mcp ?? {})
            const effectivePersona =
              persona ?? (typeof cfg?.persona === "string" && cfg.persona.length > 0 ? cfg.persona : undefined)
            const resolvedPersona = await PersonaSession.resolve(effectivePersona, configuredMcpServers)

            const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = new Request(input, init)
              return Server.Default().app.fetch(request)
            }) as typeof globalThis.fetch

            const sdk = createOpencodeClient({ baseUrl: "http://foxybear.internal", fetch: fetchFn })

            // SDD-04 SC-2: resume the chat's durable session when one was supplied
            // and still exists (probe via session.messages); otherwise create a
            // fresh session and fire onSessionCreated. onSessionCreated fires ONLY
            // on creation, never on resume, so the worker's write-back is skipped
            // for resumed sessions (W-12a).
            let sessionID: string | undefined
            if (resumeSessionId) {
              try {
                await sdk.session.messages({ sessionID: resumeSessionId } as any)
                sessionID = resumeSessionId
              } catch (err) {
                log.info("resume session missing, creating new", {
                  sessionID: resumeSessionId,
                  error: String(err),
                })
              }
            }

            if (!sessionID) {
              const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "")
              const created = await sdk.session.create({ title })
              sessionID = created.data?.id
              if (!sessionID) {
                throw new Error("Failed to create session")
              }
              onSessionCreated?.(sessionID)
            }

            if (resolvedPersona) {
              PersonaSession.attach(sessionID as SessionID, resolvedPersona)
              log.info("persona attached to session", {
                sessionID,
                persona: resolvedPersona.name,
              })
            }

            try {
              // Chat model override (SDD-02) wins over persona frontmatter.
              const model = overrideModel ?? (resolvedPersona?.model ? Provider.parseModel(resolvedPersona.model) : undefined)
              const response = await sdk.session.prompt({
                sessionID,
                parts: [{ type: "text", text: prompt }],
                ...(model ? { model } : {}),
              } as any)

              const assembled = assembleResponse(response.data)
              let toolCalls = assembled.toolCalls
              try {
                const allMsgs = await sdk.session.messages({ sessionID } as any)
                const list: any[] = Array.isArray(allMsgs.data) ? allMsgs.data : []
                let count = 0
                for (const m of list) {
                  if (m?.info?.role !== "assistant") continue
                  if (!Array.isArray(m.parts)) continue
                  for (const p of m.parts) {
                    if (p?.type === "tool") count++
                  }
                }
                if (count > toolCalls) toolCalls = count
              } catch (err) {
                log.warn("session.messages lookup failed; falling back to final-message count", {
                  error: String(err),
                })
              }
              return {
                sessionId: sessionID,
                response: assembled.text,
                toolCalls,
                durationMs: Date.now() - start,
              }
            } finally {
              if (resolvedPersona) {
                PersonaSession.clear(sessionID as SessionID)
              }
            }
          },
        })
      },
    }
  }

  export function assembleResponse(data: any): { text: string; toolCalls: number } {
    if (!data || !Array.isArray(data.parts)) {
      return { text: "", toolCalls: 0 }
    }
    const textParts = data.parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
      .map((p: any) => p.text as string)
    const toolCalls = data.parts.filter((p: any) => p?.type === "tool").length
    return { text: textParts.join("\n").trim(), toolCalls }
  }
}
