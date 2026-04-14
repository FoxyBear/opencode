# 01 — Persistent Memory

## Objective

Define cross-session memory storage and retrieval across four layers: index (always loaded), topic memories (semantic retrieval), session transcripts (grep-only), and workforce memory (institutional knowledge).

## Prior Art

- Claude Code v2.1.88: MEMORY.md index (~200 lines, 25KB cap), topic files (filename-matching retrieval), session JSONL transcripts
- `katya-sandbox/app/bot/brain.py:74-89` — Auto-recall injection pattern
- `katya-sandbox/app/tools/mem0.py:39-102` — mem0 recall/remember factories
- `mem0-workforce/` — FastAPI service, ChromaDB + Neo4j, 301 tests
- OpenCode `session/session.sql.ts:14-103` — Existing Drizzle schema (5 tables)
- fbcli `spec/05_memory.md` statements MM-01 through MM-10

## Behavior

### Layer 1: Memory Index

**WHEN** a session starts,
the harness **SHALL** load the memory index from `memory_index` table and render it as markdown in the system prompt.

**WHEN** the memory index exceeds 200 entries,
the harness **SHALL** reject new index entries and log a warning (consolidation must prune first).

**WHEN** an index entry is rendered for the system prompt,
it **SHALL** use the format: `- [{key}]({pointer}): {summary}` — one line per entry, under 150 characters.

**WHEN** the memory index is empty,
the harness **SHALL NOT** add a memory index section to the system prompt.

### Layer 2: Topic Memories

**WHEN** a topic memory is stored,
the service **SHALL** generate an embedding via `EmbeddingService` and store the content, embedding, persona, scope, and metadata in the `memory_topics` table.

**WHEN** a topic memory is stored and an existing memory has cosine similarity > `dedup_threshold` (default: 0.95),
the service **SHALL** update the existing memory instead of inserting a new row.

**WHEN** a topic memory is updated (dedup match),
the service **SHALL** merge the new content with the existing content, update `accessed_at`, and increment `access_count`.

**WHEN** topic memories are queried,
the service **SHALL** return the top N results by cosine similarity against the query embedding, filtered by persona scope.

**WHEN** a topic memory is accessed (returned in a query result),
the service **SHALL** update `accessed_at` to the current timestamp and increment `access_count`.

**WHEN** a topic memory's `accessed_at` is older than `ttl_days` (default: 90),
the memory **SHALL** be eligible for pruning by the consolidation service (spec 03).

### Layer 3: Session Transcripts

**WHEN** transcript data is needed for consolidation or grep,
the service **SHALL** query the existing `MessageTable` in OpenCode's SQLite — no separate storage.

**WHEN** full transcript content is requested,
the service **SHALL** return only message content matching grep criteria (never load full transcript into context).

### Layer 4: Workforce Memory

**WHEN** workforce memory is configured (`memory.workforce.url` in config),
the service **SHALL** query the workforce HTTP endpoint during auto-recall.

**WHEN** the workforce service is unavailable (connection error, timeout > 5s),
the service **SHALL** log a warning and proceed without workforce results (graceful degradation).

**WHEN** workforce results are returned,
the service **SHALL** merge them with Layer 2 results, deduplicated by content similarity (cosine > 0.9).

**WHEN** workforce memory is not configured,
the service **SHALL** skip Layer 4 queries entirely (no errors, no warnings).

### Storage Operations

**WHEN** `store(content, persona, metadata)` is called,
the service **SHALL** embed the content, check for duplicates, and insert or update accordingly.

**WHEN** `forget(memoryId)` is called,
the service **SHALL** delete the memory from `memory_topics` and remove any corresponding index entry.

**WHEN** `list(persona, limit)` is called,
the service **SHALL** return memories ordered by `accessed_at` descending, filtered by persona.

## Interface Contract

```typescript
// New Effect service following OpenCode conventions
export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Memory") {}

export interface Interface {
  readonly store: (input: {
    content: string
    persona: string
    scope?: string
    metadata?: Record<string, unknown>
  }) => Effect.Effect<MemoryEntry>

  readonly recall: (input: {
    query: string
    persona: string
    limit?: number           // default: 5
    include_workforce?: boolean  // default: true
  }) => Effect.Effect<MemoryResult[]>

  readonly forget: (input: { id: string }) => Effect.Effect<void>

  readonly list: (input: {
    persona: string
    limit?: number           // default: 20
  }) => Effect.Effect<MemoryEntry[]>

  readonly index: (input: {
    persona?: string
  }) => Effect.Effect<IndexEntry[]>
}

export interface MemoryEntry {
  id: string
  content: string
  persona: string
  scope: string
  access_count: number
  created_at: string
  accessed_at: string
  metadata: Record<string, unknown>
}

export interface MemoryResult extends MemoryEntry {
  score: number              // cosine similarity
  source: "local" | "workforce"
}

export interface IndexEntry {
  id: string
  key: string
  pointer: string
  summary: string
  created_at: string
  updated_at: string
}
```

## Drizzle Schema

```typescript
// memory.sql.ts — new file
export const MemoryIndexTable = sqliteTable("memory_index", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  pointer: text("pointer").notNull(),
  summary: text("summary").notNull(),
  ...Timestamps,
})

export const MemoryTopicsTable = sqliteTable("memory_topics", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  embedding: blob("embedding").notNull(),    // 768-dim float32
  persona: text("persona").notNull(),
  scope: text("scope").default("general"),
  access_count: integer("access_count").default(0),
  metadata: text("metadata", { mode: "json" }),
  time_accessed: integer("time_accessed", { mode: "timestamp_ms" }),
  ...Timestamps,
})

// vec0 virtual table for KNN search
// CREATE VIRTUAL TABLE memory_vec USING vec0(
//   embedding float[768],
//   +topic_id text
// )
```

## Harness Operations (automatic)

- Layer 1 index loaded at session start (via `experimental.chat.system.transform`)
- Layer 2 queried during auto-recall (spec 04)
- Layer 4 queried during auto-recall if configured
- Storage triggered by per-turn extraction (spec 03)
- Dedup check on every store

## LLM-Callable Tools

| Tool | Input | Returns |
|------|-------|---------|
| `memory_remember` | `{ content: string }` | `"Stored: {content}"` or error |
| `memory_recall` | `{ query: string, limit?: number }` | Formatted memory list |
| `memory_forget` | `{ id: string }` | `"Forgotten: {id}"` or error |

## Verification

```bash
bun test src/memory/__tests__/persistent.test.ts

# Layer 1: index loaded at session start
# Test: store index entries → start session → system prompt contains index

# Layer 2: semantic storage and retrieval
# Test: store 3 memories → recall with query → results ranked by similarity

# Layer 2: dedup on store
# Test: store "X is true" → store "X is true" again → only 1 entry, access_count=2

# Layer 3: transcript grep
# Test: create messages → grep transcripts → returns matching content only

# Layer 4: workforce graceful degradation
# Test: mock workforce 500 → recall still returns Layer 2 results

# Layer 4: workforce merge
# Test: mock workforce results + Layer 2 results → merged, deduped
```

## Boundaries

- Memory does NOT manage compaction (that's spec 02)
- Memory does NOT run consolidation (that's spec 03)
- Memory does NOT decide when to recall (that's spec 04 / 07)
- Memory does NOT manage embeddings lifecycle (that's EmbeddingService)
- Layer 4 writes are NEVER automatic — only Summit curation writes to workforce
