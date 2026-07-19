# SDD-00 Master: Telegram Coordinator Overhaul

**Date:** 2026-07-19
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Model tier:** authored at Opus tier

This is the master spec for the Telegram coordinator overhaul. It defines the architecture, the cross-cutting requirements every feature spec inherits, the Katya security invariant, the shared glossary, and the dependency order between specs. The four feature specs (SDD-01 through SDD-04) refine this document. Where a feature spec conflicts with this master, this master wins and the feature spec must be corrected.

No code is written against any spec until the full suite passes independent audit and the human gate (see the approved plan and `make sdd`).

## Architecture

### Problem being solved

The current Telegram client fails on three axes:

1. **No durable context.** Each inbound message spawns a brand-new stateless `HeadlessSession`; continuity is a 500-char summary prepended within a 30-minute in-memory TTL. Lost on restart, lost after 30 minutes, never a real conversation.
2. **No model control.** The model is fixed to the persona frontmatter; the user cannot see or change it from chat.
3. **Broken sub-agent dispatch.** The `question` tool publishes to the Effect service (Layer A: Bus `Event.Asked` + a parked `Deferred`); Telegram polls a separate global registry (Layer B: `globalList()`); the bridge (`globalRegister()`) has zero callers. Questions never reach chat; the tool blocks until timeout.

### Target shape

A four-stage pipeline inside the single daemon process, with a durable SQLite queue as the seam between ingestion and execution:

```
Ingestion (Telegram poller)      Durable queue (SQLite)     Worker loop            Result routing
  owns the bot token,        ->    job_queue table,      ->  claims jobs,      ->  delivery loop in
  dedups via inbox,                correlation +             runs HeadlessSession   the poller process
  enqueues + acks,                 lease columns             with concurrency cap   edits the ack message
  returns immediately
```

The ingestion loop (which owns the Telegram connection, because concurrent `getUpdates` on one token returns HTTP 409) never blocks on execution. It persists a durable correlation record, enqueues a job, posts an acknowledgement message, and returns. A worker loop in the same OS process claims jobs from the durable queue and executes them through the existing `HeadlessSession.run` choke point. Results are routed back to the originating chat by a delivery loop that reads completed jobs from the table and edits the acknowledgement message. Because correlation and results are table-backed, delivery survives the originating request context ending and survives a best-effort daemon restart.

### Right-sizing (single host, one daemon)

"Split ingestion from execution with a worker pool and queue" is realized as a **durable SQLite job table plus an in-daemon worker loop in the same OS process**, not as external infrastructure (no Redis, RabbitMQ, or Temporal) and not as separate OS processes. The connection owner and the executor share a heap; the only state that must be durable is (a) the job queue, (b) the chat/session correlation, and (c) the update dedup inbox plus poll offset. Everything else may stay in-heap provided it is reconstructable from the database after a restart.

A true multi-process split would additionally require a durable question table (the question relay currently shares a heap) and a real IPC channel for the worker-to-ingestion nudge. Those are explicitly out of scope; this spec suite documents where they would differ but does not build them.

### Durable stores

- **SQLite via Drizzle** (`src/storage/db.ts`, `Database.use` / `Database.transaction`) is the durable relational store for all new state. New tables follow the `src/scheduler/scheduler.sql.ts` pattern with migrations under `migration/<YYYYMMDDHHMMSS>_<slug>/migration.sql`, auto-applied at boot.
- **SurrealDB** is used only for memory/graph and has no live-query usage; it is not used by this overhaul.

## Cross-Cutting Requirements

These apply to all feature specs. Each is testable and must be honored by every relevant WHEN/SHALL requirement downstream.

