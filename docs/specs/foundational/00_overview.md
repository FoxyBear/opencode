# 00 — Architecture Overview

## Objective

Define the architecture, layers, and decisions for the FoxyBear fork of OpenCode. Four capabilities added to the upstream codebase: persistent memory, compaction upgrade, harness-integrated scheduler, and private mesh network.

## Fork Baseline

OpenCode v1.4.3 (`anomalyco/opencode`). TypeScript monorepo, Bun runtime, Effect library for DI/composition, Vercel AI SDK for LLM streaming, Drizzle ORM + SQLite, Hono HTTP server. MIT license.

Branch: `foxybear` from tag `v1.4.3`. Upstream remote for monthly rebases.

## Layer Diagram

```
┌──────────────────────────────────────────────────────────┐
│  TUI (packages/console/)                    [UNCHANGED]  │
├──────────────────────────────────────────────────────────┤
│  Server (src/server/)                   [+ /mesh routes] │
├──────────────────────────────────────────────────────────┤
│  Scheduler (src/scheduler/)                        [NEW] │
├──────────────────────────────────────────────────────────┤
│  Harness Ops (src/harness/)                        [NEW] │
├──────────────┬──────────────┬────────────────────────────┤
│  Memory      │  Compaction  │  Mesh           [02] [06]  │
│  [01,03,04]  │  [02]        │                            │
├──────────────┴──────────────┴────────────────────────────┤
│  Session + Agents + Tools + MCP              [UNCHANGED] │
├──────────────────────────────────────────────────────────┤
│  Providers (Vercel AI SDK)                   [UNCHANGED] │
└──────────────────────────────────────────────────────────┘
```

## Data Flow — Harness-Side Operations

```
loop.before (top of runLoop while(true))
  │
  ├─→ 1. Microcompaction: clear old tool results if >70% context
  ├─→ 2. Auto-recall: query Layer 2 (sqlite-vec) + Layer 4 (workforce HTTP)
  ├─→ 3. Mesh check: poll for incoming peer messages
  ├─→ 4. Scheduler check: evaluate cron expressions (serve mode only)
  │
  ▼
existing OpenCode loop
  │
  ├─→ resolveTools() — prompt.ts:1426
  ├─→ build system prompt — prompt.ts:1467
  ├─→ plugin hooks: system.transform (inject memories) — prompt.ts:1465
  ├─→ plugin hooks: messages.transform (inject mesh messages)
  ├─→ LLM.stream() — via SessionProcessor
  ├─→ tool execution with plugin hooks (before/after)
  │       └─→ tool.execute.after: trigger memory capture
  └─→ loop continues or breaks
```

## Existing Code Inventory

All paths relative to `packages/opencode/src/`.

| Component | File | Key Interface | Our Change |
|-----------|------|---------------|------------|
| Core loop | `session/prompt.ts:1301-1308` | `runLoop()` while(true) | Add `loop.before` phase |
| Compaction | `session/compaction.ts:61-378` | `isOverflow, prune, process` | Upgrade to 3-tier |
| Session SQL | `session/session.sql.ts:14-103` | 5 tables (Session, Message, Part, Todo, Permission) | Add memory tables |
| Plugins | `plugin/shared.ts` + `@opencode-ai/plugin` | 16 hook types | Use existing hooks |
| Config | `config/config.ts:910-1109` | `Config.Info` | Add memory, scheduler, mesh sections |
| Agent | `agent/agent.ts:27-52` | `Agent.Info` with Permission.Ruleset | Unchanged |
| Tools | `tool/registry.ts:55-64` | `ids, all, named, tools(model)` | Unchanged |
| MCP | `mcp/index.ts:215-240` | 20+ interface methods | Unchanged |
| mDNS | `server/mdns.ts:6-60` | `publish(port, domain)` | Extend with TXT records |
| Server | `server/server.ts` + `server/instance.ts:46-60` | Hono routes | Add /mesh/* routes |

## Effect Service Pattern (convention for new services)

All new services follow OpenCode's uniform pattern:

```typescript
// 1. Service class
export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Memory") {}

// 2. Layer construction
export const layer: Layer.Layer<Service, never, Dependencies> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // yield* dependencies
    // InstanceState for per-directory scoping
    const state = yield* InstanceState.make<State>(...)
    return Service.of({ ...methods })
  }),
)

// 3. Top-level async facade
const { runPromise } = makeRuntime(Service, defaultLayer)
export async function recall(query: string) {
  return runPromise((svc) => svc.recall(query))
}
```

## Architectural Decisions

### D-01: Fork, don't build from scratch
OpenCode gives us TUI, providers, MCP, plugins, headless API, compaction, SQLite sessions — all production-grade. Our 4 capabilities are additions.

### D-02: Harness owns the loop via `loop.before` hook
Add a harness phase at the top of `runLoop()` while(true) (~prompt.ts:1308). Operations run before OpenCode's existing message assembly. ~5 lines of modification to the core loop.

### D-03: Auto-recall is a harness operation, not an LLM tool
Memory recall happens before the LLM sees messages. Uses `experimental.chat.system.transform` to inject results. Zero LLM calls for retrieval (vector math only).

### D-04: sqlite-vec for semantic memory in existing SQLite
Shares Bun's SQLite file. Zero new processes. Brute-force KNN fine for <100K vectors. macOS caveat: `Database.setCustomSQLite()` needed.

### D-05: 3-tier compaction modeled on Claude Code
Microcompaction (zero cost) → session memory (zero compaction cost) → full LLM summary. Upgrades OpenCode's single-tier compaction in `compaction.ts`.

### D-06: Scheduler inside `opencode serve`
Scheduled tasks need full harness context (memory, tools, persona, mesh). Can't be external cron. Runs as an Effect service within the serve process.

### D-07: Mesh extends existing mDNS + REST
OpenCode already has `bonjour-service` and headless HTTP API. We add capability TXT records, mesh routes, and HMAC signing.

### D-08: Minimize fork delta
New code lives in new directories (`src/memory/`, `src/mesh/`, `src/scheduler/`, `src/harness/`). Only 3 existing files modified (prompt.ts, config.ts, server.ts). All other OpenCode code unchanged.

## Spec File Map

| Spec | Component | Statements | Phase |
|------|-----------|-----------|-------|
| [01](01_memory_persistent.md) | Persistent memory layers 1-4 | ~25 | 1, 3 |
| [02](02_memory_compaction.md) | 3-tier compaction | ~20 | 2 |
| [03](03_memory_consolidation.md) | autoDream + extraction | ~15 | 3 |
| [04](04_memory_recall.md) | Auto-recall flow | ~12 | 1 |
| [05](05_scheduler.md) | Cron scheduler | ~18 | 4 |
| [06](06_mesh.md) | Private mesh network | ~15 | 5 |
| [07](07_harness.md) | Harness operations | ~10 | 2 |

## Boundaries

- Fork does NOT modify TUI, providers, plugin system, or MCP integration
- Fork does NOT replace OpenCode's agent/tool/permission model
- Fork does NOT add new LLM providers (Vercel AI SDK handles that)
- Fork does NOT break existing `bun test` (1872 passing tests preserved)
