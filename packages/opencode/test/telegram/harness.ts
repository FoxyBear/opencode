// MOCKED-TELEGRAM end-to-end harness (SDD-01..04).
//
// Drives the real Telegram coordinator (ingestion poller, durable Queue,
// JobWorker, delivery loop, question bridge) exactly as production does, but
// with the network boundary replaced. The ONLY production seam this uses is
// `api.__setTransport` (src/telegram/api.ts): every Telegram HTTP call funnels
// through that transport, so the full api.ts logic (chunking, keyboard rows, the
// editMessageText "not modified" swallow) still executes while the wire is
// mocked. No api.telegram.org traffic. Real SQLite (the process-wide :memory:
// db seeded by test/preload.ts) backs Queue / TelegramStore / job_queue.
//
// The session executor is stubbed via HeadlessSession.setRunner, so a test
// controls what a job "does": return a canned response, hang, throw, fire
// onSessionCreated with a chosen id, or invoke the question tool
// (Question.Service.ask) under a real directory-scoped Instance.provide.

import { ulid } from "ulid"
import { asc, eq } from "drizzle-orm"
import { __setTransport, type TelegramTransport } from "../../src/telegram/api"
import { TelegramBot } from "../../src/telegram/bot"
import { JobWorker } from "../../src/queue/worker"
import { HeadlessSession, type HeadlessRunResult, type RunModel } from "../../src/daemon/headless"
import { Database } from "../../src/storage/db"
import { JobQueueTable, type JobRow } from "../../src/queue/queue.sql"

export interface RecordedCall {
  method: string
  body?: Record<string, any>
}

export interface KeyboardButton {
  text: string
  callback_data: string
}

// A stubbed session run. Mirrors the SessionRunner signature so a test controls
// resume vs create (via `sessionId`/`onSessionCreated`), the model it received,
// and the returned response — or throws / hangs.
export type RunnerBody = (args: {
  prompt: string
  persona?: string
  signal?: AbortSignal
  onSessionCreated?: (sessionId: string) => void
  sessionId?: string
  chatId?: string
  model?: RunModel
}) => Promise<HeadlessRunResult>

export interface HarnessOptions {
  allowedChatIds?: string[]
  persona?: string
}

// The worker and delivery loop scan job_queue GLOBALLY (across all chats), so a
// prior test's leftover rows would be claimed/delivered by a later test's bot.
// Each e2e test calls this in beforeEach to start from a pristine queue. The
// telegram_inbox is intentionally NOT purged (its accumulated ids back the
// durable poll-offset behavior).
export function purgeQueue(): void {
  Database.use((db) => db.delete(JobQueueTable).run())
}

const BOT_TOKEN = "TEST_TOKEN"

// The telegram_inbox and job_queue tables are process-wide (shared :memory: db),
// so update_ids and message_ids MUST be unique across harness instances or a
// later test's update collides with an earlier test's inbox row and is deduped
// away. Seed from a high, monotonic module counter.
let _globalUpdateId = Date.now() * 1000
let _globalMessageId = Date.now() * 1000 + 500_000

export class TelegramHarness {
  readonly calls: RecordedCall[] = []
  readonly getUpdatesCalls: Array<Record<string, any> | undefined> = []

  private _pendingBatches: any[][] = []
  private _updatesWaiter: ((updates: any[]) => void) | null = null
  private _running = false
  private _runnerBody: RunnerBody | null = null

  // Per-call transport override. If it returns a non-undefined value that value
  // is used; if it throws, the throw propagates (letting a test simulate a
  // failed ack send, a "message is not modified" edit, etc.). Returning
  // undefined falls through to the default recording behavior.
  transportOverride:
    | ((token: string, method: string, body?: Record<string, any>) => Promise<any> | any)
    | null = null

  constructor(private readonly opts: HarnessOptions = {}) {}

  // ---- lifecycle ---------------------------------------------------------

  /** Install the mock transport and start the bot (poller + delivery + bridge). */
  async start(): Promise<void> {
    __setTransport(this.transport)
    this._running = true
    await TelegramBot.start({
      enabled: true,
      bot_token: BOT_TOKEN,
      allowed_chat_ids: this.opts.allowedChatIds ?? [],
      persona: this.opts.persona ?? "katya",
      session_timeout_ms: 5_000,
      progress_interval_ms: 60_000,
      max_response_length: 4096,
    })
  }

  /** Start the durable JobWorker. Tick is large by default so drains are explicit. */
  async startWorker(opts?: { cap?: number; tickMs?: number }): Promise<void> {
    await JobWorker.start({ cap: opts?.cap ?? 3, tickMs: opts?.tickMs ?? 60_000 })
  }

  /** Wire the stubbed executor. Also flips HeadlessSession.hasRunner() to true. */
  setRunner(body: RunnerBody): void {
    this._runnerBody = body
    HeadlessSession.setRunner((prompt, persona, signal, onSessionCreated, sessionId, chatId, model) => {
      if (!this._runnerBody) throw new Error("harness runner body not set")
      return this._runnerBody({ prompt, persona, signal, onSessionCreated, sessionId, chatId, model })
    })
  }