- **CC-1 Durability over memory.** WHEN the daemon restarts, the system SHALL reconstruct chat/session mappings, the job queue, the dedup inbox, and the poll offset from SQLite. No conversation identity, queued job, or correlation may live only in process memory.
- **CC-2 Idempotent ingestion.** WHEN Telegram delivers an update whose `update_id` was already processed, the system SHALL discard it (check-and-insert against a durable inbox in one transaction) and SHALL NOT enqueue a duplicate job. Telegram guarantees at-least-once delivery; deduplication is the system's responsibility.
- **CC-3 Per-chat ordering.** WHEN two messages for the same chat are in flight, the system SHALL apply them to that chat's session in arrival order. Concurrent prompts against one session id are forbidden because they corrupt turn ordering and compaction.
- **CC-4 Ack-first.** WHEN a chat message is accepted, the ingestion loop SHALL post an acknowledgement and return without blocking on execution. Execution happens in the worker.
- **CC-5 At-least-once delivery to chat.** WHEN a job reaches a terminal state (done, error, canceled), its result SHALL be delivered to the originating chat exactly through the durable correlation record, even if the daemon restarted after the job completed. A duplicate identical edit is acceptable (Telegram "message is not modified" is swallowed).
- **CC-6 Best-effort restart.** WHEN the daemon restarts with jobs in `claimed` or `running` state, the system SHALL either re-queue them (bounded by an attempt cap) or mark them error and deliver that error to chat. Work performed by an interrupted job may be lost and repeated; this is the accepted trade-off. Completed jobs are never lost.
- **CC-7 Rate-limit safety.** WHEN sending progress updates, the system SHALL edit a single acknowledgement message (not post new messages) and SHALL debounce edits to at most roughly one every few seconds per chat, staying within Telegram limits (edits about 6 per second, sends about 30 per second).
- **CC-8 Security boundary is a hard invariant.** See Security below. No feature may weaken it.
- **CC-9 No broken tests.** WHEN any feature is implemented, the existing test suite SHALL remain green and typecheck SHALL pass. A feature is not done if it leaves red tests.
- **CC-10 Reuse before building.** Implementations SHALL reuse the named existing patterns (scheduler drain/concurrency, `Database.transaction`, the question REST reply path, `Bus.subscribe`) rather than introducing parallel mechanisms.

## Security

**Katya must never use Anthropic or OpenAI models.** This is a standing FoxyBear privacy boundary. Today there is no enforcement: `getSmallModel`, `defaultModel`, and the provider `sort` priority (`src/provider/provider.ts:1681,1737,1787`) are Anthropic/OpenAI-biased and are not persona-aware, so a persona with no explicit model could silently resolve to a forbidden provider.

- **SEC-1** WHEN any session resolves a model for a persona that declares a deny list, the effective model SHALL be checked against that list at a single choke point in the executor before the prompt is sent, covering all entry points (Telegram, scheduler, mesh), and a denied model SHALL cause a loud failure rather than a silent downgrade.
- **SEC-2** WHEN the daemon starts (or the persona is first used), a persona that declares a deny list SHALL be validated to also declare an allowed default `model`; a persona that could resolve to a denied provider SHALL fail loudly at validation time.
- **SEC-3** WHEN a user selects a model via `/model`, the chat interface SHALL never offer or accept a model forbidden for the active persona (defense in depth in addition to SEC-1).
- **SEC-4** The allow/deny policy SHALL live in persona frontmatter (the boundary is a property of the persona identity), authored as provider/model globs.

The security requirements are owned in detail by SDD-02 but bind the whole suite: no other spec may route around SEC-1.

## Glossary

Opinionated vocabulary for this overhaul. One name per concept.

