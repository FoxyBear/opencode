export interface HeadlessRunOptions {
  prompt: string
  persona?: string
  timeoutMs?: number
  onSessionCreated?: (sessionId: string) => void
}

export interface HeadlessRunResult {
  response: string
  sessionId?: string
}

export namespace HeadlessSession {
  export async function run(_opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
    throw new Error("Daemon not available — start with 'foxybear serve'")
  }
}
