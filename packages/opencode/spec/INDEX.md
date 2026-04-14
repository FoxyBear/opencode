# Spec Index

Cross-reference of all behavioral specs and WHEN/SHALL statements for the FoxyBear OpenCode fork.

## Spec Files

| # | File | Component | Phase | Statements |
|---|------|-----------|-------|-----------|
| 00 | [00_overview.md](00_overview.md) | Architecture, decisions, fork delta | 0 | — |
| 01 | [01_memory_persistent.md](01_memory_persistent.md) | Persistent memory layers 1-4 | 1, 3 | 17 |
| 02 | [02_memory_compaction.md](02_memory_compaction.md) | 3-tier compaction | 2 | 17 |
| 03 | [03_memory_consolidation.md](03_memory_consolidation.md) | autoDream + extraction | 3 | 16 |
| 04 | [04_memory_recall.md](04_memory_recall.md) | Auto-recall flow | 1 | 14 |
| 05 | [05_scheduler.md](05_scheduler.md) | Cron scheduler | 4 | 21 |
| 06 | [06_mesh.md](06_mesh.md) | Private mesh network | 5 | 18 |
| 07 | [07_harness.md](07_harness.md) | Harness operations | 2 | 10 |
| | **Total** | | | **113** |

## Statements by Spec

### 01 — Persistent Memory (17)

| ID | Trigger | Behavior |
|----|---------|----------|
| PM-01 | Session starts | Load memory index into system prompt |
| PM-02 | Index exceeds 200 entries | Reject new entries, log warning |
| PM-03 | Index entry rendered | Format: `- [{key}]({pointer}): {summary}` |
| PM-04 | Index is empty | No memory index section in system prompt |
| PM-05 | Topic memory stored | Generate embedding, store with persona/scope |
| PM-06 | Store with cosine > dedup_threshold | Update existing instead of insert |
| PM-07 | Dedup match update | Merge content, update accessed_at, increment access_count |
| PM-08 | Topics queried | Top N by cosine similarity, filtered by persona |
| PM-09 | Topic memory accessed | Update accessed_at and access_count |
| PM-10 | accessed_at older than ttl_days | Eligible for pruning |
| PM-11 | Transcript data needed | Query existing MessageTable |
| PM-12 | Full transcript requested | Return grep matches only, never full load |
| PM-13 | Workforce configured | Query HTTP endpoint during auto-recall |
| PM-14 | Workforce unavailable | Log warning, proceed without (graceful degradation) |
| PM-15 | Workforce results returned | Merge with Layer 2, dedup by cosine > 0.9 |
| PM-16 | Workforce not configured | Skip Layer 4 entirely |
| PM-17 | forget() called | Delete from topics + remove index entry |

### 02 — Compaction (17)

| ID | Trigger | Behavior |
|----|---------|----------|
| CP-01 | Tokens > 70% context | Trigger microcompaction |
| CP-02 | Microcompaction runs | Clear compactable tool results older than 5 most recent |
| CP-03 | Tool is compactable | Eligible: file read, shell, grep, glob, web fetch, edit |
| CP-04 | Tool is non-compactable | Protected: user messages, notebook, task, skill |
| CP-05 | Part cleared | Set part.state.time.compacted = Date.now() |
| CP-06 | Microcompaction sufficient | Do NOT trigger Tier 2 or 3 |
| CP-07 | Tokens > 85% + growth + tool calls | Trigger session memory extraction |
| CP-08 | Session memory extracted | 10-section markdown, 2K/section, 12K total |
| CP-09 | Session memory available at compact | Use it instead of LLM call |
| CP-10 | Tokens > 95% context | Trigger full LLM compaction |
| CP-11 | Full compaction runs | 9-section summary, verbatim user messages |
| CP-12 | Summary has analysis blocks | Strip before injection |
| CP-13 | Post-compaction rehydration | Re-read 5 files, re-inject skills, restore state |
| CP-14 | 3 consecutive failures | Disable auto-compaction (circuit breaker) |
| CP-15 | Auto-compact disabled | Log warning each turn |
| CP-16 | Manual compaction succeeds after breaker | Reset counter, re-enable |
| CP-17 | Token counting | ~1 token/4 chars, 2K for images, 33% buffer |

