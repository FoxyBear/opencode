import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export interface TaskOutput {
  transcript: boolean
  mesh_target?: string
  notification?: "telegram" | "system"
  file_path?: string
}

export const ScheduledTasksTable = sqliteTable("scheduled_tasks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  prompt: text("prompt").notNull(),
  persona: text("persona").notNull().default("build"),
  category: text("category").notNull().default("user"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  output: text("output", { mode: "json" }).$type<TaskOutput>(),
  last_run: integer("last_run", { mode: "timestamp_ms" }),
  last_status: text("last_status"),
  ...Timestamps,
})

export const SchedulerLogTable = sqliteTable("scheduler_log", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  task_name: text("task_name").notNull(),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completed_at: integer("completed_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("running"),
  error: text("error"),
  session_id: text("session_id"),
  ...Timestamps,
})
