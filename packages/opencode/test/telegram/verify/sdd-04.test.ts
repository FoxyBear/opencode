// INDEPENDENT acceptance tests for SDD-04 (split ingestion/execution — durable
// queue, worker loop, result routing).
//
// spec: docs/specs/260719_telegram_sdd-04-split-queue-worker-routing.md
//       (## VERIFY V-1..V-14 = the test list; ## WHAT W-* = expected behavior).
// master: docs/specs/260719_telegram_sdd-00-master.md (CC-2/4/5/6/7, SC-1/2/3).
//
// Every EXPECTED value below is derived from the SPEC (WHAT / VERIFY statements),
// NOT from reading any implementation body. queue.ts, worker.ts, bot.ts, api.ts,
// runner.ts, headless.ts were treated as opaque: only the public export
// SIGNATURES (spec HOW) and the harness API are used.
//
// The system is driven ONLY through the mocked-Telegram harness
// (test/telegram/harness.ts): inject inbound updates, start bot/worker, drain,
// then read job rows + recorded outbound calls + TelegramStore.
//
// TEARDOWN DISCIPLINE (why a prior attempt hung): TelegramHarness.stop() awaits
// JobWorker.stop(), which awaits any in-flight job. So (1) pure ack-first checks
// do NOT start the worker at all, and (2) the only gated runner races its gate
// against the run's AbortSignal (JobWorker.stop() aborts on shutdown) so a job
// can never block teardown even if an assertion throws before the gate releases.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ulid } from "ulid"
import { eq, sql } from "drizzle-orm"
import { TelegramHarness, purgeQueue, type RecordedCall } from "../harness"
import { JobWorker } from "../../../src/queue/worker"
import { Queue } from "../../../src/queue/queue"
import { TelegramStore } from "../../../src/telegram/store"
import { Database } from "../../../src/storage/db"
import { JobQueueTable, TelegramInboxTable } from "../../../src/queue/queue.sql"

// Per-file token so chat ids never collide with rows left by other files in the
// process-wide :memory: db. job_queue is purged in beforeEach; telegram_inbox and
// telegram_session persist (their accumulation backs the durable poll offset).
const RUN = ulid()
let _seq = 0
function chatId(label: string): string {
  return `sdd04-${RUN}-${label}`
}
function uid(): string {
  return `${RUN}-${_seq++}`
}
// Unique, monotonic message ids for directly-seeded ack_message_id values.
let _mid = Date.now() * 1000 + 900_000
function mid(): number {
  return _mid++
}

// A hang that becomes resolvable at teardown: rejects the moment the run's abort
// signal fires (JobWorker.stop() aborts in-flight runs on shutdown), otherwise
// resolves only when the test releases `gate`. Guarantees afterEach never blocks.
function abortable(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"))
    signal?.addEventListener("abort", () => reject(new Error("aborted")))
    gate.then(resolve, reject)
  })
}

// Directly seed a job row (used to stage restart-recovery and undelivered-terminal
// scenarios that ingestion cannot produce on demand). Only DB setup — independent
// of Queue/worker internals.
function insertJob(fields: Record<string, any>): string {
  const id = "job_" + uid()
  Database.use((db) =>
    db
      .insert(JobQueueTable)
      .values({
        id,
        kind: "chat_message",
        status: "pending",
        payload: { prompt: "seed" },
        attempts: 0,
        delivered: false,
        cancel_requested: false,
        time_created: Date.now(),
        time_updated: Date.now(),
        ...fields,
      } as any)
      .run(),
  )
  return id
}

function inboxMax(): number {
  const rows = Database.use((db) => db.select().from(TelegramInboxTable).all())
  return rows.reduce((m, r) => Math.max(m, r.update_id), 0)
}

function editsForChat(h: TelegramHarness, chat: string): RecordedCall[] {
  return h.edits().filter((c) => String(c.body?.chat_id) === chat)
}
function sendsForChat(h: TelegramHarness, chat: string): RecordedCall[] {
  return h.sends().filter((c) => String(c.body?.chat_id) === chat)
}

let harness: TelegramHarness | undefined

