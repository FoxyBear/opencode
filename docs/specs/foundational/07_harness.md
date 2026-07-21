# 07 — Harness Operations

## Objective

Define the `loop.before` harness phase that orchestrates all automatic operations (recall, compaction, mesh, scheduler) at the top of OpenCode's core loop, before the LLM sees any messages.

## Prior Art

- OpenCode `session/prompt.ts:1301-1308` — `runLoop()` function, `while (true)` at line 1308
- OpenCode `session/prompt.ts:1426` — `resolveTools()` called each iteration
- OpenCode `session/prompt.ts:1465` — Plugin hooks fire before LLM call
- OpenCode `session/compaction.ts:88` — `isOverflow()` for token budget check
- fbcli `spec/01_harness_loop.md` statements HL-01 through HL-11

## Behavior

### Integration Point

**WHEN** the `runLoop()` while(true) at `prompt.ts:1308` begins a new iteration,
the harness **SHALL** execute `harnessOperations.run()` before any existing OpenCode logic.

```typescript
// prompt.ts modification (~5 lines)
while (true) {
  yield* harnessOperations.run(sessionID)   // NEW
  // existing: set busy, load messages, resolve tools, build system, LLM call...
}
```

**WHEN** `harnessOperations.run()` executes,
it **SHALL** run operations in this fixed order:

1. **Microcompaction** — clear old tool results if > 70% context (spec 02)
2. **Auto-recall** — query memory layers, cache results (spec 04)
3. **Mesh message check** — poll for incoming peer messages (spec 06)
4. **Scheduler tick** — evaluate cron expressions, fire due tasks (spec 05, serve mode only)

### Operation Dispatch

**WHEN** an operation is disabled by config (e.g., `memory.enabled = false`),
the harness **SHALL** skip it entirely (no performance cost).

**WHEN** an operation fails,
the harness **SHALL** catch the error, log it, and continue to the next operation (never crash the loop).

**WHEN** all operations complete,
the harness **SHALL** yield control back to OpenCode's existing loop logic.

### Session Context

**WHEN** `harnessOperations.run()` needs the current session's messages,
it **SHALL** use the same `MessageV2.filterCompactedEffect()` that the existing loop uses (no duplicate DB query).

**WHEN** `harnessOperations.run()` needs the current token count,
it **SHALL** use the existing `SessionCompaction.isOverflow()` at `compaction.ts:88`.

**WHEN** `harnessOperations.run()` needs the current persona/agent,
it **SHALL** read it from the session's agent config (same source as `resolveTools()` at `prompt.ts:1426`).

### Plugin Integration

**WHEN** auto-recall produces results,
the harness **SHALL** inject them via the existing `experimental.chat.system.transform` plugin hook — NOT by modifying the system prompt directly.

**WHEN** mesh messages arrive,
the harness **SHALL** inject them via the existing `experimental.chat.messages.transform` plugin hook.

**WHEN** per-turn extraction runs after a completed turn,
the harness **SHALL** trigger it via the existing `tool.execute.after` plugin hook on the final assistant response (not a separate hook).

### First Iteration vs Subsequent

**WHEN** the loop's first iteration runs (fresh user message),
the harness **SHALL** run all applicable operations (recall, compaction, mesh, scheduler).

**WHEN** a subsequent iteration runs (tool loop — LLM called tools and loop continues),
the harness **SHALL** skip auto-recall (cached from first iteration) and scheduler tick (only needed once per turn), but still run microcompaction and mesh check.

## Interface Contract

```typescript
export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Harness") {}

export interface Interface {
  readonly run: (input: {
    sessionID: SessionID
    isFirstIteration: boolean
  }) => Effect.Effect<void>
}

// Dependencies injected via Effect layers
// Memory.Service, SessionCompaction.Service, Mesh.Service, Scheduler.Service
// All optional — harness checks config before calling each
```

## Harness Operations Summary

| Operation | First Iteration | Tool Loop | Serve Mode Only | Dependency |
|-----------|----------------|-----------|-----------------|------------|
| Microcompaction | Yes | Yes | No | Compaction.Service |
| Auto-recall | Yes | No (cached) | No | Memory.Service |
| Mesh check | Yes | Yes | No | Mesh.Service |
| Scheduler tick | Yes | No | Yes | Scheduler.Service |
| Extraction | Post-turn only | No | No | Consolidation.Service |

## Verification

```bash
bun test src/harness/__tests__/harness.test.ts

# Operations run in order
# Test: mock all 4 operations → run() → assert call order: compact, recall, mesh, scheduler

# Disabled operation skipped
# Test: memory.enabled=false → recall not called

# Operation failure doesn't crash loop
# Test: recall throws → log error → mesh and scheduler still run

# First iteration vs tool loop
# Test: isFirstIteration=true → recall runs
# Test: isFirstIteration=false → recall skipped (cached)

# Serve mode check
# Test: not in serve mode → scheduler tick skipped

# Plugin injection
# Test: recall results → injected via system.transform hook
# Test: mesh message → injected via messages.transform hook
```

## Boundaries

- Harness does NOT implement any operation (delegates to Memory, Compaction, Mesh, Scheduler services)
- Harness does NOT modify OpenCode's existing loop logic below the `loop.before` insertion point
- Harness does NOT manage the message array (OpenCode's `MessageV2` handles that)
- Harness does NOT decide what the LLM sees (plugin hooks handle injection)
- Harness modification to `prompt.ts` is ~5 lines — minimal fork delta