- **Chat.** A Telegram conversation, keyed by `chat_id`. The unit of session identity.
- **Chat session.** The one durable FoxyBear session bound to a chat, stored as the nullable `telegram_session.session_id` (its single storage home). Reused across messages so context accrues. `/new` sets it to NULL (preserving `model_override` and `persona`); the next message creates a fresh session and writes the new id back.
- **Job.** A unit of work enqueued by ingestion and executed by the worker, one row in `job_queue`. Kind is `chat_message` or `subagent`.
- **Ack message.** The Telegram message the bot posts immediately on accepting a job (`job_queue.ack_message_id`, nullable). Progress and the final result are delivered by editing this message; when the id is NULL (a crash lost the ack send), the delivery loop posts a fresh message instead.
- **Correlation.** The durable link from a job (and its session) back to the originating chat and ack message. Replaces the in-heap `_sessionToChat` map. _Avoid:_ "routing state" (too vague).
- **Inbox.** The durable dedup table of processed `update_id`s (`telegram_inbox`). _Avoid:_ "queue" (the inbox dedups ingestion; the queue holds jobs).
- **Lease.** The `claimed_at` / `claimed_by` columns a worker sets when it claims a job, used for best-effort restart recovery. _Avoid:_ "lock."
- **Poll offset.** The Telegram `getUpdates` cursor, derived durably from `max(update_id)+1`, not held only in memory.
- **Layer A / Layer B.** Layer A is the Effect-based `Question.Service` (Bus `Event.Asked` + parked `Deferred`), the working producer side. Layer B is the dead global registry (`globalRegister/globalList/globalReply`) to be deleted. _Avoid:_ using "question registry" without specifying which.
- **Question bridge.** The daemon-side `Bus.subscribe(Event.Asked)` inbound path plus the REST `/question/:id/reply` outbound path that connects a parked question to Telegram and back.
- **Delivery loop.** The table-driven loop in the poller process that delivers terminal job results to chat by editing the ack message.
- **Nudge.** An in-process signal from the worker to the delivery loop to run one pass immediately (latency optimization only; the polling backbone is the source of truth).

## Dependency Order

Specs and their build order. Each depends on the prior for shared tables and plumbing.

1. **SDD-04 foundation first (tables + run-chain).** The `telegram_session`, `job_queue`, and `telegram_inbox` tables and the `HeadlessSession` run-chain threading are shared plumbing. Although SDD-04 owns the queue, its table definitions and the run-chain parameter additions are prerequisites for SDD-01 (durable sessions reuse `telegram_session`) and SDD-03 (the question bridge reads `job_queue.session_id`).
2. **SDD-01 Durable per-chat sessions** — depends on `telegram_session` and the run-chain `sessionId` parameter.
3. **SDD-02 Model control + security guard** — depends on `telegram_session.model_override` and the run-chain `model` parameter; introduces the SEC choke point.
4. **SDD-03 Question / sub-agent relay** — depends on `job_queue.session_id` and `telegram_session` for durable, parent-walk correlation; deletes Layer B.

Implementation sequencing within the pipeline: build the shared tables and run-chain threading, then SDD-01, SDD-02, SDD-04 ingestion/worker/routing, and SDD-03 last (it consumes the durable correlation the others establish). Each spec is implemented and verified as its own `make sdd implement <spec>` / `make sdd verify <spec>` unit.

## Shared Contract (authoritative)

This section resolves the cross-spec seams that independent audit flagged. Where any feature spec disagrees with this contract, this contract wins.

### SC-1 Single table ownership

The three shared tables are defined EXACTLY ONCE, by SDD-04, in a single schema file `src/queue/queue.sql.ts` and a single migration `migration/20260719120000_telegram_queue/migration.sql`. No other spec issues any `CREATE TABLE` or `ALTER TABLE` for them. SDD-01, SDD-02, and SDD-03 REFERENCE the tables through the `TelegramStore` / `Queue` data-access modules only.

Authoritative `telegram_session` schema (columns nullable exactly as shown, so `/new` can clear the session while preserving the model choice):

- `chat_id` TEXT PRIMARY KEY
- `session_id` TEXT NULL
- `persona` TEXT NULL (fall back to the config default persona when NULL)
- `model_override` TEXT NULL (used by SDD-02; the column is declared here, never added by a separate ALTER)
- `...Timestamps`
- index on `session_id`

`job_queue.ack_message_id` is INTEGER NULL (see SC-3). All other `job_queue` and `telegram_inbox` columns are as SDD-04 specifies.

### SC-2 Run-chain and worker/session integration

The run-chain plumbing (optional `sessionId`, `chatId`, `model {providerID, modelID}` on `HeadlessSession.run`, the `SessionRunner` type, `Runner.SessionExecutor.execute`, and `buildDefaultExecutor`) is OWNED by SDD-04 (foundation) and CONSUMED by SDD-01 (`sessionId`) and SDD-02 (`model`). It is added once.

The job payload carries resume + model context: `payload = { prompt, persona?, timeoutMs?, sessionId?, model? }`.

