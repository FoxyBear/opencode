import { ulid } from "ulid"
import { and, asc, eq, inArray, max, notInArray } from "drizzle-orm"
import { Database } from "../storage/db"
import {
  JobQueueTable,
  TelegramInboxTable,
  TelegramSessionTable,
  type JobKind,
  type JobPayload,
  type JobResult,
  type JobRow,
} from "./queue.sql"

const TERMINAL: string[] = ["done", "error", "canceled"]
const NON_TERMINAL: string[] = ["pending", "claimed", "running"]

export interface EnqueueInput {
  kind: JobKind
  payload: JobPayload
  chat_id: string
  reply_to_message_id?: number
  parent_session_id?: string
  ack_message_id?: number
}

// SDD-04: pure data-access over the shared queue/inbox tables. Multi-statement
// mutations use Database.transaction (bun-sqlite transactions are SYNCHRONOUS —
// no `await` inside the callback); single reads use Database.use.
export namespace Queue {
  export type Job = JobRow

  /**
   * Dedup-only check-and-insert for updates that do NOT enqueue a job (e.g.
   * callback queries). Returns true when the update_id was newly recorded.
   */
  export function inboxCheckAndInsert(updateId: number): boolean {
    return Database.transaction(
      (db) => {
        const existing = db
          .select({ id: TelegramInboxTable.update_id })
          .from(TelegramInboxTable)
          .where(eq(TelegramInboxTable.update_id, updateId))
          .get()
        if (existing) return false
        db.insert(TelegramInboxTable).values({ update_id: updateId }).run()
        return true
      },
      { behavior: "immediate" },
    )
  }

  /**
   * SC-3 atomic ingestion primitive: the inbox check-and-insert AND the job
   * insert commit together inside ONE immediate transaction, so a crash can
   * never leave an update recorded without its job (or a job without its
   * inbox record). `ack_message_id` is left NULL; ingestion sets it after the
   * post-commit ack send.
   */
  export function ingestChatMessage(updateId: number, input: EnqueueInput): { enqueued: boolean; jobId?: string } {
    return Database.transaction(
      (db) => {
        const existing = db
          .select({ id: TelegramInboxTable.update_id })
          .from(TelegramInboxTable)
          .where(eq(TelegramInboxTable.update_id, updateId))
          .get()
        if (existing) return { enqueued: false }

        db.insert(TelegramInboxTable).values({ update_id: updateId }).run()

        const jobId = ulid()
        db.insert(JobQueueTable)
          .values({
            id: jobId,
            kind: input.kind,
            status: "pending",
            payload: input.payload,
            chat_id: input.chat_id,
            ack_message_id: input.ack_message_id ?? null,
            reply_to_message_id: input.reply_to_message_id ?? null,
            parent_session_id: input.parent_session_id ?? null,
          })
          .run()

        return { enqueued: true, jobId }
      },
      { behavior: "immediate" },
    )
  }

  /** Insert a pending job (used for `subagent` jobs). */
  export function enqueue(input: EnqueueInput): string {
    const jobId = ulid()
    Database.use((db) => {
      db.insert(JobQueueTable)
        .values({
          id: jobId,
          kind: input.kind,
          status: "pending",
          payload: input.payload,
          chat_id: input.chat_id,
          ack_message_id: input.ack_message_id ?? null,
          reply_to_message_id: input.reply_to_message_id ?? null,
          parent_session_id: input.parent_session_id ?? null,
        })
        .run()
    })
    return jobId
  }

