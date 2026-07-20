// INDEPENDENT acceptance tests for SDD-01 (durable per-chat sessions).
//
// Every expected value below traces to a SPEC statement (WHAT req N / VERIFY Vn
// in docs/specs/260719_telegram_sdd-01-durable-sessions.md, and SC-1/SC-2 in the
// master 260719_telegram_sdd-00-master.md), never to an implementation body.
//
// The system is driven ONLY through the mocked-Telegram harness
// (test/telegram/harness.ts): inject inbound updates, start the worker, drain,
// then read job rows + outbound sends + TelegramStore. Ingestion no longer
// executes inline (SC-2), so every resume/create assertion is observed AFTER the
// worker drains the job.
//
// The session executor is stubbed via the harness (HeadlessSession.setRunner).
// The create-vs-resume DECISION itself lives in SDD-04's runner (buildDefaultExecutor)
// which the harness replaces; so the stubbed runner honors the SC-2 contract
// (fire onSessionCreated only when it creates a NEW session) and the tests observe
// the SDD-01-owned seams: ingestion contributes payload.sessionId, and the worker's
// onSessionCreated callback writes the new id back to BOTH job_queue.session_id and
// telegram_session.session_id.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { ulid } from "ulid"
import { eq } from "drizzle-orm"
import { TelegramHarness, purgeQueue } from "../harness"
import { JobWorker } from "../../../src/queue/worker"
import { TelegramStore } from "../../../src/telegram/store"
import { HarnessCommands } from "../../../src/harness/commands"
import { Database } from "../../../src/storage/db"
import { TelegramSessionTable } from "../../../src/queue/queue.sql"
import { SessionTable } from "../../../src/session/session.sql"
import { ProjectTable } from "../../../src/project/project.sql"

// Unique per-file token so chat ids / session ids never collide with rows left
// by other test files in the process-wide :memory: db (telegram_session persists
// across tests; only job_queue is purged in beforeEach).
const RUN = ulid()
let _seq = 0
function chatId(label: string): string {
  return `sdd01-${RUN}-${label}`
}
function uid(): string {
  return `${RUN}-${_seq++}`
}

// Record of each stubbed session run so a test can observe what the worker passed
// in (sessionId = resume seam) and what was created (onSessionCreated write-back).
interface RunLog {
  prompt: string
  sessionIdArg?: string
  created?: string
}

// A runner honoring the SC-2 contract: resume when given a sessionId (no
// onSessionCreated), else create a new id and fire onSessionCreated exactly once.
function trackingRunner(runs: RunLog[]) {
  return async ({
    prompt,
    sessionId,
    onSessionCreated,
  }: {
    prompt: string
    sessionId?: string
    onSessionCreated?: (id: string) => void
  }) => {
    if (sessionId) {
      runs.push({ prompt, sessionIdArg: sessionId })
      return { sessionId, response: "ok:" + prompt, toolCalls: 0, durationMs: 1 }
    }
    const sid = "ses_" + uid()
    onSessionCreated?.(sid)
    runs.push({ prompt, created: sid })
    return { sessionId: sid, response: "ok:" + prompt, toolCalls: 0, durationMs: 1 }
  }
}

// Seed a telegram_session row directly via the SDD-04-owned schema (columns from
// queue.sql.ts). Independent of TelegramStore internals; used only for setup.
function seedSession(chat: string, fields: { session_id?: string | null; persona?: string | null; model_override?: string | null }): void {
  Database.use((db) =>
    db
      .insert(TelegramSessionTable)
      .values({ chat_id: chat, ...fields } as any)
      .onConflictDoUpdate({ target: TelegramSessionTable.chat_id, set: fields as any })
      .run(),
  )
}

// Seed a real FoxyBear session row (mirrors correlation.test.ts) so "underlying
// session rows still exist / are resolvable" can be asserted.
function seedRealSession(id: string): void {
  const project = "prj_" + uid()
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id: project, worktree: "/tmp/" + project, sandboxes: [] } as any)
      .onConflictDoNothing()
      .run(),
  )
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: project,
        parent_id: null,
        slug: "s",
        directory: "/tmp",
        title: "t",
        version: "0",
      } as any)
      .run(),
  )
}

