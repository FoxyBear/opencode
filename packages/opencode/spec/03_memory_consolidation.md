# 03 — Memory Consolidation

## Objective

Define the autoDream background consolidation process and per-turn memory extraction. Consolidation merges, prunes, and maintains the memory index. Extraction captures durable facts from each conversation turn.

## Prior Art

- Claude Code v2.1.88: `autoDream` — 4-phase consolidation (orient, gather, consolidate, prune), gated by 24h + 5 sessions + PID lock. `extractMemories()` — forked subagent after each turn.
- `mem0-workforce/app/services/memory_service.py` — mem0 `recall/remember` interface, graceful degradation
- fbcli `spec/05_memory.md` statements MM-09, MM-10

## Behavior

### Per-Turn Memory Extraction

**WHEN** a conversation turn completes (assistant response with no pending tool calls),
the harness **SHALL** spawn a forked subagent to analyze the turn for durable facts.

**WHEN** the extraction subagent runs,
it **SHALL** have restricted tool access: only `memory_store` and `memory_recall` — no file system, no shell.

**WHEN** the extraction subagent identifies a durable fact (decision, preference, correction, pattern, learned constraint),
it **SHALL** call `Memory.store()` with the fact, current persona, and metadata including `source: "extraction"`.

**WHEN** a slash command turn completes (input started with `/`),
the harness **SHALL** skip extraction (commands rarely contain durable facts).

**WHEN** extraction fails (subagent error, timeout > 10s),
the harness **SHALL** log the error and continue — extraction is best-effort, never blocks the user.

**WHEN** the `auto_capture` config is `false`,
the harness **SHALL** skip per-turn extraction entirely.

### autoDream Consolidation

**WHEN** the three consolidation gates are ALL met:
1. >= `min_hours_between` (default: 24) hours since last consolidation
2. >= `min_sessions_between` (default: 5) sessions completed since last consolidation
3. No concurrent consolidation (PID-based lock file `.consolidate-lock`)

the scheduler (spec 05) **SHALL** trigger autoDream.

**WHEN** autoDream runs, it **SHALL** execute four phases in order:

#### Phase 1: Orient

**WHEN** orient runs,
the subagent **SHALL** read the memory index and skim topic memories to build a deduplication map.

#### Phase 2: Gather

**WHEN** gather runs,
the subagent **SHALL** identify new signal from recent sessions by grepping transcripts (MessageTable) with narrow search terms derived from recent user messages.

**WHEN** gather finds new information not covered by existing memories,
the subagent **SHALL** collect it as candidate memories for consolidation.

#### Phase 3: Consolidate

**WHEN** consolidate runs,
the subagent **SHALL**:
- Merge new signal into existing topic memories where cosine similarity > 0.9
- Convert relative dates to absolute dates (e.g., "yesterday" → "2026-04-13")
- Delete contradicted facts (newer information supersedes older)
- Create new topic memories for genuinely novel information

#### Phase 4: Prune & Index

**WHEN** prune runs,
the subagent **SHALL**:
- Remove topic memories where `accessed_at` is older than `ttl_days` (default: 90) AND `access_count` < 3
- Merge near-duplicate memories (cosine > 0.95) — keep the more recently accessed one
- Update the memory index: add pointers for high-value memories, remove pointers for deleted/merged memories
- Enforce the 200-entry cap on the memory index (drop lowest `access_count` entries)

### Consolidation Lock

**WHEN** autoDream starts,
it **SHALL** create a lock file `.consolidate-lock` containing the process PID and start timestamp.

**WHEN** a lock file exists and the PID is still alive AND the lock is less than 1 hour old,
autoDream **SHALL NOT** start (concurrent consolidation prevented).

**WHEN** a lock file exists but the PID is dead OR the lock is older than 1 hour,
autoDream **SHALL** treat the lock as stale, remove it, and proceed.

**WHEN** autoDream completes (success or failure),
it **SHALL** remove the lock file.

### Memory Staleness

**WHEN** a memory is older than 1 day,
the harness **SHALL** append a staleness warning when rendering it: `"(memory from {N} days ago — verify before acting)"`.

**WHEN** a memory is older than 7 days and has `access_count` < 2,
the harness **SHALL** reduce its ranking score by 50% in recall results.

## Interface Contract

```typescript
export interface ConsolidationInterface {
  readonly shouldRun: () => Effect.Effect<boolean>
  readonly run: () => Effect.Effect<ConsolidationResult>
  readonly extractTurn: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
    persona: string
  }) => Effect.Effect<void>
}

export interface ConsolidationResult {
  merged: number
  pruned: number
  created: number
  indexUpdated: number
  durationMs: number
}

export interface ConsolidationConfig {
  min_hours_between: number    // 24
  min_sessions_between: number // 5
  ttl_days: number             // 90
  dedup_threshold: number      // 0.95
  stale_warning_days: number   // 1
  stale_penalty_days: number   // 7
}
```

## Harness Operations (automatic)

- Per-turn extraction: triggered by harness after each completed turn (via `tool.execute.after` or post-response hook)
- autoDream: triggered by scheduler (spec 05) when gate conditions met
- Lock management: automatic PID-based lock with staleness detection

## LLM-Callable Tools

None. Consolidation is a background process. Per-turn extraction is a harness operation.

## Verification

```bash
bun test src/memory/__tests__/consolidation.test.ts

# Per-turn extraction
# Test: complete a turn with "I prefer TypeScript over Python" → memory stored with persona scope

# Extraction skip on slash commands
# Test: turn with "/help" → no extraction triggered

# Extraction timeout
# Test: mock slow extraction (15s) → timeout at 10s, no error to user

# autoDream gate: all three conditions
# Test: 24h + 5 sessions + no lock → shouldRun() returns true

# autoDream gate: missing condition
# Test: 12h + 5 sessions → shouldRun() returns false

# autoDream lock
# Test: lock exists with live PID → shouldRun() returns false
# Test: lock exists with dead PID → lock removed, shouldRun() returns true

# Consolidation: merge duplicates
# Test: 2 memories with cosine > 0.95 → merged into 1, access_count summed

# Consolidation: TTL pruning
# Test: memory 100 days old, access_count=1 → pruned

# Consolidation: index cap
# Test: 210 index entries → pruned to 200, lowest access_count dropped

# Staleness warning
# Test: memory 3 days old → rendered with "(memory from 3 days ago — verify before acting)"
```

## Boundaries

- Consolidation does NOT run during active user sessions (scheduler fires it when idle)
- Consolidation does NOT modify workforce memory (Layer 4 — that's Summit's job)
- Consolidation does NOT call the LLM for ranking (vector math only for dedup)
- Per-turn extraction does NOT block the user's next input