  /** Convenience: a runner that creates a session (fires onSessionCreated) and echoes. */
  setEchoRunner(response = "ok"): void {
    this.setRunner(async ({ sessionId, onSessionCreated }) => {
      const sid = sessionId ?? "ses_" + ulid()
      if (!sessionId) onSessionCreated?.(sid)
      return { sessionId: sid, response, toolCalls: 0, durationMs: 1 }
    })
  }

  /** Explicit worker drain, awaiting all jobs the drain (and its cascade) started. */
  async drain(): Promise<void> {
    JobWorker.drain()
    await this.settle()
  }

  async stop(): Promise<void> {
    this._running = false
    // Release any parked long-poll so the poller loop can exit.
    if (this._updatesWaiter) {
      const w = this._updatesWaiter
      this._updatesWaiter = null
      w([])
    }
    await JobWorker.stop().catch(() => {})
    await TelegramBot.stop().catch(() => {})
    TelegramBot._reset()
    JobWorker._reset()
    HeadlessSession._reset()
    __setTransport(null)
  }

  // ---- inbound injection -------------------------------------------------

  nextUpdateId(): number {
    return _globalUpdateId++
  }

  /** Inject an inbound text message. Returns the update_id used. */
  injectMessage(chatId: string, text: string, updateId?: number): number {
    const id = updateId ?? this.nextUpdateId()
    this.pushUpdate({
      update_id: id,
      message: { message_id: _globalMessageId++, chat: { id: chatId }, text },
    })
    return id
  }

  /** Inject an inbound callback_query (inline-keyboard tap). Returns the update_id. */
  injectCallback(chatId: string, data: string, ackMessageId = 1, updateId?: number): number {
    const id = updateId ?? this.nextUpdateId()
    this.pushUpdate({
      update_id: id,
      callback_query: {
        id: "cbq-" + id,
        from: { id: chatId },
        message: { chat: { id: chatId }, message_id: ackMessageId },
        data,
      },
    })
    return id
  }

  private pushUpdate(update: any): void {
    if (this._updatesWaiter) {
      const w = this._updatesWaiter
      this._updatesWaiter = null
      w([update])
    } else {
      this._pendingBatches.push([update])
    }
  }

  // ---- job-row accessors -------------------------------------------------

  jobsForChat(chatId: string): JobRow[] {
    return Database.use((db) =>
      db
        .select()
        .from(JobQueueTable)
        .where(eq(JobQueueTable.chat_id, chatId))
        .orderBy(asc(JobQueueTable.time_created))
        .all(),
    )
  }

  jobForChat(chatId: string): JobRow | undefined {
    return this.jobsForChat(chatId).at(-1)
  }

  // ---- recorded-outbound accessors --------------------------------------

  /** Plain text sends (sendMessage without an inline keyboard). */
  sends(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "sendMessage" && !c.body?.reply_markup)
  }

  /** Inline-keyboard sends (sendMessageWithKeyboard -> sendMessage + reply_markup). */
  keyboardSends(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "sendMessage" && !!c.body?.reply_markup)
  }

  edits(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "editMessageText")
  }

  markupEdits(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "editMessageReplyMarkup")
  }

  answers(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "answerCallbackQuery")
  }

  /** Buttons of the most recent keyboard send. */
  lastKeyboard(): KeyboardButton[] {
    const last = this.keyboardSends().at(-1)
    const rows: KeyboardButton[][] = last?.body?.reply_markup?.inline_keyboard ?? []
    return rows.flat()
  }

  // ---- async helpers -----------------------------------------------------

  /** Yield to the event loop so background poller/worker fibers can advance. */
  async tick(times = 3): Promise<void> {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5))
  }

  /** Poll `predicate` until true or timeout. */
  async waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    if (!predicate()) throw new Error("waitFor timed out")
  }

  /** Let in-flight worker jobs settle (bounded). */
  async settle(): Promise<void> {
    await this.tick(5)
  }

  // ---- the mock transport ------------------------------------------------

  private transport: TelegramTransport = async (token, method, body) => {
    this.calls.push({ method, body })

    if (this.transportOverride) {
      const r = await this.transportOverride(token, method, body)
      if (r !== undefined) return r
    }

    switch (method) {
      case "getMe":
        return { id: 1, first_name: "TestBot", username: "testbot" }
      case "getUpdates":
        this.getUpdatesCalls.push(body)
        return this.nextUpdates()
      case "sendMessage":
        return { message_id: _globalMessageId++, chat: { id: body?.chat_id } }
      case "editMessageText":
      case "editMessageReplyMarkup":
      case "answerCallbackQuery":
        return {}
      default:
        return {}
    }
  }

  private nextUpdates(): Promise<any[]> | any[] {
    if (this._pendingBatches.length > 0) return this._pendingBatches.shift()!
    if (!this._running) return []
    return new Promise<any[]>((resolve) => {
      this._updatesWaiter = resolve
    })
  }
}
