import { sqliteTable, text, integer, index, blob } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const ToolCallPatternsTable = sqliteTable(
  "tool_call_patterns",
  {
    id: text("id").primaryKey(),
    query_hash: text("query_hash").notNull(),
    query_embedding: blob("query_embedding", { mode: "buffer" }),
    tool_sequence: text("tool_sequence", { mode: "json" }).$type<string[]>(),
    frequency: integer("frequency").default(1),
    last_seen: integer("last_seen", { mode: "timestamp_ms" }),
    avg_latency_ms: integer("avg_latency_ms"),
    deterministic: integer("deterministic", { mode: "boolean" }).default(false),
    project_id: text("project_id").notNull().default("global"),
    ...Timestamps,
  },
  (table) => [
    index("tcp_query_hash_idx").on(table.query_hash),
    index("tcp_project_idx").on(table.project_id),
  ],
)