### 03 — Consolidation (16)

| ID | Trigger | Behavior |
|----|---------|----------|
| CN-01 | Turn completes | Spawn forked subagent for extraction |
| CN-02 | Extraction subagent runs | Restricted tools: memory_store and memory_recall only |
| CN-03 | Durable fact identified | Store via Memory.store() with source: "extraction" |
| CN-04 | Slash command turn | Skip extraction |
| CN-05 | Extraction fails | Log error, continue (best-effort) |
| CN-06 | auto_capture = false | Skip extraction entirely |
| CN-07 | All 3 gates met (24h + 5 sessions + no lock) | Trigger autoDream |
| CN-08 | Orient phase | Read index, skim topics, build dedup map |
| CN-09 | Gather phase | Grep transcripts for new signal |
| CN-10 | Consolidate phase | Merge, absolute dates, delete contradictions |
| CN-11 | Prune phase | Remove expired, merge near-duplicates, enforce 200 cap |
| CN-12 | Lock exists with live PID < 1h | Block concurrent consolidation |
| CN-13 | Lock stale (dead PID or > 1h) | Remove lock, proceed |
| CN-14 | autoDream completes | Remove lock file |
| CN-15 | Memory > 1 day old | Append staleness warning |
| CN-16 | Memory > 7 days, access_count < 2 | Reduce ranking score by 50% |

### 04 — Auto-Recall (14)

| ID | Trigger | Behavior |
|----|---------|----------|
| AR-01 | loop.before runs | Extract user query, trigger recall |
| AR-02 | Input is slash command | Skip auto-recall |
| AR-03 | Same turn, tool loop | Return cached results |
| AR-04 | New user message | Invalidate cache |
| AR-05 | Embed query | Use Ollama nomic-embed-text primary |
| AR-06 | Primary embedding unavailable | Fall back to DeepInfra BGE-M3 |
| AR-07 | Both providers unavailable | Skip recall, log error |
| AR-08 | Embedding generated | Cache for turn duration |
| AR-09 | Layer 2 queried | Cosine similarity, filtered by persona, top N |
| AR-10 | Layer 4 queried | HTTP to workforce, timeout 5s |
| AR-11 | Workforce timeout | Log warning, proceed with Layer 2 only |
| AR-12 | Results merged | Dedup by cosine > 0.9, prefer Layer 2 |
| AR-13 | Results injected | Via experimental.chat.system.transform hook |
| AR-14 | No results | No memories section in system prompt |

### 05 — Scheduler (21)

| ID | Trigger | Behavior |
|----|---------|----------|
| SC-01 | serve starts, scheduler.enabled | Start cron evaluator (every 60s) |
| SC-02 | Evaluator ticks | Check all enabled tasks, fire due ones |
| SC-03 | serve shuts down | Stop evaluator, wait 30s for running tasks |
| SC-04 | serve restarts | Reload tasks from SQLite, resume (no backfill) |
| SC-05 | Scheduler initializes | Register internal maintenance tasks |
| SC-06 | Maintenance task fires | Run silently, no transcript unless error |
| SC-07 | Maintenance task fails | Log to scheduler_log, continue |
| SC-08 | Maintenance task already running | Skip, log "already running" |
| SC-09 | /schedule add | Persist task in scheduled_tasks table |
| SC-10 | User task fires | Create session with persona, inject prompt, run loop |
| SC-11 | User task persona missing | Use default agent, log warning |
| SC-12 | User task succeeds | Update last_run, last_status="success", log |
| SC-13 | User task fails | Update last_status="error", log, keep task enabled |
| SC-14 | output.transcript = true | Session transcript preserved |
| SC-15 | output.mesh_target set | Send response as mesh message |
| SC-16 | output.file_path set | Write response to file |
| SC-17 | Max concurrent user tasks reached | Queue task, FIFO |
| SC-18 | /schedule list | Show all tasks with next fire time |
| SC-19 | /schedule remove | Delete task and log |
| SC-20 | /schedule run | Fire immediately, bypass cron |
| SC-21 | /schedule log | Show recent execution history |

### 06 — Mesh Network (18)

