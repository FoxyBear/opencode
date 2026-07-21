# 04 — Auto-Recall

## Objective

Define the automatic memory recall flow that runs before every LLM call: embedding the query, querying memory layers, merging results, and injecting into the system prompt.

## Prior Art

- `katya-sandbox/app/bot/brain.py:74-89` — Auto-recall: extract user query → recall_fn(query) → inject into system prompt
- OpenCode `session/prompt.ts:1465` — Plugin hook `experimental.chat.system.transform` for system prompt injection
- OpenCode `session/prompt.ts:1467` — System prompt assembly: skills + environment + instructions
- fbcli `spec/05_memory.md` statements MM-01 through MM-08

## Behavior

### Recall Trigger

**WHEN** the harness `loop.before` runs before an LLM call,
the recall service **SHALL** extract the user query from the latest user message.

**WHEN** the latest message is a slash command (starts with `/`),
the recall service **SHALL** skip auto-recall for this iteration.

**WHEN** the recall service has already run for this user message (same turn, tool loop iteration),
it **SHALL** return cached results instead of re-querying.

**WHEN** a new user message arrives (new turn),
the recall cache **SHALL** be invalidated.

### Embedding

**WHEN** the recall service embeds a query,
it **SHALL** use the `EmbeddingService` with Ollama `nomic-embed-text` as primary provider.

**WHEN** the primary embedding provider is unavailable (Ollama not running, model not pulled),
the service **SHALL** fall back to the configured fallback provider (default: DeepInfra BGE-M3).

**WHEN** both embedding providers are unavailable,
the service **SHALL** log an error and skip auto-recall for this turn (graceful degradation).

**WHEN** an embedding is generated,
the service **SHALL** cache it for the duration of the turn (avoid re-embedding the same query during tool loops).

### Layer 2 Query (Local)

**WHEN** the recall service queries Layer 2,
it **SHALL** perform cosine similarity search on the `memory_topics` sqlite-vec table, filtered by the current persona.

**WHEN** Layer 2 returns results,
they **SHALL** be limited to `max_recall_results` (default: 5), ordered by cosine similarity descending.

**WHEN** Layer 2 returns no results,
the service **SHALL** proceed to Layer 4 (if configured) without error.

### Layer 4 Query (Workforce)

**WHEN** workforce memory is configured and `include_workforce` is true,
the recall service **SHALL** query `{workforce.url}/api/v1/recall` with the user query and `user_id = persona`.

**WHEN** the workforce query times out (> 5 seconds),
the service **SHALL** log a warning and proceed with Layer 2 results only.

**WHEN** workforce results are returned,
they **SHALL** be limited to `workforce.max_results` (default: 3).

### Result Merging

**WHEN** results from Layer 2 and Layer 4 are available,
the service **SHALL** merge them into a single list, deduplicated by content similarity (cosine > 0.9).

**WHEN** dedup finds a match between Layer 2 and Layer 4 results,
the service **SHALL** prefer the Layer 2 result (local is more recent and persona-scoped).

**WHEN** merged results are ordered,
they **SHALL** be sorted by relevance score descending, with a source label ("local" or "workforce").

### System Prompt Injection

**WHEN** recall produces results,
the service **SHALL** inject them into the system prompt via the `experimental.chat.system.transform` plugin hook.

**WHEN** memories are injected,
they **SHALL** use this format:

```
## Relevant Memories
1. [2026-04-10, local] Memory content here
2. [2026-04-08, workforce] Another memory
3. [2026-04-01, local] Older memory (memory from 3 days ago — verify before acting)
```

**WHEN** recall produces no results (both layers empty),
the service **SHALL NOT** add a memories section to the system prompt.

## Interface Contract

```typescript
export interface RecallInterface {
  readonly autoRecall: (input: {
    query: string
    persona: string
    sessionID: SessionID
  }) => Effect.Effect<MemoryResult[]>

  readonly formatForInjection: (results: MemoryResult[]) => string

  readonly invalidateCache: () => Effect.Effect<void>
}

// EmbeddingService — separate service
export class EmbeddingService extends ServiceMap.Service<
  EmbeddingService, EmbeddingInterface
>()("@opencode/Embedding") {}

export interface EmbeddingInterface {
  readonly embed: (text: string) => Effect.Effect<Float32Array>
  readonly embedBatch: (texts: string[]) => Effect.Effect<Float32Array[]>
}

export interface EmbeddingConfig {
  provider: "ollama" | "deepinfra" | "openai"
  model: string             // "nomic-embed-text"
  dimensions: number        // 768
  fallback?: {
    provider: string
    model: string
  }
}
```

## Harness Operations (automatic)

- Query embedding before every LLM call (via `loop.before` → auto-recall)
- Result caching within turn (invalidated on new user message)
- System prompt injection via `experimental.chat.system.transform`
- Graceful degradation: embedding failure → skip recall; workforce failure → local only

## LLM-Callable Tools

None. Auto-recall is invisible to the LLM. The LLM can use `memory_recall` (spec 01) for targeted manual searches.

## Verification

```bash
bun test src/memory/__tests__/recall.test.ts

# Auto-recall injects memories
# Test: store memories → new user message → system prompt contains ## Relevant Memories

# No results → no section
# Test: empty memory store → system prompt has no memories section

# Slash command skip
# Test: user input "/help" → no recall triggered

# Turn cache
# Test: same turn, 3 tool loop iterations → embedding called once, recall called once

# Cache invalidation
# Test: new user message → embedding called again

# Embedding fallback
# Test: mock Ollama down → DeepInfra used → results returned

# Both providers down
# Test: mock both down → recall skipped, no error to user

# Workforce timeout
# Test: mock workforce 10s delay → timeout at 5s → Layer 2 results only

# Result merging
# Test: Layer 2 + Layer 4 results with overlap → deduped, sorted by score

# Staleness warning
# Test: memory 5 days old → rendered with staleness note
```

## Boundaries

- Recall does NOT decide what to store (that's spec 03 extraction)
- Recall does NOT manage the memory store (that's spec 01)
- Recall does NOT modify messages (it only injects into system prompt)
- Recall does NOT run during compaction (compaction subagent has no memory access)