function realSessionExists(id: string): boolean {
  // SessionTable.id is a branded SessionID column; cast the plain string for the
  // equality (test helper only).
  return Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id as any)).all()).length > 0
}

let harness: TelegramHarness

beforeEach(() => {
  purgeQueue()
})

afterEach(async () => {
  if (harness) await harness.stop().catch(() => {})
})

// Start a harness allowing exactly the given chats, with the tracking runner and
// worker wired. Empty/other allowlist semantics are unknown to this test, so we
// always pass the exact chats used (works whether [] means allow-all or deny-all).
async function startHarness(allowed: string[], runs: RunLog[], workerOpts?: { cap?: number }): Promise<TelegramHarness> {
  const h = new TelegramHarness({ allowedChatIds: allowed })
  await h.start()
  await h.startWorker(workerOpts)
  h.setRunner(trackingRunner(runs) as any)
  return h
}

describe("SDD-01 durable per-chat sessions — VERIFY", () => {
  // V1 — new session persists via worker write-back (req 1, SC-2).
  // "ingestion SHALL enqueue a job whose payload.sessionId is undefined ... the
  //  worker SHALL create exactly one new session ... and via onSessionCreated
  //  persist the new id back to BOTH job_queue.session_id and the chat's
  //  telegram_session.session_id."
  test("V1 new session: payload.sessionId undefined, one create, id written back to both tables", async () => {
    const chat = chatId("V1")
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)

    harness.injectMessage(chat, "A")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")

    // Ingestion enqueued with no resume id.
    const job = harness.jobForChat(chat)!
    expect(job.payload.sessionId).toBeUndefined()

    // Exactly one session create (proxy: onSessionCreated fired exactly once).
    expect(runs.filter((r) => r.created).length).toBe(1)
    const createdId = runs[0].created!

    // Written back to job_queue.session_id ...
    expect(job.session_id).toBe(createdId)
    // ... and to telegram_session.session_id (equals the id the worker ran against).
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(createdId)
  })

  // V2 — reuse/resume accrues context through the worker (req 2, SC-2).
  // "ingestion SHALL set payload.sessionId to that stored id ... zero additional
  //  create ... onSessionCreated did NOT fire ... both prompts targeted the SAME
  //  session_id."
  test("V2 resume: second message carries stored id, no new create, same session", async () => {
    const chat = chatId("V2")
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)

    // Message A -> create.
    harness.injectMessage(chat, "A")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")
    const storedId = TelegramStore.getByChat(chat)!.session_id!
    expect(storedId).toBeTruthy()

    // Message B -> resume.
    harness.injectMessage(chat, "B")
    await harness.waitFor(() => harness.jobsForChat(chat).length === 2)
    await harness.drain()
    await harness.waitFor(() => harness.jobsForChat(chat).every((j) => j.status === "done"))

    const jobB = harness.jobForChat(chat)!
    expect(jobB.payload.sessionId).toBe(storedId) // ingestion set the resume seam
    expect(runs.filter((r) => r.created).length).toBe(1) // zero ADDITIONAL creates
    // The resume run received the stored id and did not create.
    const runB = runs.find((r) => r.prompt === "B")!
    expect(runB.sessionIdArg).toBe(storedId)
    expect(runB.created).toBeUndefined()
    // Mapping unchanged (no write-back on resume).
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(storedId)
  })

  // V2 (context-accrual sub-assertion) — the message stream for the session
  // contains both "A" and "B" in order. NOT exercisable: the harness stubs the
  // session executor (HeadlessSession.setRunner), so no rows are written to the
  // message/part tables and sdk.session.messages has nothing to return. Real
  // context accrual is the reused TUI/web run-loop path, out of SDD-01's own code.
  test.todo("V2b message stream shows A then B — stubbed runner does not persist message rows", () => {})

  // V3 — self-heal on stale id (req 3, SC-2).
  // "the worker SHALL self-heal by creating a new session ... and via
  //  onSessionCreated overwriting the stored mapping in BOTH job_queue.session_id
  //  and telegram_session.session_id ... The user SHALL receive a normal response."
  // NOTE: the stale-id PROBE/decision (sdk.session.messages) lives in SDD-04's
  // runner, which the harness stubs; this test exercises the SDD-01/SC-2 OBSERVABLE
  // — when the worker creates a new session despite a provided id, the write-back
  // OVERWRITES both tables and the old id is gone.
  test("V3 self-heal: create-on-stale overwrites mapping in both tables, normal reply", async () => {
    const chat = chatId("V3")
    const staleId = "ses_stale_" + uid()
    seedSession(chat, { session_id: staleId })

    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)
    // Runner that ignores the provided (stale) id and creates a new session,
    // mirroring the runner's self-heal fall-through to the create branch.
    harness.setRunner((async ({ onSessionCreated, prompt }: any) => {
      const sid = "ses_healed_" + uid()
      onSessionCreated?.(sid)
      runs.push({ prompt, created: sid })
      return { sessionId: sid, response: "ok:" + prompt, toolCalls: 0, durationMs: 1 }
    }) as any)

    harness.injectMessage(chat, "hi")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    // Ingestion still contributed the stale id as the resume seam.
    expect(harness.jobForChat(chat)!.payload.sessionId).toBe(staleId)

    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")

    const healed = runs[0].created!
    expect(healed).not.toBe(staleId)
    // Overwritten in both tables; old id gone.
    expect(harness.jobForChat(chat)!.session_id).toBe(healed)
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(healed)
    // Normal (non-error) terminal state.
    expect(harness.jobForChat(chat)!.status).toBe("done")
    expect(harness.jobForChat(chat)!.error).toBeFalsy()
  })

  // V4 — mapping survives job completion (req 4).
  // "WHEN a turn completes (success or error), the system SHALL NOT delete or
  //  clear the chat's stored session_id."
  test("V4 mapping survives both success and forced-error terminal states", async () => {
    const chat = chatId("V4")
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)

    // Turn 1: success -> creates + persists.
    harness.injectMessage(chat, "A")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")
    const stored = TelegramStore.getByChat(chat)!.session_id!
    expect(stored).toBeTruthy()

    // Turn 2: forced executor error on resume.
    harness.setRunner((async () => {
      throw new Error("forced executor error")
    }) as any)
    harness.injectMessage(chat, "B")
    await harness.waitFor(() => harness.jobsForChat(chat).length === 2)
    await harness.drain()
    await harness.waitFor(() => harness.jobsForChat(chat).some((j) => j.status === "error"))

    // Both after success and after error: mapping intact, same non-null id.
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(stored)
  })

  // V5 — restart resumes stored session (req 5, CC-1).
  // "ingestion SHALL read that id back from SQLite into payload.sessionId and the
  //  worker SHALL resume that same stored session_id. No conversation identity may
  //  be reconstructed from process memory."
  test("V5 restart: stored id read back from SQLite, resumed, no new create", async () => {
    const chat = chatId("V5")
    const runs1: RunLog[] = []
    harness = await startHarness([chat], runs1)

    harness.injectMessage(chat, "A")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")
    const preRestart = TelegramStore.getByChat(chat)!.session_id!
    expect(preRestart).toBeTruthy()

    // Restart: stop() drops all in-memory state (TelegramBot/JobWorker/HeadlessSession
    // _reset). The process-wide :memory: db (telegram_session) persists.
    await harness.stop()

    const runs2: RunLog[] = []
    harness = await startHarness([chat], runs2)
    harness.injectMessage(chat, "post-restart")
    // The pre-restart job A row persists in job_queue; wait for the NEW (2nd) job.
    await harness.waitFor(() => harness.jobsForChat(chat).length >= 2)
    // Ingestion read the pre-restart id back from SQLite.
    expect(harness.jobForChat(chat)!.payload.sessionId).toBe(preRestart)
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")

    // Resumed, no new session created.
    expect(runs2.filter((r) => r.created).length).toBe(0)
    expect(runs2.find((r) => r.prompt === "post-restart")?.sessionIdArg).toBe(preRestart)
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(preRestart)
  })

  // V6 — /new nulls the session, next message starts fresh (req 6, SC-1/SC-2).
  // "/new SHALL set that chat's stored session_id to NULL while PRESERVING
  //  model_override and persona ... SHALL NOT reach HarnessCommands.execute ...
  //  the next message creates exactly one new session S2 != S1 ... /new SHALL NOT
  //  delete the underlying FoxyBear session rows."
  test("V6 /new: nulls session, preserves model_override+persona, enqueues no job, next msg creates S2!=S1", async () => {
    const chat = chatId("V6")
    const s1 = "ses_" + uid()
    seedRealSession(s1)
    seedSession(chat, { session_id: s1, persona: "katya", model_override: "deepseek/deepseek-chat" })

    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)
    const execSpy = spyOn(HarnessCommands, "execute")

    // /new
    harness.injectMessage(chat, "/new")
    await harness.waitFor(() => harness.sends().some((c) => String(c.body?.chat_id) === chat))
    await harness.tick()

    // Confirmation reply sent; did NOT reach the registry.
    expect(harness.sends().some((c) => String(c.body?.chat_id) === chat)).toBe(true)
    expect(execSpy.mock.calls.some(([name]) => name === "new")).toBe(false)

    // session_id nulled, persona + model_override preserved.
    const row = TelegramStore.getByChat(chat)!
    expect(row.session_id).toBeNull()
    expect(row.persona).toBe("katya")
    expect(row.model_override).toBe("deepseek/deepseek-chat")

    // /new enqueued NO job.
    expect(harness.jobsForChat(chat).length).toBe(0)

    // Underlying S1 session rows still exist (only unbound).
    expect(realSessionExists(s1)).toBe(true)

    // Next message starts fresh: payload.sessionId undefined, one new session S2 != S1.
    harness.injectMessage(chat, "hello again")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    expect(harness.jobForChat(chat)!.payload.sessionId).toBeUndefined()
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")

    const s2 = TelegramStore.getByChat(chat)!.session_id!
    expect(s2).toBeTruthy()
    expect(s2).not.toBe(s1)
    expect(runs.filter((r) => r.created).length).toBe(1)

    execSpy.mockRestore()
  })

  // V7 — /resume <id> validates then binds, rejects missing (req 7).
  // "SHALL validate the session exists, then bind ... WHEN <id> is missing or
  //  names no existing session, SHALL reject ... and SHALL NOT change the existing
  //  mapping ... none of these reached HarnessCommands.execute."
  test("V7 /resume rejects missing id and no-arg without changing mapping, bypasses registry", async () => {
    const chat = chatId("V7")
    const s1 = "ses_bound_" + uid()
    seedSession(chat, { session_id: s1 })

    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)
    const execSpy = spyOn(HarnessCommands, "execute")

    // Action B: /resume <nonexistent> -> reject, mapping unchanged.
    const missing = "ses_does_not_exist_" + uid()
    const sendsBefore = harness.sends().length
    harness.injectMessage(chat, "/resume " + missing)
    await harness.waitFor(() => harness.sends().length > sendsBefore)
    await harness.tick()
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(s1) // unchanged
    expect(harness.jobsForChat(chat).length).toBe(0) // no job enqueued

    // Action C: /resume with no arg -> usage reply, no change.
    const sendsBefore2 = harness.sends().length
    harness.injectMessage(chat, "/resume")
    await harness.waitFor(() => harness.sends().length > sendsBefore2)
    await harness.tick()
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(s1)
    expect(harness.jobsForChat(chat).length).toBe(0)

    // Neither reached the registry.
    expect(execSpy.mock.calls.some(([name]) => name === "resume")).toBe(false)
    execSpy.mockRestore()
  })

  // V7 (valid-bind sub-assertion) — /resume S3 where S3 is a real, SDK-resolvable
  // session binds the chat to S3. Attempted with a directly-seeded SessionTable
  // row; whether sdk.session.messages resolves such a row inside the bot's
  // Instance.provide is an SDD-04/runtime concern this harness may not satisfy.
  test("V7b /resume <existing id> validates via SDK then binds the chat", async () => {
    const chat = chatId("V7b")
    const s1 = "ses_bound_" + uid()
    seedSession(chat, { session_id: s1 })
    const s3 = "ses_real_" + uid()
    seedRealSession(s3)

    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)
    const execSpy = spyOn(HarnessCommands, "execute")

    const sendsBefore = harness.sends().length
    harness.injectMessage(chat, "/resume " + s3)
    await harness.waitFor(() => harness.sends().length > sendsBefore)
    await harness.tick(6)

    expect(execSpy.mock.calls.some(([name]) => name === "resume")).toBe(false)
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(s3)
    expect(harness.jobsForChat(chat).length).toBe(0)
    execSpy.mockRestore()
  })

  // V8 — per-chat ordering, no concurrent same-session prompt (req 8, CC-3).
  // "at no point are two executor invocations for chat 600 active simultaneously;
  //  after releasing the gate, A then B run in that order against the same session_id."
  // Per-chat serialization is the SDD-04 worker's; SDD-01 adds no mechanism.
  test("V8 same chat: worker never runs two prompts for the chat concurrently, order preserved", async () => {
    const chat = chatId("V8")
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)

    let active = 0
    let maxActive = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let gated = false
    const order: string[] = []
    harness.setRunner((async ({ prompt, sessionId, onSessionCreated }: any) => {
      active++
      maxActive = Math.max(maxActive, active)
      if (!gated) {
        gated = true
        await gate // hold the first (A) at the gate
      }
      order.push(prompt)
      active--
      if (sessionId) return { sessionId, response: "ok", toolCalls: 0, durationMs: 1 }
      const sid = "ses_" + uid()
      onSessionCreated?.(sid)
      runs.push({ prompt, created: sid })
      return { sessionId: sid, response: "ok", toolCalls: 0, durationMs: 1 }
    }) as any)

    harness.injectMessage(chat, "A")
    harness.injectMessage(chat, "B")
    await harness.waitFor(() => harness.jobsForChat(chat).length === 2)

    // Kick the worker without awaiting; A should enter and block at the gate.
    JobWorkerDrain()
    await harness.waitFor(() => active >= 1)
    await harness.tick()
    // B must NOT be running concurrently with A.
    expect(maxActive).toBe(1)

    release()
    await harness.waitFor(() => harness.jobsForChat(chat).every((j) => j.status === "done"), 12_000)

    // A then B, both against the same (created-then-resumed) session.
    expect(order).toEqual(["A", "B"])
    expect(maxActive).toBe(1)
  })

  // V9 — cross-chat concurrency not blocked (req 9, CC-3).
  // "the worker runs chat 701's job without waiting for chat 700 (up to the cap)."
  test("V9 different chats: a blocked chat does not block an unrelated chat", async () => {
    const chatA = chatId("V9a")
    const chatB = chatId("V9b")
    const runs: RunLog[] = []
    harness = await startHarness([chatA, chatB], runs, { cap: 3 })

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const entered: string[] = []
    harness.setRunner((async ({ prompt, chatId: cid, sessionId, onSessionCreated }: any) => {
      entered.push(cid ?? prompt)
      if (prompt === "blockme") await gate // hold chatA
      if (sessionId) return { sessionId, response: "ok", toolCalls: 0, durationMs: 1 }
      const sid = "ses_" + uid()
      onSessionCreated?.(sid)
      return { sessionId: sid, response: "ok", toolCalls: 0, durationMs: 1 }
    }) as any)

    harness.injectMessage(chatA, "blockme")
    await harness.waitFor(() => harness.jobForChat(chatA) !== undefined)
    JobWorkerDrain()
    await harness.waitFor(() => entered.length >= 1)

    // While chatA is gated, chatB arrives and must complete.
    harness.injectMessage(chatB, "free")
    await harness.waitFor(() => harness.jobForChat(chatB) !== undefined)
    JobWorkerDrain()
    await harness.waitFor(() => harness.jobForChat(chatB)?.status === "done", 12_000)

    expect(harness.jobForChat(chatB)!.status).toBe("done")

    release()
    await harness.waitFor(() => harness.jobForChat(chatA)?.status === "done", 12_000)
  })

  // V10 — no TTL/summary/truncation remains (req 10, CC-10).
  // Static: "grep confirms session_ttl_ms, lastSessionSummary, lastSessionTime, and
  //  the [Previous session context: ...] prefix are gone from bot.ts."
  test("V10 static: legacy TTL/summary symbols removed from bot.ts", async () => {
    const src = await Bun.file(new URL("../../../src/telegram/bot.ts", import.meta.url)).text()
    expect(src).not.toContain("session_ttl_ms")
    expect(src).not.toContain("lastSessionSummary")
    expect(src).not.toContain("lastSessionTime")
    expect(src).not.toContain("Previous session context")
  })

  // V10 behavioral — two messages far apart in time still reuse the same session
  // (continuity from the durable session, not a TTL summary).
  test("V10 behavioral: same session reused across a long inter-message gap (no TTL)", async () => {
    const chat = chatId("V10")
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)

    harness.injectMessage(chat, "A")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    await harness.drain()
    await harness.waitFor(() => harness.jobForChat(chat)?.status === "done")
    const stored = TelegramStore.getByChat(chat)!.session_id!

    // Simulate a long gap well beyond any old 30-minute TTL.
    const realNow = Date.now
    Date.now = () => realNow() + 60 * 60 * 1000
    try {
      harness.injectMessage(chat, "B")
      await harness.waitFor(() => harness.jobsForChat(chat).length === 2)
      expect(harness.jobForChat(chat)!.payload.sessionId).toBe(stored) // still reused
      await harness.drain()
      await harness.waitFor(() => harness.jobsForChat(chat).every((j) => j.status === "done"))
    } finally {
      Date.now = realNow
    }
    expect(runs.filter((r) => r.created).length).toBe(1) // no new session
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(stored)
  })

  // V11 — chat-scoped commands bypass the registry (req 11).
  // "/new and /resume never invoke HarnessCommands.execute, while a genuine
  //  registry command that is NOT chat-scoped (e.g. /peers) still does."
  test("V11 /new and /resume bypass HarnessCommands.execute; /peers reaches it", async () => {
    const chat = chatId("V11")
    seedSession(chat, { session_id: "ses_" + uid() })
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)
    const execSpy = spyOn(HarnessCommands, "execute")

    harness.injectMessage(chat, "/new")
    await harness.waitFor(() => harness.sends().some((c) => String(c.body?.chat_id) === chat))
    await harness.tick()

    const beforeResume = harness.sends().length
    harness.injectMessage(chat, "/resume ses_whatever_" + uid())
    await harness.waitFor(() => harness.sends().length > beforeResume)
    await harness.tick()

    // Chat-scoped session commands never reached the registry.
    expect(execSpy.mock.calls.some(([name]) => name === "new")).toBe(false)
    expect(execSpy.mock.calls.some(([name]) => name === "resume")).toBe(false)

    // A genuine, non-chat-scoped registry command DOES reach execute.
    const beforePeers = harness.sends().length + harness.edits().length
    harness.injectMessage(chat, "/peers")
    await harness.waitFor(
      () => execSpy.mock.calls.some(([name]) => name === "peers") || harness.sends().length + harness.edits().length > beforePeers,
    )
    await harness.tick()
    expect(execSpy.mock.calls.some(([name]) => name === "peers")).toBe(true)

    execSpy.mockRestore()
  })

  // V12 — security choke point untouched (req 12, SEC-1/CC-8).
  // "this feature adds no model resolution of its own ... No test here selects a
  //  model; SDD-02 owns SEC verification. This item guards against regression only."
  // Observable guard: with no model_override set, SDD-01 injects NO model into the
  // job payload (model comes only from model_override, written by SDD-02).
  test("V12 no SDD-01 model resolution: payload.model undefined when no model_override", async () => {
    const chat = chatId("V12")
    const runs: RunLog[] = []
    harness = await startHarness([chat], runs)

    harness.injectMessage(chat, "A")
    await harness.waitFor(() => harness.jobForChat(chat) !== undefined)
    expect(harness.jobForChat(chat)!.payload.model).toBeUndefined()
  })

  // V13 — build/regression green (CC-9). Whole-suite typecheck + `bun test` is a
  // CI-level gate run outside this file; not a unit test in this suite.
  test.todo("V13 bun run typecheck + full bun test green — CI-level gate, not runnable as a single unit test", () => {})
})

// Local, un-awaited worker kick for the gate tests (mirrors harness.drain()'s
// JobWorker.drain() call without settling), so a test can inspect mid-flight.
function JobWorkerDrain(): void {
  JobWorker.drain()
}