- **Ingestion** (SDD-01/SDD-04 `processMessage`): on a chat message, read the chat's `telegram_session` row and set `payload.sessionId` from its `session_id` (if any), `payload.model` from its parsed `model_override` (if any), and `payload.persona`. Ingestion does not execute.
- **Worker** (SDD-04 `JobWorker.drain`): pass `payload.sessionId` and `payload.model` into `HeadlessSession.run`, and supply `onSessionCreated:(sid) => { Queue.setSession(job.id, sid); if (job.chat_id) TelegramStore.setSession(job.chat_id, sid) }`. The runner fires `onSessionCreated` only when it creates a NEW session (not on resume), so a new chat session id is persisted to BOTH `job_queue.session_id` and the chat's `telegram_session.session_id` (the durable resume seam), while a resumed session needs no write-back. This is what makes SDD-01 durable resume actually reachable through the SDD-04 split.

### SC-3 Ingestion atomicity (no lost accepted message)

The dedup-insert and the job-enqueue SHALL commit together so a crash cannot leave an acknowledged-but-unqueued (or queued-but-unrecorded) update.

- Ingestion performs the `telegram_inbox` check-and-insert AND the `job_queue` insert inside ONE `Database.transaction`, with `ack_message_id` left NULL.
- AFTER that transaction commits, ingestion sends the ack via `sendMessage` and updates `ack_message_id`.
- If a crash occurs after the commit but before/at the ack send, on restart the job exists (`pending`, `ack_message_id` NULL) and the poll offset (`max(inbox.update_id)+1`) is consistent with it. The delivery loop, seeing a terminal job with `ack_message_id` NULL, delivers via a fresh `sendMessage` rather than `editMessageText`. No accepted message is lost.

### SC-4 Security choke point is field-correct and fail-closed (binds SDD-02)

- The executor-level guard SHALL read the persona policy from `resolvedPersona.config.models` (the real location), never a non-existent `resolvedPersona.models`. An `undefined` policy read is a bug, not an allow-all.
- WHEN the persona file fails to parse or load for a persona expected to carry a policy, the system SHALL fail closed (deny / loud failure), never fall open to permitting all providers.
- SEC-2 validation SHALL cover allow-only personas: a persona declaring an allow list whose default/frontmatter model is not within it SHALL fail validation.

### SC-5 Instance context for the question bridge (binds SDD-03)

`Question.Service` state is instance-scoped by directory. The outbound reply and any `Question.Service` calls made from the Telegram process or the `Bus.subscribe` fiber SHALL run inside `Instance.provide({ directory: process.cwd(), init: () => AppRuntime.runPromise(InstanceBootstrap), fn })`, mirroring `src/daemon/runner.ts` and `src/server/instance/middleware.ts`. A bare `AppRuntime.runPromise(Question.Service.use(...))` throws `LocalContext.NotFound` and never resolves the parked `Deferred`. Because `onSessionCreated` persists `session_id` at session creation (before `sdk.session.prompt` runs and therefore before any question tool fires), the chat correlation is durably available when a question is asked; there is no race.

## Feature spec template (authoring contract)

Every feature spec (SDD-01..04) MUST contain these three top-level sections, in this order, so the pipeline validator and the independent auditors can check them:

- `## WHAT` — behavioral requirements as numbered `WHEN <condition>, the system SHALL <observable behavior>` statements, fine enough to implement and test unambiguously. Include negative requirements (SHALL NOT) where a failure mode must be prevented. Reference cross-cutting IDs (CC-n, SEC-n) where they apply.
- `## HOW` — the implementation approach per FoxyBear best practices, with an explicit reuse map naming existing functions and files (with `path:line` anchors) to reuse, the new files/tables to add, and the precedence/ordering rules. No new mechanism where an existing one fits (CC-10).
- `## VERIFY` — acceptance criteria checked by independent agents exercising full functionality (not just unit tests): the mocked-Telegram harness scenarios, the observable end-to-end assertions mapped 1:1 to the WHAT requirements, and the build/regression checks. Each criterion must state the setup, action, and expected observable result.

Feature specs SHALL express requirements with the literal tokens `WHEN` and `SHALL` so they are machine-checkable.