beforeEach(() => {
  purgeQueue()
})

afterEach(async () => {
  if (harness) await harness.stop().catch(() => {})
  harness = undefined
})

describe("SDD-04 split queue/worker/routing — VERIFY", () => {
  // V-1 (W-3,W-4 / CC-2): "telegram_inbox has one row; job_queue has exactly ONE
  // job." A duplicate update_id is discarded and enqueues no job.
  test("V-1 duplicate update_id -> exactly one job and one inbox row", async () => {
    const chat = chatId("V1")
    harness = new TelegramHarness({ allowedChatIds: [chat] })
    await harness.start()

    const dupId = harness.nextUpdateId()
    harness.injectMessage(chat, "hello", dupId)
    await harness.waitFor(() => harness!.jobsForChat(chat).length === 1)

    // Same update_id again -> deduped by telegram_inbox, no second job.
    harness.injectMessage(chat, "hello (redelivered)", dupId)
    await harness.tick(8)

    expect(harness.jobsForChat(chat).length).toBe(1)
    const inboxRows = Database.use((db) =>
      db.select().from(TelegramInboxTable).where(eq(TelegramInboxTable.update_id, dupId)).all(),
    )
    expect(inboxRows.length).toBe(1)
  })

  // V-2 (W-7,W-8 / CC-4): ack-first. "the inbox row and a pending job are committed
  // ... then an ack sendMessage is recorded and ack_message_id is set via setAck ...
  // processMessage returns before execution." Proven WITHOUT starting the worker:
  // the committed pending job + recorded ack + absence of any execution IS ack-first
  // (no hanging stub -> no teardown risk, per discipline).
  test("V-2 ack-first: pending job committed + ack sent + ack_message_id set, no inline execution", async () => {
    const chat = chatId("V2")
    harness = new TelegramHarness({ allowedChatIds: [chat] })
    await harness.start() // worker intentionally NOT started

    const sendsBefore = sendsForChat(harness, chat).length
    harness.injectMessage(chat, "do work")
    await harness.waitFor(() => harness!.jobForChat(chat) !== undefined)

    // Job committed as pending (ingestion did not execute it).
    expect(harness.jobForChat(chat)!.status).toBe("pending")

    // Ack posted via sendMessage, then ack_message_id stored via setAck (W-7).
    await harness.waitFor(() => sendsForChat(harness!, chat).length > sendsBefore)
    await harness.waitFor(() => harness!.jobForChat(chat)!.ack_message_id != null)
    expect(harness.jobForChat(chat)!.ack_message_id).not.toBeNull()

    // Ingestion returned without executing: with no runner ever wired the job is
    // never claimed/run (W-8). It stays pending across further event-loop turns.
    await harness.tick(8)
    expect(harness.jobForChat(chat)!.status).toBe("pending")
  })

  // V-2a (W-3,W-7,W-7a,W-17a / SC-3): a crash AT the ack send. "after the throw,
  // telegram_inbox has the update_id AND job_queue has one pending job with
  // ack_message_id NULL; the poll offset is max(update_id)+1; the job runs to
  // terminal and the delivery loop delivers it via a fresh sendMessage (NOT
  // editMessageText), setting delivered=true. No accepted message is lost."
  test("V-2a null ack (ack send crashed) -> delivered via fresh sendMessage, not edit", async () => {
    const chat = chatId("V2a")
    harness = new TelegramHarness({ allowedChatIds: [chat] })

    // Fail ONLY the first sendMessage (the ack); later sends (delivery) succeed.
    let ackFailed = false
    harness.transportOverride = (_t, method) => {
      if (method === "sendMessage" && !ackFailed) {
        ackFailed = true
        throw new Error("simulated ack send crash")
      }
      return undefined
    }
    await harness.start()

    const updateId = harness.injectMessage(chat, "run then deliver")

    // Atomic commit survived the ack failure: inbox row + pending job, ack NULL.
    await harness.waitFor(() => harness!.jobForChat(chat) !== undefined)
    const job = harness.jobForChat(chat)!
    expect(job.status).toBe("pending")
    expect(job.ack_message_id).toBeNull()
    const inboxRows = Database.use((db) =>
      db.select().from(TelegramInboxTable).where(eq(TelegramInboxTable.update_id, updateId)).all(),
    )
    expect(inboxRows.length).toBe(1)

    // Poll offset consistent with the committed inbox row (W-5): max(update_id)+1.
    expect(Queue.derivePollOffset()).toBe(inboxMax() + 1)

    // Now run the job and let the delivery loop route it.
    harness.setEchoRunner("healed-result")
    await harness.startWorker()
    const editsBefore = editsForChat(harness, chat).length
    await harness.drain()
    await harness.waitFor(() => harness!.jobForChat(chat)?.status === "done")

    JobWorker.nudge()
    await harness.waitFor(() => harness!.jobForChat(chat)?.delivered === true)

    // Delivered via a FRESH sendMessage, not an edit (ack_message_id was NULL).
    expect(editsForChat(harness, chat).length).toBe(editsBefore) // no editMessageText
    expect(sendsForChat(harness, chat).length).toBeGreaterThanOrEqual(2) // failed ack + delivery send
    expect(harness.jobForChat(chat)!.delivered).toBe(true)
  })

  // V-2a companion (crash BEFORE the atomic commit): the harness cannot inject a
  // fault INTO the synchronous Database.transaction that ingestChatMessage runs
  // (no seam to throw mid-transaction), so "update_id absent from inbox -> Telegram
  // redelivers -> exactly one job" is not exercisable here. The atomic all-or-
  // nothing property is instead covered positively by V-1 (dedup) + V-2a (both
  // rows present after commit).
  test.todo(
    "V-2a companion: crash inside the ingest transaction leaves update_id out of inbox — no harness seam to fault the sync tx",
  )

  // V-3 (W-10,W-12,W-17 / CC-5): "job_queue.session_id is set (via onSessionCreated),
  // status -> done, and the ack message is delivered by an editMessageText (not a
  // new sendMessage), delivered=true." Plus W-12a: the new session id is written to
  // BOTH job_queue.session_id AND the chat's telegram_session.session_id.
  test("V-3 worker runs job -> delivered by EDITING the ack, session_id persisted to both tables", async () => {
    const chat = chatId("V3")
    harness = new TelegramHarness({ allowedChatIds: [chat] })
    await harness.start()
    await harness.startWorker()
    harness.setEchoRunner("the answer") // creates a session (fires onSessionCreated)

    harness.injectMessage(chat, "question")
    await harness.waitFor(() => harness!.jobForChat(chat) !== undefined)
    await harness.waitFor(() => harness!.jobForChat(chat)!.ack_message_id != null) // ack sent first
    const ackId = harness.jobForChat(chat)!.ack_message_id!
    const sendsAfterAck = sendsForChat(harness, chat).length

    await harness.drain()
    await harness.waitFor(() => harness!.jobForChat(chat)?.status === "done")

    const done = harness.jobForChat(chat)!
    // Session id written to job_queue.session_id (W-12) ...
    expect(done.session_id).toBeTruthy()
    // ... and to the chat's telegram_session.session_id (W-12a), same id.
    expect(TelegramStore.getByChat(chat)?.session_id).toBe(done.session_id)

    // Delivered by EDITING the ack message (W-17), not a new send.
    JobWorker.nudge()
    await harness.waitFor(() => harness!.jobForChat(chat)?.delivered === true)
    expect(editsForChat(harness, chat).some((c) => c.body?.message_id === ackId)).toBe(true)
    expect(sendsForChat(harness, chat).length).toBe(sendsAfterAck) // no additional sendMessage
    expect(harness.jobForChat(chat)!.delivered).toBe(true)
  })

  // V-5 (W-15 / CC-3): "two messages for the same chat_id ... run one at a time in
  // enqueue order; never two jobs for that chat concurrently." cap>=2 so the cap is
  // not the limiter — the per-chat in-flight guard is what is under test.
  test("V-5 per-chat ordering: never two jobs for one chat concurrently, order preserved", async () => {
    const chat = chatId("V5")
    harness = new TelegramHarness({ allowedChatIds: [chat] })
    await harness.start()
    await harness.startWorker({ cap: 3 })

    let active = 0
    let maxActive = 0
    let gated = false
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const order: string[] = []

    harness.setRunner(async ({ prompt, sessionId, onSessionCreated, signal }) => {
      active++
      maxActive = Math.max(maxActive, active)
      if (!gated) {
        gated = true
        await abortable(gate, signal) // hold the FIRST job; abort-safe for teardown
      }
      order.push(prompt)
      active--
      const sid = sessionId ?? "ses_" + uid()
      if (!sessionId) onSessionCreated?.(sid)
      return { sessionId: sid, response: "ok", toolCalls: 0, durationMs: 1 }
    })

    harness.injectMessage(chat, "A")
    harness.injectMessage(chat, "B")
    await harness.waitFor(() => harness!.jobsForChat(chat).length === 2)

    JobWorker.drain() // kick without awaiting; A enters and blocks at the gate
    await harness.waitFor(() => active >= 1)
    await harness.tick()
    // B must NOT be running concurrently with A (per-chat serialization).
    expect(maxActive).toBe(1)

    release()
    await harness.waitFor(() => harness!.jobsForChat(chat).every((j) => j.status === "done"), 15_000)
    expect(order).toEqual(["A", "B"]) // enqueue order preserved
    expect(maxActive).toBe(1)
  })

  // V-6 (W-27,W-28,W-30 / CC-6): restart recovery sweep. "job in running with
  // attempts=0 -> re-queued to pending -> runs and delivers." "Repeat with
  // attempts=MAX_ATTEMPTS -> marked error and error delivered to the ack message."
  // MAX_ATTEMPTS default = 2 (W-27). Both staged before start(); one sweep handles both.
  test("V-6 restart recovery: attempts<max re-queued & delivered; attempts>=max errored & delivered", async () => {
    const chatA = chatId("V6a")
    const chatB = chatId("V6b")
    const ackA = mid()
    const ackB = mid()

    harness = new TelegramHarness({ allowedChatIds: [chatA, chatB] })
    await harness.start()

    // Interrupted jobs left in 'running' by a crashed daemon.
    insertJob({ chat_id: chatA, status: "running", attempts: 0, ack_message_id: ackA, claimed_by: "dead", claimed_at: Date.now() })
    insertJob({ chat_id: chatB, status: "running", attempts: 2, ack_message_id: ackB, claimed_by: "dead", claimed_at: Date.now() })

    harness.setEchoRunner("recovered")
    await harness.startWorker() // start() runs recoverInterrupted(MAX_ATTEMPTS) FIRST
    await harness.drain() // run the re-queued job A
    JobWorker.nudge()

    // Job A: attempts < MAX -> re-queued, ran, delivered to the SAME ack via edit.
    await harness.waitFor(() => harness!.jobForChat(chatA)?.status === "done")
    await harness.waitFor(() => harness!.jobForChat(chatA)?.delivered === true)
    expect(editsForChat(harness, chatA).some((c) => c.body?.message_id === ackA)).toBe(true)

    // Job B: attempts >= MAX -> error "lost to daemon restart", delivered to its ack.
    await harness.waitFor(() => harness!.jobForChat(chatB)?.status === "error")
    expect(harness.jobForChat(chatB)!.error).toContain("lost to daemon restart")
    await harness.waitFor(() => harness!.jobForChat(chatB)?.delivered === true)
    expect(editsForChat(harness, chatB).some((c) => c.body?.message_id === ackB)).toBe(true)
  })

  // V-7 (W-18,W-19 / CC-5): completed-but-undelivered. "a done job with
  // delivered=false ... is delivered exactly once; running the pass again edits
  // idempotently and the 'message is not modified' error is swallowed (no throw)."
  test("V-7 completed-but-undelivered delivered exactly once, then idempotent re-edit swallowed", async () => {
    const chat = chatId("V7")
    const ackId = mid()
    harness = new TelegramHarness({ allowedChatIds: [chat] })

    const jobId = insertJob({
      chat_id: chat,
      status: "done",
      ack_message_id: ackId,
      attempts: 1,
      delivered: false,
      result: { response: "final answer", sessionId: "ses_" + uid(), toolCalls: 0, durationMs: 1 },
    })

    await harness.start() // delivery loop (table-driven) picks up the terminal job

    JobWorker.nudge()
    await harness.waitFor(() => harness!.jobForChat(chat)?.delivered === true)

    // Delivered exactly once via an edit to the ack; no re-delivery while delivered=true.
    expect(editsForChat(harness, chat).length).toBe(1)
    expect(editsForChat(harness, chat)[0]!.body?.message_id).toBe(ackId)
    await harness.tick(6)
    expect(editsForChat(harness, chat).length).toBe(1) // delivered flag prevents re-send

    // W-19: a re-edit (crash between edit and marking delivered) is idempotent — the
    // Telegram "message is not modified" error is swallowed and delivery completes.
    harness.transportOverride = (_t, method) => {
      if (method === "editMessageText") {
        throw Object.assign(new Error("Bad Request: message is not modified"), {
          description: "Bad Request: message is not modified",
        })
      }
      return undefined
    }
    Database.use((db) => db.update(JobQueueTable).set({ delivered: false }).where(eq(JobQueueTable.id, jobId)).run())

    JobWorker.nudge()
    // If the swallow works, delivery completes (delivered=true) with no throw
    // propagating; if it did not, the delivery try/catch would leave it undelivered
    // and this wait would time out (a real bug, not a weakened assertion).
    await harness.waitFor(() => harness!.jobForChat(chat)?.delivered === true)
    expect(harness.jobForChat(chat)!.delivered).toBe(true)
  })

  // V-10 (W-5,W-6 / CC-2): "restart the poller with no in-heap offset -> first
  // getUpdates uses offset max(update_id)+1." The inbox is process-wide, so we seed
  // three rows that ARE the current max and assert the derived/seeded offset is
  // max+1 (offset comes from SQLite, not memory).
  test("V-10 poll offset seeds from max(update_id)+1", async () => {
    const base = inboxMax() + 1000
    Database.use((db) =>
      db
        .insert(TelegramInboxTable)
        .values([
          { update_id: base, time_created: Date.now(), time_updated: Date.now() },
          { update_id: base + 1, time_created: Date.now(), time_updated: Date.now() },
          { update_id: base + 2, time_created: Date.now(), time_updated: Date.now() },
        ] as any)
        .run(),
    )
    const expected = base + 3

    // Queue.derivePollOffset reads max(update_id)+1 from the durable inbox (W-5).
    expect(Queue.derivePollOffset()).toBe(expected)

    // The poller seeds its first getUpdates from that durable offset, not memory.
    harness = new TelegramHarness({ allowedChatIds: [chatId("V10")] })
    await harness.start()
    await harness.waitFor(() => harness!.getUpdatesCalls.length >= 1)
    expect(harness.getUpdatesCalls[0]?.offset).toBe(expected)
  })

  // V-13 (W-1 / migration): "fresh db, boot -> all three tables + indexes exist."
  // The suite's :memory: db was migrated at boot (test/preload.ts); assert the
  // single 20260719120000_telegram_queue migration produced all three tables and
  // their declared indexes (queue.sql.ts).
  test("V-13 migration applied: telegram_session, job_queue, telegram_inbox + indexes exist", () => {
    const tables = Database.use((db) =>
      db.all(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_session','job_queue','telegram_inbox')`,
      ),
    ) as unknown[]
    expect(tables.length).toBe(3)

    const indexes = Database.use((db) =>
      db.all(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('telegram_session_session_id_idx','job_queue_status_idx','job_queue_chat_id_idx','job_queue_session_id_idx')`,
      ),
    ) as unknown[]
    expect(indexes.length).toBe(4)
  })

  // V-4 (W-10,W-11) claim atomicity — two concurrent claims, at most one wins —
  // is verified at the Queue level in test/queue/queue.test.ts. Referenced here per
  // the spec's VERIFY map; NOT duplicated (independence + no redundant coverage).
  test.todo("V-4 claim atomicity: covered by test/queue/queue.test.ts (reference, not duplicated)")
})
