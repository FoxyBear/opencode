import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Queue } from "../../src/queue/queue"
import { TelegramStore } from "../../src/telegram/store"
import { Database } from "../../src/storage/db"
import { JobQueueTable } from "../../src/queue/queue.sql"

// Unique-per-test ids so tests sharing the process-wide db do not collide.
let _seq = 0
function uid(): number {
  return Date.now() * 1000 + _seq++
}
function uchat(): string {
  return "chat-" + uid()
}

describe("Queue migration (V-13)", () => {
  test("the three shared tables exist after boot", () => {
    const rows = Database.use((db) =>
      db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_session','job_queue','telegram_inbox')`,
      ),
    )
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(["job_queue", "telegram_inbox", "telegram_session"])
  })
})

describe("Queue.ingestChatMessage dedup (V-1 / CC-2)", () => {
  test("same update_id enqueues exactly one job", () => {
    const updateId = uid()
    const chat = uchat()
    const first = Queue.ingestChatMessage(updateId, {
      kind: "chat_message",
      payload: { prompt: "hello" },
      chat_id: chat,
    })
    const second = Queue.ingestChatMessage(updateId, {
      kind: "chat_message",
      payload: { prompt: "hello again" },
      chat_id: chat,
    })

    expect(first.enqueued).toBe(true)
    expect(first.jobId).toBeString()
    expect(second.enqueued).toBe(false)
    expect(second.jobId).toBeUndefined()

    const jobs = Database.use((db) =>
      db.select().from(JobQueueTable).where(eq(JobQueueTable.chat_id, chat)).all(),
    )
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.ack_message_id).toBeNull()
    expect(jobs[0]!.status).toBe("pending")
  })
})

describe("Queue.claim atomicity (V-4 / W-10,W-11)", () => {
  test("two claims race, exactly one wins", () => {
    // Clear any pending jobs left by other tests so both claims target only ours.
    Database.use((db) =>
      db
        .update(JobQueueTable)
        .set({ status: "done" })
        .where(eq(JobQueueTable.status, "pending"))
        .run(),
    )

    const chat = uchat()
    const jobId = Queue.enqueue({ kind: "chat_message", payload: { prompt: "x" }, chat_id: chat })

    const a = Queue.claim("worker-a")
    const b = Queue.claim("worker-b")

    // Exactly one claim returned the job; the other returned null (guarded update).
    expect(a?.id).toBe(jobId)
    expect(b).toBeNull()
    expect(a!.status).toBe("claimed")
    expect(a!.claimed_by).toBe("worker-a")
    expect(a!.attempts).toBe(1)
  })
})

describe("Queue.derivePollOffset (V-10 / W-5)", () => {
  test("offset is max(update_id)+1", () => {
    const base = uid()
    Queue.inboxCheckAndInsert(base)
    Queue.inboxCheckAndInsert(base + 1)
    Queue.inboxCheckAndInsert(base + 2)
    const offset = Queue.derivePollOffset()
    // Other tests may have inserted higher ids; assert it is at least max+1.
    expect(offset).toBeDefined()
    expect(offset!).toBeGreaterThanOrEqual(base + 3)
  })
})

describe("Queue.recoverInterrupted (V-6 / W-27)", () => {
  test("re-queues an interrupted job below the attempt cap", () => {
    const chat = uchat()
    const jobId = Queue.enqueue({ kind: "chat_message", payload: { prompt: "y" }, chat_id: chat })
    // Simulate an interrupted claimed/running job (attempts below the cap).
    Database.use((db) =>
      db
        .update(JobQueueTable)
        .set({ status: "running", attempts: 1, claimed_by: "worker-r", claimed_at: new Date() })
        .where(eq(JobQueueTable.id, jobId))
        .run(),
    )

    Queue.recoverInterrupted(2)

    const job = Queue.get(jobId)!
    expect(job.status).toBe("pending")
    expect(job.claimed_by).toBeNull()
    expect(job.claimed_at).toBeNull()
  })

  test("errors an interrupted job at/above the attempt cap", () => {
    const chat = uchat()
    const jobId = Queue.enqueue({ kind: "chat_message", payload: { prompt: "z" }, chat_id: chat })
    // Force attempts to the cap and status running.
    Database.use((db) =>
      db
        .update(JobQueueTable)
        .set({ status: "running", attempts: 2 })
        .where(eq(JobQueueTable.id, jobId))
        .run(),
    )

    Queue.recoverInterrupted(2)

    const job = Queue.get(jobId)!
    expect(job.status).toBe("error")
    expect(job.error).toBe("lost to daemon restart")
  })
})

describe("Queue cancel + terminal guards (V-8 / W-25)", () => {
  test("markDone cannot overwrite a canceled job", () => {
    const chat = uchat()
    const jobId = Queue.enqueue({ kind: "chat_message", payload: { prompt: "c" }, chat_id: chat })
    // Drive this specific job to running without depending on global claim order.
    Database.use((db) =>
      db.update(JobQueueTable).set({ status: "running" }).where(eq(JobQueueTable.id, jobId)).run(),
    )
    Queue.requestCancel(chat)
    Queue.markCanceled(jobId)

    // A late result must not resurrect the job.
    Queue.markDone(jobId, { response: "late", sessionId: "s", toolCalls: 0, durationMs: 1 })

    const job = Queue.get(jobId)!
    expect(job.status).toBe("canceled")
    expect(job.result).toBeNull()
  })
})

describe("TelegramStore session lifecycle (SC-1)", () => {
  test("upsert, setSession, clearSession preserve persona/model", () => {
    const chat = uchat()
    TelegramStore.upsert(chat, { persona: "katya", model_override: "deepseek/deepseek-chat" })
    TelegramStore.setSession(chat, "ses_123")

    let row = TelegramStore.getByChat(chat)!
    expect(row.session_id).toBe("ses_123")
    expect(row.persona).toBe("katya")
    expect(row.model_override).toBe("deepseek/deepseek-chat")
    expect(TelegramStore.getModel(chat)).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })

    // /new nulls the session but preserves persona + model.
    TelegramStore.clearSession(chat)
    row = TelegramStore.getByChat(chat)!
    expect(row.session_id).toBeNull()
    expect(row.persona).toBe("katya")
    expect(row.model_override).toBe("deepseek/deepseek-chat")
  })

  test("getBySession resolves chat for question correlation", () => {
    const chat = uchat()
    TelegramStore.setSession(chat, "ses_" + uid())
    const sid = TelegramStore.getByChat(chat)!.session_id!
    expect(TelegramStore.getBySession(sid)?.chat_id).toBe(chat)
  })
})
