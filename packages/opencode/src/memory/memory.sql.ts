import { sqliteTable, text, integer, index, blob, real } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const MemoryIndexTable = sqliteTable(
  "memory_index",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    pointer: text("pointer").notNull(),
    summary: text("summary").notNull(),
    access_count: integer("access_count").default(0),
    project_id: text("project_id").notNull().default("global"),
    ...Timestamps,
  },
  (table) => [
    index("memory_index_key_idx").on(table.key),
    index("memory_index_project_idx").on(table.project_id),
  ],
)

export const MemoryTopicsTable = sqliteTable(
  "memory_topics",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    embedding: blob("embedding", { mode: "buffer" }).notNull(), // 768-dim float32
    persona: text("persona").notNull(),
    scope: text("scope").default("general"),
    access_count: integer("access_count").default(0),
    project_id: text("project_id").notNull().default("global"),
    metadata: text("metadata", { mode: "json" }),
    time_accessed: integer("time_accessed", { mode: "timestamp_ms" }),
    ...Timestamps,
  },
  (table) => [
    index("memory_topics_persona_idx").on(table.persona),
    index("memory_topics_scope_idx").on(table.scope),
    index("memory_topics_project_idx").on(table.project_id),
  ],
)

// Graph entity nodes (project + global memory tiers)
export const GraphEntityTable = sqliteTable(
  "graph_entity",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull().default("global"),
    name: text("name").notNull(),
    entity_type: text("entity_type").notNull(), // concept | tool | pattern | person | decision | constraint
    content: text("content").notNull(),
    embedding: blob("embedding", { mode: "buffer" }),
    metadata: text("metadata", { mode: "json" }),
    valid_from: integer("valid_from").notNull(),
    invalid_from: integer("invalid_from"),
    ...Timestamps,
  },
  (table) => [
    index("graph_entity_project_idx").on(table.project_id),
    index("graph_entity_type_idx").on(table.entity_type),
    index("graph_entity_name_idx").on(table.name),
  ],
)

// Graph edges — bi-temporal, never deleted
export const GraphEdgeTable = sqliteTable(
  "graph_edge",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull().default("global"),
    source_id: text("source_id").notNull(),
    target_id: text("target_id").notNull(),
    edge_type: text("edge_type").notNull(), // RELATES_TO | DEPENDS_ON | SUPERSEDES | CONTRADICTS | PART_OF | USED_WITH
    weight: real("weight").default(1.0),
    valid_from: integer("valid_from").notNull(),
    invalid_from: integer("invalid_from"),
    source_project: text("source_project"), // provenance for global tier
    metadata: text("metadata", { mode: "json" }),
    ...Timestamps,
  },
  (table) => [
    index("graph_edge_source_idx").on(table.source_id),
    index("graph_edge_target_idx").on(table.target_id),
    index("graph_edge_project_idx").on(table.project_id),
    index("graph_edge_type_idx").on(table.edge_type),
    index("graph_edge_valid_idx").on(table.valid_from, table.invalid_from),
  ],
)