| ID | Trigger | Behavior |
|----|---------|----------|
| MS-01 | serve starts, mesh.enabled | Publish mDNS with extended TXT records |
| MS-02 | serve shuts down | Unpublish mDNS service |
| MS-03 | mDNS fails | Log warning, standalone mode |
| MS-04 | Mesh enabled | Browse for peers with txt.mesh="1" |
| MS-05 | Peer discovered | Add to registry with name/address/capabilities/status |
| MS-06 | Peer disappears (mDNS goodbye) | Mark offline |
| MS-07 | Peer unseen 25 minutes | Remove from registry |
| MS-08 | Send message | Construct envelope with HMAC-SHA256 |
| MS-09 | Target not in registry | Return error: node not online |
| MS-10 | POST fails | Return error: failed to reach node |
| MS-11 | Receive message | Verify HMAC |
| MS-12 | HMAC fails | Return 401, log security warning |
| MS-13 | Receive directive | Create session or inject into current |
| MS-14 | Receive status | Log only, not injected |
| MS-15 | Receive query | Route to session, require response |
| MS-16 | Receive response | Inject as context into requesting session |
| MS-17 | Delegate task | Send directive with respond_to |
| MS-18 | Heartbeat fires | Update mDNS TXT with current status |

### 07 — Harness Operations (10)

| ID | Trigger | Behavior |
|----|---------|----------|
| HO-01 | Loop iteration starts | Execute harnessOperations.run() before existing logic |
| HO-02 | run() executes | Fixed order: compact, recall, mesh, scheduler |
| HO-03 | Operation disabled by config | Skip entirely |
| HO-04 | Operation fails | Catch, log, continue to next |
| HO-05 | All operations complete | Yield to OpenCode's existing loop |
| HO-06 | Need messages/tokens | Use same sources as existing loop |
| HO-07 | Recall results ready | Inject via system.transform hook |
| HO-08 | Mesh messages arrive | Inject via messages.transform hook |
| HO-09 | First iteration | Run all operations |
| HO-10 | Tool loop iteration | Skip recall (cached) and scheduler tick |

## fbcli Spec Mapping

Statements carried forward from `development/fbcli/spec/`:

| fbcli ID | Fork ID | Status |
|----------|---------|--------|
| MM-01 | AR-01 | Carried (auto-recall trigger) |
| MM-02 | AR-13 | Carried (inject into system prompt) |
| MM-03 | AR-14 | Carried (no results = no section) |
| MM-04 | AR-07 | Carried (graceful degradation) |
| MM-05 | AR-01 | Carried (raw user message as query) |
| MM-06 | AR-02 | Carried (skip slash commands) |
| MM-07 | AR-13 | Carried (numbered list format with dates) |
| MM-08 | PM-08 | Carried (top N by relevance) |
| MM-09 | CN-03 | Carried (mem0_remember → Memory.store) |
| MM-10 | AR-03 | Carried (cache within turn) |
| CX-01..14 | CP-01..17 | Adapted (3-tier compaction, same behaviors, new thresholds) |
| NW-01..07 | MS-01..18 | Rewritten (mDNS + REST instead of custom protocol) |

## New Services

| Service | Tag | Layer Dependencies |
|---------|-----|-------------------|
| `@opencode/Memory` | spec 01 | Config, Bus |
| `@opencode/Embedding` | spec 04 | Config |
| `@opencode/SessionCompaction` (extended) | spec 02 | Config, Bus, Session, Agent, Plugin, Provider |
| `@opencode/Consolidation` | spec 03 | Memory, Embedding, Session, Config |
| `@opencode/Scheduler` | spec 05 | Config, Bus, Session, Memory, Mesh |
| `@opencode/Mesh` | spec 06 | Config, Bus, Session |
| `@opencode/Harness` | spec 07 | Memory, Compaction, Mesh, Scheduler |

## Drizzle Schema Additions

| Table | Spec | New File |
|-------|------|----------|
| `memory_index` | 01 | `src/memory/memory.sql.ts` |
| `memory_topics` | 01 | `src/memory/memory.sql.ts` |
| `memory_vec` (virtual, vec0) | 01 | `src/memory/memory.sql.ts` |
| `scheduled_tasks` | 05 | `src/scheduler/scheduler.sql.ts` |
| `scheduler_log` | 05 | `src/scheduler/scheduler.sql.ts` |
