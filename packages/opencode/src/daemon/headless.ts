import { Log } from "../util/log"

const log = Log.create({ service: "daemon.headless" })

export interface HeadlessRunResult {
  sessionId: string
  response: string
  toolCalls: number
  durationMs: number
}

type SessionRunner = (
  prompt: string,
  persona?: string,
  signal?: AbortSignal,
  onSessionCreated?: (sessionId: string) => void,
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
        _runner(input.prompt, input.persona, abort.signal, input.onSessionCreated),
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
