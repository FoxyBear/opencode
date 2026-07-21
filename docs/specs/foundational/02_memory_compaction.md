# 02 — Compaction

## Objective

Upgrade OpenCode's single-tier LLM compaction to a 3-tier system modeled on Claude Code: microcompaction (zero cost), session memory (zero compaction cost), and full LLM summary with structured rehydration.

## Prior Art

- OpenCode `session/compaction.ts:61-378` — Existing single-tier: `isOverflow`, `prune` (40K protect, 20K minimum), `process` (generates summary via compaction agent)
- OpenCode `session/compaction.ts:189-217` — Existing summary prompt (goal, instructions, discoveries, accomplished, files)
- Claude Code v2.1.88: microcompaction (cache-aware tool clearing), session memory (10-section structured notes), full summary (9-section with verbatim user messages)
- fbcli `spec/04_context.md` statements CX-01 through CX-14

## Behavior

### Tier 1: Microcompaction (Zero LLM Cost)

**WHEN** the harness-side `loop.before` runs and token count exceeds 70% of `model.limit.context`,
the harness **SHALL** trigger microcompaction.

**WHEN** microcompaction runs,
it **SHALL** walk message parts backward and replace compactable tool results older than the 5 most recent with `[content cleared]`.

**WHEN** a tool result is from a compactable tool (file read, shell output, grep, glob, web fetch, edit),
it **SHALL** be eligible for clearing.

**WHEN** a tool result is from a non-compactable tool (user messages, notebook edits, task management, skill),
it **SHALL NOT** be cleared — matching OpenCode's existing `PRUNE_PROTECT_TOOLS` pattern at `compaction.ts:37`.

**WHEN** microcompaction clears tool results,
it **SHALL** set `part.state.time.compacted = Date.now()` on each cleared part (same pattern as existing `prune()` at `compaction.ts:125`).

**WHEN** microcompaction reduces token count below 70%,
the harness **SHALL NOT** trigger Tier 2 or Tier 3.

### Tier 2: Session Memory (Zero LLM Cost for Compaction)

**WHEN** token count exceeds 85% of context window AND token growth since last session memory update >= 10K AND (>= 5 tool calls since last update OR no tool calls in last turn),
the harness **SHALL** trigger session memory extraction.

**WHEN** session memory extraction runs,
it **SHALL** spawn a forked subagent to generate a structured markdown file with these sections:
1. Session title
2. Current state
3. Task specification
4. Files and functions
5. Workflow
6. Errors and corrections
7. Codebase documentation
8. Learnings
9. Key results
10. Worklog

**WHEN** a session memory section is generated,
each section **SHALL** be capped at 2,000 tokens, total file at 12,000 tokens.

**WHEN** session memory is available during auto-compact,
it **SHALL** replace summarized messages — the session memory file becomes the compaction output without an additional LLM call.

### Tier 3: Full LLM Summary (One Model Call)

**WHEN** Tiers 1-2 are insufficient and token count exceeds 95% of context window,
the harness **SHALL** trigger full LLM compaction via the existing `SessionCompaction.create()` at `compaction.ts:141`.

**WHEN** full compaction runs,
it **SHALL** use a 9-section structured summary prompt:
1. Primary request and intent
2. Key technical concepts
3. Files and code sections (with snippets)
4. Errors and fixes
5. Problem-solving approaches
6. **ALL user messages (verbatim)** — prevents task drift
7. Pending tasks
8. Current work (detailed)
9. Next step with direct quotes

**WHEN** full compaction produces a summary,
it **SHALL** strip any `<analysis>` blocks before injecting the summary.

**WHEN** full compaction completes,
the harness **SHALL** rehydrate context by:
1. Re-reading the 5 most recently accessed files (capped at 5K tokens each, 50K total)
2. Re-injecting active skills (most recent first, 5K each, 25K total)
3. Restoring task/plan state
4. Re-announcing the full tool set

### Circuit Breaker

**WHEN** compaction fails 3 consecutive times (`MAX_CONSECUTIVE_COMPACTION_FAILURES = 3`),
the harness **SHALL** disable auto-compaction until the next successful manual compaction.

**WHEN** auto-compaction is disabled by the circuit breaker,
the harness **SHALL** log a warning on each turn: `"Auto-compaction disabled after 3 consecutive failures. Use /compact to retry."`.

**WHEN** a manual compaction succeeds after circuit breaker activation,
the harness **SHALL** reset the failure counter and re-enable auto-compaction.

### Token Counting

**WHEN** the harness counts tokens for budget decisions,
it **SHALL** use OpenCode's existing token estimation: ~1 token per 4 characters for text, flat 2,000 for images/documents, with a 33% conservative buffer.

**WHEN** tool definitions are included in the token count,
they **SHALL** be estimated from tool name + JSON schema size.

## Interface Contract

```typescript
// Extends existing SessionCompaction.Interface at compaction.ts:39-59
export interface CompactionInterface {
  // Existing methods preserved
  readonly isOverflow: (input: { tokens, model }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID }) => Effect.Effect<void>
  readonly process: (input: { parentID, messages, sessionID, auto, overflow? }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: { sessionID, agent, model, auto, overflow? }) => Effect.Effect<void>

  // New methods
  readonly microcompact: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
    budgetPercent: number       // 0.70
  }) => Effect.Effect<{ cleared: number; tokensFreed: number }>

  readonly extractSessionMemory: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
  }) => Effect.Effect<SessionMemory>

  readonly getSessionMemory: (input: {
    sessionID: SessionID
  }) => Effect.Effect<SessionMemory | undefined>
}

export interface SessionMemory {
  sessionID: SessionID
  sections: Record<string, string>   // 10 sections
  totalTokens: number
  updatedAt: string
}

export interface CompactionConfig {
  tier1_threshold: number    // 0.70
  tier2_threshold: number    // 0.85
  tier3_threshold: number    // 0.95
  max_failures: number       // 3
  rehydrate_files: number    // 5
  rehydrate_file_tokens: number  // 5000
  rehydrate_skills_tokens: number  // 25000
}
```

## Harness Operations (automatic)

- Microcompaction check on every loop iteration (via `loop.before`)
- Session memory extraction triggered by token growth + tool call thresholds
- Full compaction triggered by 95% threshold
- Circuit breaker tracking across the session
- Post-compaction rehydration (file re-reads, skill re-injection)

## LLM-Callable Tools

None. Compaction is invisible to the LLM. The `/compact` slash command triggers manual compaction.

## Verification

```bash
bun test src/memory/__tests__/compaction.test.ts

# Tier 1: microcompaction clears old tool results
# Test: 20 tool results → microcompact → oldest 15 cleared, 5 most recent preserved

# Tier 1: non-compactable tools protected
# Test: user messages + skill results → microcompact → none cleared

# Tier 2: session memory extraction
# Test: mock session with 50 messages → extract → 10-section file, <12K tokens

# Tier 2: session memory replaces compaction
# Test: session memory exists → auto-compact triggers → no LLM call, session memory used

# Tier 3: verbatim user messages
# Test: full compaction → summary contains all user messages verbatim

# Tier 3: rehydration
# Test: full compaction → 5 files re-read, skills re-injected

# Circuit breaker
# Test: 3 consecutive failures → auto-compact disabled → manual succeeds → re-enabled
```

## Boundaries

- Compaction does NOT modify persistent memory (that's spec 01)
- Compaction does NOT decide when to run (that's spec 07 harness operations)
- Compaction does NOT manage the conversation history (that's OpenCode's Session service)
- Tier 3 delegates to the existing `SessionCompaction.process()` — we enhance it, not replace it