  export function setAck(id: string, ackMessageId: number): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ ack_message_id: ackMessageId, time_updated: Date.now() })
        .where(eq(JobQueueTable.id, id))
        .run()
    })
  }

  /**
   * Atomically claim the oldest pending job not already in-flight for its chat.
   * The guarded update (`WHERE id=? AND status='pending'`) means at most one
   * worker wins a race; the loser gets null.
   */
  export function claim(workerId: string, inFlightChatIds: string[] = []): Job | null {
    return Database.transaction(
      (db) => {
        const conditions = [eq(JobQueueTable.status, "pending")]
        if (inFlightChatIds.length > 0) conditions.push(notInArray(JobQueueTable.chat_id, inFlightChatIds))
        const candidate = db
          .select()
          .from(JobQueueTable)
          .where(and(...conditions))
          .orderBy(asc(JobQueueTable.time_created))
          .limit(1)
          .get()
        if (!candidate) return null

        db.update(JobQueueTable)
          .set({
            status: "claimed",
            claimed_at: new Date(),
            claimed_by: workerId,
            attempts: candidate.attempts + 1,
            time_updated: Date.now(),
          })
          .where(and(eq(JobQueueTable.id, candidate.id), eq(JobQueueTable.status, "pending")))
          .run()

        const updated = db.select().from(JobQueueTable).where(eq(JobQueueTable.id, candidate.id)).get()
        if (updated && updated.status === "claimed" && updated.claimed_by === workerId) return updated
        return null
      },
      { behavior: "immediate" },
    )
  }

  export function markRunning(id: string): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ status: "running", time_updated: Date.now() })
        .where(and(eq(JobQueueTable.id, id), eq(JobQueueTable.status, "claimed")))
        .run()
    })
  }

  // markDone/markError are guarded to `running` so a late result cannot
  // overwrite a job the delivery loop already reported as canceled (W-25).
  export function markDone(id: string, result: JobResult): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ status: "done", result, time_updated: Date.now() })
        .where(and(eq(JobQueueTable.id, id), eq(JobQueueTable.status, "running")))
        .run()
    })
  }

  export function markError(id: string, error: string): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ status: "error", error, time_updated: Date.now() })
        .where(and(eq(JobQueueTable.id, id), eq(JobQueueTable.status, "running")))
        .run()
    })
  }

  export function markCanceled(id: string): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ status: "canceled", time_updated: Date.now() })
        .where(and(eq(JobQueueTable.id, id), inArray(JobQueueTable.status, ["claimed", "running"])))
        .run()
    })
  }

  /** Flag the chat's non-terminal jobs for cancellation (`/stop`). */
  export function requestCancel(chatId: string): number {
    return Database.use((db) => {
      const targets = db
        .select({ id: JobQueueTable.id })
        .from(JobQueueTable)
        .where(and(eq(JobQueueTable.chat_id, chatId), inArray(JobQueueTable.status, NON_TERMINAL)))
        .all()
      if (targets.length === 0) return 0
      db.update(JobQueueTable)
        .set({ cancel_requested: true, time_updated: Date.now() })
        .where(and(eq(JobQueueTable.chat_id, chatId), inArray(JobQueueTable.status, NON_TERMINAL)))
        .run()
      return targets.length
    })
  }

  export function isCancelRequested(id: string): boolean {
    const row = Database.use((db) =>
      db.select({ c: JobQueueTable.cancel_requested }).from(JobQueueTable).where(eq(JobQueueTable.id, id)).get(),
    )
    return row?.c === true
  }

  /** Write the session id resolved for this job (called from onSessionCreated). */
  export function setSession(id: string, sessionId: string): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ session_id: sessionId, time_updated: Date.now() })
        .where(eq(JobQueueTable.id, id))
        .run()
    })
  }

  export function setProgress(id: string, text: string): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ progress: text, progress_updated_at: new Date(), time_updated: Date.now() })
        .where(eq(JobQueueTable.id, id))
        .run()
    })
  }

  export function markDelivered(id: string): void {
    Database.use((db) => {
      db.update(JobQueueTable)
        .set({ delivered: true, time_updated: Date.now() })
        .where(eq(JobQueueTable.id, id))
        .run()
    })
  }

  export function get(id: string): Job | undefined {
    return Database.use((db) => db.select().from(JobQueueTable).where(eq(JobQueueTable.id, id)).get())
  }

  /** Durable poll offset: max(update_id)+1, or undefined when the inbox is empty (W-5). */
  export function derivePollOffset(): number | undefined {
    const row = Database.use((db) =>
      db.select({ m: max(TelegramInboxTable.update_id) }).from(TelegramInboxTable).get(),
    )
    const m = row?.m
    return typeof m === "number" ? m + 1 : undefined
  }

  /** Terminal, undelivered jobs — the delivery loop's source (CC-5). */
  export function pendingDelivery(): Job[] {
    return Database.use((db) =>
      db
        .select()
        .from(JobQueueTable)
        .where(and(inArray(JobQueueTable.status, TERMINAL), eq(JobQueueTable.delivered, false)))
        .orderBy(asc(JobQueueTable.time_created))
        .all(),
    )
  }

  /**
   * Non-terminal, undelivered jobs that have progress text and a live ack
   * message to edit — the delivery loop's debounced progress source (W-22).
   */
  export function runningWithProgress(): Job[] {
    return Database.use((db) =>
      db
        .select()
        .from(JobQueueTable)
        .where(and(inArray(JobQueueTable.status, ["claimed", "running"]), eq(JobQueueTable.delivered, false)))
        .orderBy(asc(JobQueueTable.time_created))
        .all(),
    ).filter((job) => job.progress != null && job.ack_message_id != null)
  }

  /**
   * CC-6 best-effort restart sweep (W-27..W-30). Re-queue interrupted jobs
   * below the attempt cap; mark the rest error. Orphaned subagent jobs (parent
   * session gone) are marked error regardless of attempts (W-29).
   */
  export function recoverInterrupted(maxAttempts: number): void {
    Database.transaction(
      (db) => {
        const stuck = db.select().from(JobQueueTable).where(inArray(JobQueueTable.status, ["claimed", "running"])).all()
        for (const job of stuck) {
          if (job.kind === "subagent" && job.parent_session_id && !parentSessionExists(db, job.parent_session_id)) {
            db.update(JobQueueTable)
              .set({ status: "error", error: "parent session no longer exists", time_updated: Date.now() })
              .where(eq(JobQueueTable.id, job.id))
              .run()
            continue
          }
          if (job.attempts < maxAttempts) {
            db.update(JobQueueTable)
              .set({ status: "pending", claimed_at: null, claimed_by: null, time_updated: Date.now() })
              .where(eq(JobQueueTable.id, job.id))
              .run()
          } else {
            db.update(JobQueueTable)
              .set({ status: "error", error: "lost to daemon restart", time_updated: Date.now() })
              .where(eq(JobQueueTable.id, job.id))
              .run()
          }
        }
      },
      { behavior: "immediate" },
    )
  }

  function parentSessionExists(db: Database.TxOrDb, sessionId: string): boolean {
    const inChat = db
      .select({ id: TelegramSessionTable.chat_id })
      .from(TelegramSessionTable)
      .where(eq(TelegramSessionTable.session_id, sessionId))
      .get()
    if (inChat) return true
    const inJob = db
      .select({ id: JobQueueTable.id })
      .from(JobQueueTable)
      .where(eq(JobQueueTable.session_id, sessionId))
      .get()
    return !!inJob
  }
}
