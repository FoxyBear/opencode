import { HeadlessSession, type HeadlessRunResult } from "./headless"
import { PersonaSession } from "../persona/session"
import { Log } from "../util/log"
import type { SessionID } from "../session/schema"

const log = Log.create({ service: "daemon.runner" })

export namespace Runner {
  export interface SessionExecutor {
    execute(
      prompt: string,
      persona?: string,
      signal?: AbortSignal,
      onSessionCreated?: (sessionId: string) => void,
    ): Promise<HeadlessRunResult>
  }

  export interface WireOptions {
    executor?: SessionExecutor
    getConfig?: () => Promise<any>
  }

  export function wire(opts: WireOptions = {}): void {
    const executor = opts.executor ?? buildDefaultExecutor()
    HeadlessSession.setRunner(async (prompt, persona, signal, onSessionCreated) => {
      const effectivePersona = persona ?? (opts.getConfig ? await readConfigPersona(opts.getConfig) : undefined)
      log.info("runner invoked", { persona: effectivePersona })
      return executor.execute(prompt, effectivePersona, signal, onSessionCreated)
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
      async execute(prompt, persona, _signal, onSessionCreated): Promise<HeadlessRunResult> {
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

            const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "")
            const created = await sdk.session.create({ title })
            const sessionID = created.data?.id
            if (!sessionID) {
              throw new Error("Failed to create session")
            }

            onSessionCreated?.(sessionID)

            if (resolvedPersona) {
              PersonaSession.attach(sessionID as SessionID, resolvedPersona)
              log.info("persona attached to session", {
                sessionID,
                persona: resolvedPersona.name,
              })
            }

            try {
              const model = resolvedPersona?.model ? Provider.parseModel(resolvedPersona.model) : undefined
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
