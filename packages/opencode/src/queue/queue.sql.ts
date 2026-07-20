import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export type JobKind = "chat_message" | "subagent"
export type JobStatus = "pending" | "claimed" | "running" | "done" | "error" | "canceled"

export interface JobModel {
  providerID: string
  modelID: string
}

export interface JobPayload {
  prompt: string
  persona?: string
  timeoutMs?: number
  sessionId?: string
  model?: JobModel
}

export interface JobResult {
  response: string
  sessionId: string
  toolCalls: number
  durationMs: number
}

// SDD-04 SC-1: the shared chat/session correlation table. Declared EXACTLY ONCE
// here; SDD-01/02/03 reference it through TelegramStore / Queue and never
// re-declare or ALTER it. All columns nullable so `/new` can null session_id
// while preserving persona and model_override.
export const TelegramSessionTable = sqliteTable(
  "telegram_session",
  {
    chat_id: text("chat_id").primaryKey(),
    session_id: text("session_id"),
    persona: text("persona"),
    model_override: text("model_override"),
    ...Timestamps,
  },
  (table) => [index("telegram_session_session_id_idx").on(table.session_id)],
)

// SDD-04 SC-1: the durable job queue.
export const JobQueueTable = sqliteTable(
  "job_queue",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    payload: text("payload", { mode: "json" }).$type<JobPayload>().notNull(),
    result: text("result", { mode: "json" }).$type<JobResult>(),
    error: text("error"),
    chat_id: text("chat_id").notNull(),
    ack_message_id: integer("ack_message_id"),
    reply_to_message_id: integer("reply_to_message_id"),
    parent_session_id: text("parent_session_id"),
    session_id: text("session_id"),
    claimed_at: integer("claimed_at", { mode: "timestamp_ms" }),
    claimed_by: text("claimed_by"),
    attempts: integer("attempts").notNull().default(0),
    cancel_requested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    progress: text("progress"),
    progress_updated_at: integer("progress_updated_at", { mode: "timestamp_ms" }),
    delivered: integer("delivered", { mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [
    index("job_queue_status_idx").on(table.status),
    index("job_queue_chat_id_idx").on(table.chat_id),
    index("job_queue_session_id_idx").on(table.session_id),
  ],
)

// SDD-04 SC-1: the durable dedup inbox of processed Telegram update_ids.
export const TelegramInboxTable = sqliteTable("telegram_inbox", {
  update_id: integer("update_id").primaryKey(),
  ...Timestamps,
})

export type JobRow = typeof JobQueueTable.$inferSelect
export type TelegramSessionRow = typeof TelegramSessionTable.$inferSelect
