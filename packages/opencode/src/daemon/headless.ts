import { Log } from "../util/log"

const log = Log.create({ service: "daemon.headless" })

export interface HeadlessRunResult {
  sessionId: string
  response: string
  toolCalls: number
  durationMs: number
}

// SDD-04 SC-2: the run-chain carries optional resume + model context. These are
// ADDITIVE/optional so existing callers keep compiling; SDD-01 consumes
// `sessionId`, SDD-02 consumes `model`.
export interface RunModel {
  providerID: string
  modelID: string
}

export type SessionRunner = (
  prompt: string,
  persona?: string,
  signal?: AbortSignal,
  onSessionCreated?: (sessionId: string) => void,
  sessionId?: string,
  chatId?: string,
  model?: RunModel,
) => Promise<HeadlessRunResult>

let _runner: SessionRunner | null = null

export namespace HeadlessSession {
  export function setRunner(runner: SessionRunner): void {
    _runner = runner
    log.info("headless session runner wired")
  }

  export function hasRunner(): boolean {
    return _runner !== null
  }

  export async function run(input: {
    prompt: string
    persona?: string
    timeoutMs?: number
    onSessionCreated?: (sessionId: string) => void
    sessionId?: string
    chatId?: string
    model?: RunModel
  }): Promise<HeadlessRunResult> {
    if (!_runner) {
      throw new Error("Headless session runner not configured. Daemon may not be fully initialized.")
    }

    const timeoutMs = input.timeoutMs ?? 300_000
    const start = Date.now()
    const abort = new AbortController()

    let timer: ReturnType<typeof setTimeout>

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort(new Error(`Session timed out after ${timeoutMs}ms`))
        reject(abort.signal.reason)
      }, timeoutMs)
      if (typeof timer === "object" && "unref" in timer) timer.unref()
    })

    try {
      const result = await Promise.race([
        _runner(
          input.prompt,
          input.persona,
          abort.signal,
          input.onSessionCreated,
          input.sessionId,
          input.chatId,
          input.model,
        ),
        timeoutPromise,
      ])

      clearTimeout(timer!)

      log.info("headless session complete", {
        sessionId: result.sessionId,
        durationMs: Date.now() - start,
        toolCalls: result.toolCalls,
      })

      return result
    } catch (err) {
      clearTimeout(timer!)
      throw err
    }
  }

  export function _reset(): void {
    _runner = null
  }
}
