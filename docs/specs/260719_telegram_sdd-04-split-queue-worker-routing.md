# SDD-04: Split Ingestion from Execution — Durable Queue, Worker Loop, Result Routing

**Date:** 2026-07-19
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Model tier:** authored at Opus tier
**Depends on:** SDD-00 master. Governs SDD-01/02/03 (foundation — build first per SDD-00 dependency order §1).

This spec owns the seam between ingestion and execution. It is the SOLE owner of the three shared foundation tables (`telegram_session`, `job_queue`, `telegram_inbox`): they are declared EXACTLY ONCE, here, in one schema file (`src/queue/queue.sql.ts`) and one migration (`migration/20260719120000_telegram_queue/`). It also defines the atomic claim, the in-daemon worker loop, and the table-driven delivery loop. It is the concrete owner of cross-cutting requirements **CC-2** (idempotent ingestion), **CC-4** (ack-first), **CC-5** (at-least-once delivery), **CC-6** (best-effort restart), and **CC-7** (rate-limit safety), and the authority for shared contracts **SC-1** (single table ownership), **SC-2** (worker/session integration), and **SC-3** (ingestion atomicity). SDD-01 (durable sessions), SDD-02 (`model_override`), and SDD-03 (`job_queue.session_id`) REFERENCE these tables through the `TelegramStore` / `Queue` data-access modules only; none of them issues any `CREATE TABLE` or `ALTER TABLE` for them, and there is no competing SDD-01 `telegram_session` migration.

The locked decision: split the process that owns the Telegram token (ingestion) from sub-agent execution via a **durable SQLite queue plus an in-daemon worker loop in the SAME OS process**. Restart survival is **best-effort**. No Redis/RabbitMQ/Temporal, no separate OS process. This is what makes sub-agent dispatch survive the originating request context ending.

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL`. Negative requirements use `SHALL NOT`.

### Foundation tables and durability (CC-1)

- **W-1** WHEN the daemon boots against a database without the `telegram_session`, `job_queue`, or `telegram_inbox` tables, the system SHALL create all three via the single migration `migration/20260719120000_telegram_queue/` applied at boot, and SHALL NOT require any manual step.
- **W-1a** WHEN the full spec suite is present, exactly ONE `CREATE TABLE telegram_session` (and one for `job_queue` and `telegram_inbox`) SHALL exist across `migration/**`; SDD-01, SDD-02, and SDD-03 SHALL NOT issue any `CREATE TABLE` or `ALTER TABLE` against these three tables (they reference them via `TelegramStore`/`Queue`), so migrations SHALL apply without duplicate-table, duplicate-column, or colliding-timestamp failures.
- **W-2** WHEN ingestion, the worker, or the delivery loop needs chat/session correlation, queued jobs, the dedup set, or the poll offset, the system SHALL read them from SQLite and SHALL NOT depend on any in-process map as the source of truth. In-heap caches are permitted only when fully reconstructable from these tables after a restart.

### Idempotent ingestion (CC-2)

- **W-3** WHEN Telegram delivers an accepted chat message, the system SHALL perform the `telegram_inbox` check-and-insert of its `update_id` AND the `job_queue` insert (with `ack_message_id` left NULL) inside ONE `Database.transaction`, and SHALL treat the update as new only when the inbox insert changed a row; because both writes commit atomically, a crash SHALL NOT be able to leave an `update_id` recorded in the inbox without a corresponding job (nor a job without its inbox record).
- **W-4** WHEN an `update_id` is already present in `telegram_inbox`, the system SHALL discard the update and SHALL NOT enqueue a job for it (deduplication of Telegram's at-least-once delivery).
- **W-5** WHEN the daemon starts, the system SHALL derive the poll offset as `max(telegram_inbox.update_id) + 1` (or no offset when the inbox is empty) rather than from any in-memory value that was lost on restart.
- **W-6** WHEN the poller advances, the system MAY cache the next offset in the heap for latency, but the durable inbox SHALL remain the authority used at every boot.

### Ack-first ingestion (CC-4)

- **W-7** WHEN a chat message is accepted (passes allow-list and is not a slash command handled inline), the ingestion loop SHALL read the chat's `telegram_session` row and, inside the single W-3 transaction, enqueue one `chat_message` job whose payload is `{ prompt, persona?, timeoutMs?, sessionId?, model? }` (`sessionId` from the row's `session_id` when present, `model` from its parsed `model_override` when present, `persona` from the row or the config default) plus correlation `{ chat_id, ack_message_id: NULL, reply_to_message_id }`; AFTER that transaction commits, it SHALL post the acknowledgement message via `sendMessage` and store the returned message id via `Queue.setAck(jobId, ackMessageId)`, then return WITHOUT awaiting execution. Ingestion SHALL NOT execute the prompt.
- **W-7a** WHEN the daemon crashes after the W-3 transaction commits but before/at the `sendMessage` ack, on restart the job SHALL still exist (`pending`, `ack_message_id` NULL) and the poll offset (`max(telegram_inbox.update_id)+1`) SHALL be consistent with it, so no accepted message is lost; the delivery loop SHALL deliver such a job's terminal result via a fresh `sendMessage` (see W-17).
- **W-8** WHEN ingestion has enqueued a job, the ingestion loop SHALL NOT call `HeadlessSession.run` inline and SHALL NOT block the `getUpdates` loop on execution.
- **W-9** WHEN the poller is running, the system SHALL maintain exactly one `getUpdates` loop for the bot token, because concurrent `getUpdates` on one token returns HTTP 409.

### Atomic claim and worker (CC-3 ordering, best-effort at-least-once)

- **W-10** WHEN the worker claims work, the system SHALL, inside a `Database.transaction(..., {behavior:"immediate"})`, select the oldest `pending` job, update it to `claimed` guarded by `WHERE id=? AND status='pending'`, set `claimed_at`/`claimed_by`, and increment `attempts`; and SHALL treat a guard that matches zero rows as "another worker won" and claim nothing.
- **W-11** WHEN two claim attempts race for the same job, the system SHALL let at most one succeed; the loser SHALL NOT run that job (no double-claim).
- **W-12** WHEN a job is claimed, the worker SHALL run it through `HeadlessSession.run`, passing `payload.sessionId` (resume the chat's durable session when present) and `payload.model` (SDD-02 model context) through the run-chain, and passing `onSessionCreated:(sid)=>{ Queue.setSession(job.id, sid); if (job.chat_id) TelegramStore.setSession(job.chat_id, sid) }`, then SHALL transition the job to `done` (with `result`) or `error` (with `error` text).
- **W-12a** WHEN `HeadlessSession.run` creates a NEW session (it fires `onSessionCreated` only on creation, not on resume), the worker SHALL write the new session id to BOTH `job_queue.session_id` (the seam SDD-03 reads for question correlation) AND the chat's `telegram_session.session_id` via `TelegramStore.setSession(job.chat_id, sid)`, so SDD-01 durable resume is reachable on the next message; WHEN the run RESUMES an existing session (`payload.sessionId` was supplied), `onSessionCreated` SHALL NOT fire and no write-back SHALL occur.
- **W-13** WHEN the number of in-flight jobs is at or above the concurrency cap (`scheduler.max_concurrent_user_tasks`, default 3), the worker SHALL NOT claim another job until an in-flight job completes.
- **W-14** WHEN a job completes, the worker SHALL immediately attempt to drain (claim the next pending job if capacity allows), and SHALL additionally drain on both a `setInterval` tick and an in-process nudge.
- **W-15** WHEN two chat messages for the same `chat_id` are queued, the worker SHALL apply them to that chat's session in enqueue order and SHALL NOT run two jobs for the same `chat_id` concurrently (CC-3 per-chat ordering).
- **W-16** WHEN the worker's periodic tick fires before the HTTP subsystem has wired the runner, the worker SHALL gate on `HeadlessSession.hasRunner()` and SHALL NOT claim jobs until it returns true.

### At-least-once delivery to chat (CC-5)

- **W-17** WHEN a job is in a terminal state (`done`, `error`, or `canceled`) with `delivered = false` and `ack_message_id` is NON-NULL, the delivery loop SHALL edit the job's ack message (`chat_id`, `ack_message_id`) with the formatted result via `editMessageText`, then SHALL set `delivered = true`.
- **W-17a** WHEN a terminal, undelivered job has `ack_message_id` NULL (a crash lost the ack send per W-7a), the delivery loop SHALL deliver the formatted result via a fresh `sendMessage(chat_id, ...)` instead of `editMessageText`, and SHALL set `delivered = true` (optionally recording the new message id via `Queue.setAck`). No accepted message is lost.
- **W-18** WHEN the daemon restarts after a job completed but before it was delivered, the delivery loop SHALL still deliver it on the next pass (delivery is table-driven, not memory-driven).
- **W-19** WHEN the daemon crashes between the `editMessageText` call and setting `delivered = true`, the delivery loop SHALL re-edit on restart; a duplicate identical edit SHALL be tolerated and the Telegram "message is not modified" error SHALL be swallowed.
- **W-20** The system SHALL NOT use a pure in-process EventEmitter as the source of truth for delivery, because a signal is lost if the poller process is momentarily down; the durable polling loop SHALL be the backbone and the nudge SHALL be a latency optimization only.

### Progress and rate-limit safety (CC-7)

- **W-21** WHEN the worker makes progress on a job, it SHALL write `progress` text and `progress_updated_at` to the job row rather than posting new Telegram messages.
- **W-22** WHEN progress exists for an undelivered job, the delivery loop SHALL reflect it by editing the single ack message, debounced to at most roughly one edit every few seconds per chat, staying within Telegram limits (edits ~6/s, sends ~30/s).
- **W-23** The system SHALL NOT post additional progress messages per job (the crude interval-poster is removed).

### Cancellation (`/stop`)

- **W-24** WHEN a user sends `/stop`, the system SHALL route it through `HarnessCommands.execute` (System category) with the originating `chat_id` supplied explicitly by ingestion (the command execution path SHALL carry a context object bearing `chat_id`, not resolve "the active session" from a stateless registry), and the command SHALL call `Queue.requestCancel(chatId)` setting `cancel_requested = true` on that chat's active/pending job(s).
- **W-25** WHEN the worker reaches a checkpoint and observes `cancel_requested = true`, it SHALL transition the job to `canceled` and SHALL suppress its result so the delivery loop reports cancellation instead of the (possibly still-computing) answer.
- **W-26** WHEN `/stop` is issued, the system SHALL be understood to mean "cancel and suppress result now," NOT "kill computation": the default executor ignores the abort signal (`runner.ts` `_signal` is unused; `sdk.session.prompt` keeps running). This is a KNOWN LIMITATION. Threading a real abort signal into `sdk.session.prompt` SHALL be filed as a flagged follow-up requirement (**FOLLOW-UP-1**) and is out of scope for this spec.

### Best-effort restart (CC-6)

- **W-27** WHEN the worker starts, before its first drain it SHALL run a recovery sweep: for every job in `claimed` or `running`, re-queue it (`status='pending'`, clear `claimed_at`/`claimed_by`) when `attempts < MAX_ATTEMPTS` (default 2), else mark it `error` with `"lost to daemon restart"`.
- **W-28** WHEN a re-queued or errored job is recovered, the system SHALL deliver its terminal result to the SAME ack message via the durable correlation (CC-5), so recovery is visible in chat.
- **W-29** WHEN a `subagent` job is recovered but its `parent_session_id` no longer exists, the system SHALL mark it `error` and deliver that error to the correlated chat.
- **W-30** The system SHALL accept that best-effort restart may repeat partial work or side effects of an interrupted job (possible duplicate side effects); it SHALL guarantee that completed jobs are never lost and that a completed-but-undelivered job yields at most one harmless duplicate edit.

### Sub-agent jobs

- **W-31** WHEN a chat initiates a sub-agent job (via a command or documented convention), the system SHALL enqueue a `subagent` job whose `parent_session_id` is set to that chat's current session, looked up from `telegram_session` (or the chat's most recent `job_queue.session_id`).

### Security passthrough (SEC-1)

- **W-32** WHEN the worker runs any job through `HeadlessSession.run`, it SHALL NOT bypass the executor-level model choke point owned by SDD-02 (SEC-1); the worker adds no model resolution of its own and routes every entry point through the same run-chain.

## HOW

### Reuse map (existing code to reuse — `path:line` anchors verified)

- **Drain/concurrency pattern** — model the worker on `Scheduler`: `_activeTasks` map + cap check in `enqueueInternal` (`src/scheduler/scheduler.ts:561`), `startTask`/`drainQueue` (`src/scheduler/scheduler.ts:585,599`), `start`/`stop` lifecycle (`src/scheduler/scheduler.ts:120,148`), executor indirection (`setExecutor` `src/scheduler/scheduler.ts:100`). Reuse the concurrency default: `SchedulerConfig.max_concurrent_user_tasks = 3` (`src/scheduler/scheduler.ts:57`).
- **Table shape + Timestamps** — follow `src/scheduler/scheduler.sql.ts`: `sqliteTable`, `integer(..., { mode: "timestamp_ms" })` for lease/progress timestamps, `text(..., { mode: "json" })` for payload/result, `integer(..., { mode: "boolean" })` for flags, and `...Timestamps` (`src/storage/schema.sql.ts:3`) for `time_created`/`time_updated`.
- **Atomic transaction** — `Database.transaction(callback, { behavior: "immediate" })` (`src/storage/db.ts:155`; behavior option at `:157`). bun-sqlite transactions are SYNCHRONOUS: the callback returns `NotPromise<T>` and must contain no `await`. Reads/writes inside use the passed `tx`. Non-transactional single statements use `Database.use` (`src/storage/db.ts:130`).
- **Migration loading** — `Database.Client` reads `migration/<dir>/migration.sql`, sorts by the leading `YYYYMMDDHHMMSS` timestamp, and auto-applies at boot (`src/storage/db.ts:65,98,112`). Raw `CREATE TABLE` with backtick-quoted identifiers and `--> statement-breakpoint` between statements, per `migration/20260416120000_scheduler_tables/migration.sql`.
- **Run choke point** — `HeadlessSession.run({ prompt, persona, timeoutMs, onSessionCreated })` (`src/daemon/headless.ts:31`); `SessionRunner` signature (`src/daemon/headless.ts:12`) already carries `onSessionCreated`. SDD-04 (foundation) adds the optional `sessionId`, `chatId`, and `model {providerID, modelID}` parameters to the run-chain ONCE here (per SC-2), consumed by SDD-01 (`sessionId`) and SDD-02 (`model`); the worker passes `payload.sessionId`/`payload.model` through. Gate the worker's first tick on `HeadlessSession.hasRunner()` (`src/daemon/headless.ts:27`).
- **Runner wiring / abort caveat** — `Runner.wire` (`src/daemon/runner.ts:23`) sets the runner; the default executor ignores its abort argument (`_signal` unused, `src/daemon/runner.ts:46`), and `sdk.session.prompt` (`src/daemon/runner.ts:92`) is not cancellable today → basis for W-26 / FOLLOW-UP-1.
- **Telegram API** — reuse `sendMessage` chunking (`src/telegram/api.ts:22`) for the ack, and model the NEW `editMessageText` on `editMessageReplyMarkup` (`src/telegram/api.ts:58`) — same try/swallow shape, swallowing the "message is not modified" description.
- **Ingestion** — reuse `pollLoop`/`_offset` (`src/telegram/bot.ts:129,55`) and `handleMessage` slash routing (`src/telegram/bot.ts:161`). REPLACE the inline execution body of `processMessage` (`src/telegram/bot.ts:196-251`) and RETIRE `startProgressFeedback` (`src/telegram/bot.ts:261`) and the in-heap `ChatState` serialization queue (`src/telegram/bot.ts:30,186-193`).
- **Daemon wiring** — register the worker as a `SubsystemDef` (`src/daemon/lifecycle.ts:5`) in `serve.ts`. Note the current order hazard: the `telegram` subsystem (`src/cli/cmd/serve.ts:138`) initializes BEFORE the `http` subsystem that calls `Runner.wire` (`src/cli/cmd/serve.ts:151-156`), so today the poller can start before the runner is wired. This split fixes the hazard because ingestion now only enqueues; execution is gated on `hasRunner()`.
- **Commands** — add `/stop` to the `commands` array (`src/harness/commands.ts:46`) as a System-category `HarnessCommand`; slash commands route through `HarnessCommands.execute` (`src/harness/commands.ts:202`) BEFORE any enqueue (`src/telegram/bot.ts:161-173`), so `/stop` never becomes a job.

### New tables (`src/queue/queue.sql.ts`)

Declared here as the shared foundation. `telegram_session` is defined ONCE here and referenced (not re-declared, never ALTERed) by SDD-01/02/03. There is no separate `src/telegram/telegram.sql.ts` and no `20260719120000_telegram_session` migration; SDD-01/02/03 import the table from `src/queue/queue.sql.ts` and go through `TelegramStore`/`Queue`.

`telegram_session` (shared) — all columns nullable exactly as shown per SC-1, so `/new` can null `session_id` while preserving `persona` and `model_override`:
- `chat_id` text PRIMARY KEY
- `session_id` text NULL (the chat session's single storage home; `/new` sets it to NULL, the next message creates a fresh session and writes the id back per W-12a)
- `persona` text NULL (fall back to the config default persona when NULL)
- `model_override` text NULL (used/written by SDD-02; the column is declared here and never added by a separate ALTER — one agreed type: plain `text`, parsed to `{providerID, modelID}` by the data-access layer)
- `...Timestamps`
- index on `session_id`

`job_queue`:
- `id` text PRIMARY KEY (ulid)
- `kind` text NOT NULL — `"chat_message" | "subagent"`
- `status` text NOT NULL DEFAULT `'pending'` — `pending | claimed | running | done | error | canceled`
- `payload` text json NOT NULL — `{ prompt, persona?, timeoutMs?, sessionId?, model? }` (`sessionId`/`model` carry resume + SDD-02 model context into the worker, per SC-2)
- `result` text json NULL — `{ response, sessionId, toolCalls, durationMs }`
- `error` text NULL
- `chat_id` text NOT NULL, `ack_message_id` integer NULL, `reply_to_message_id` integer NULL (correlation; `ack_message_id` is NULL between the atomic enqueue and the post-commit ack send per SC-3, and stays NULL if a crash lost the ack send — see W-7a/W-17a)
- `parent_session_id` text NULL, `session_id` text NULL (written by the worker via `onSessionCreated`; SDD-03 reads it)
- `claimed_at` integer timestamp_ms NULL, `claimed_by` text NULL (lease)
- `attempts` integer NOT NULL DEFAULT 0
- `cancel_requested` integer boolean NOT NULL DEFAULT false
- `progress` text NULL, `progress_updated_at` integer timestamp_ms NULL
- `delivered` integer boolean NOT NULL DEFAULT false
- `...Timestamps`
- indexes on `status`, `chat_id`, `session_id`

`telegram_inbox`:
- `update_id` integer PRIMARY KEY
- `...Timestamps`

### New migration

`migration/20260719120000_telegram_queue/migration.sql` — the SINGLE migration that creates all three tables; timestamp `20260719120000` sorts after the latest existing migration (`20260420120000_tool_call_patterns`). There is NO competing `20260719120000_telegram_session` migration (SDD-01 no longer ships one) and NO `ALTER TABLE ... ADD COLUMN model_override` migration (SDD-02 no longer ships one, since the column is declared here), so there are no colliding timestamps, duplicate `CREATE TABLE`, or duplicate-column failures. Raw `CREATE TABLE` for all three tables with backtick-quoted identifiers, `--> statement-breakpoint` between statements, and `CREATE INDEX` statements for the indexes above. Match the drizzle column types in `queue.sql.ts` exactly (booleans as `integer ... DEFAULT false`, json as `text`, timestamps as `integer`, `ack_message_id` as `integer` NULL).

### New module `src/queue/queue.ts` (namespace `Queue`)

Pure data-access over the tables. All multi-statement mutations use `Database.transaction`; single reads use `Database.use`.
- `ingestChatMessage(updateId, input): { enqueued: boolean, jobId?: string }` — the SC-3 atomic ingestion primitive: inside ONE `Database.transaction({behavior:"immediate"})`, `INSERT ... onConflictDoNothing` the `update_id` into `telegram_inbox`; if `changes === 0` (duplicate) return `{ enqueued:false }` and enqueue nothing; otherwise insert a `pending` job (ulid id) with `payload` + correlation and `ack_message_id` NULL, and return `{ enqueued:true, jobId }`. Both writes are DB-only and share the synchronous transaction (no `await` inside), so they commit together (W-3). `inboxCheckAndInsert(updateId): boolean` remains for non-chat updates that dedup without enqueuing.
- `enqueue(input): jobId` — insert a `pending` job (ulid id) with payload + correlation (+ `parent_session_id` for subagent); used for `subagent` jobs and reused inside `ingestChatMessage`.
- `setAck(id, ackMessageId)` — write `ack_message_id` after the post-commit `sendMessage` succeeds (W-7); also usable by the delivery loop's null-ack path (W-17a).
- `claim(workerId, inFlightChatIds: string[]): Job | null` — `Database.transaction((tx)=>{...}, {behavior:"immediate"})`: select oldest `pending` (order by `time_created`) with the per-chat in-flight guard passed as a `WHERE chat_id NOT IN (:inFlightChatIds)` parameter (the worker supplies the current in-flight `chat_id` list; correct and reconstructable after restart since the list is empty on a fresh start), update to `claimed` with `WHERE id=? AND status='pending'`, set `claimed_at`/`claimed_by=workerId`, `attempts = attempts + 1`; return the row only if the guarded update changed a row, else `null`.
- `markRunning(id)`, `markDone(id, result)`, `markError(id, error)`, `markCanceled(id)` — status transitions with `time_updated`.
- `requestCancel(chatId)` — set `cancel_requested = true` for that chat's non-terminal jobs.
- `setSession(id, sessionId)` — write `job_queue.session_id` (called from `onSessionCreated`). The companion write to the chat's durable `telegram_session.session_id` is `TelegramStore.setSession(chatId, sessionId)` (the SDD-01 data-access module that reads/writes this same table); `onSessionCreated` calls both (W-12a).
- `setProgress(id, text)` — write `progress` + `progress_updated_at`.
- `markDelivered(id)` — set `delivered = true`.
- `derivePollOffset(): number | undefined` — `max(update_id)+1` or undefined (W-5).
- `recoverInterrupted(maxAttempts)` — the CC-6 sweep (W-27..W-30).
- `pendingDelivery(): Job[]` — terminal jobs with `delivered = false` (delivery loop source).

### New subsystem `src/queue/worker.ts` (namespace `JobWorker`)

Modeled on the scheduler drain/concurrency:
- State: `_activeJobs = new Map<string, Promise<void>>()`, `_cap` (= `scheduler.max_concurrent_user_tasks`, default 3), `_interval`, a per-chat in-flight `Set<string>` for CC-3.
- `start()`: run `Queue.recoverInterrupted(MAX_ATTEMPTS)` FIRST (W-27), then begin a `setInterval` tick; each tick and each `nudge()` calls `drain()`.
- `drain()`: while `_activeJobs.size < _cap` AND `HeadlessSession.hasRunner()` (W-16), call `Queue.claim(workerId)` skipping chats already in-flight (W-15 — the per-chat in-flight exclusion is passed into the claim, see below); on a claimed job, `markRunning`, run via `HeadlessSession.run({ prompt: payload.prompt, persona: payload.persona, timeoutMs: payload.timeoutMs, sessionId: payload.sessionId, model: payload.model, onSessionCreated:(sid)=>{ Queue.setSession(job.id, sid); if (job.chat_id) TelegramStore.setSession(job.chat_id, sid) } })` — passing `payload.sessionId`/`payload.model` through the run-chain (SC-2) and writing any NEW session id back to BOTH `job_queue.session_id` and the chat's `telegram_session.session_id` so SDD-01 resume is reachable (W-12/W-12a); the runner fires `onSessionCreated` only on creation, so a resumed session performs no write-back. On resolve `markDone`, on reject `markError`; check `cancel_requested` at checkpoints → `markCanceled` (W-25); in `finally` remove from `_activeJobs` + per-chat set and re-`drain()` (W-14).
- `nudge()`: exported; called by ingestion after `enqueue` and by nothing else needed for correctness (latency only).
- `stop()`: clear the interval, await in-flight with a bounded timeout (mirror `Scheduler.stop` `src/scheduler/scheduler.ts:148`).

### Ingestion changes (`src/telegram/bot.ts`)

- `pollLoop`: keep ONE `getUpdates` loop. For each accepted chat message, dedup + enqueue atomically via `Queue.ingestChatMessage(update.update_id, ...)` (skip when `enqueued === false`, i.e. duplicate — W-4); non-chat updates that only need dedup use `Queue.inboxCheckAndInsert`. Update `_offset` as an in-heap cache only; on `start`, seed `_offset` from `Queue.derivePollOffset()` (W-5).
- `processMessage`: DELETE the inline `HeadlessSession.run` + result/summary/`startProgressFeedback` body. Instead: read the chat's `telegram_session` row (via `TelegramStore`) for `session_id`, parsed `model_override`, and `persona`; then call `Queue.ingestChatMessage(update.update_id, { kind:"chat_message", payload:{ prompt: text, persona, timeoutMs, sessionId, model }, chat_id, reply_to_message_id })` which performs the inbox check-and-insert AND the job insert (with `ack_message_id` NULL) in ONE transaction (W-3, SC-3). AFTER that transaction commits, post the ack via `sendMessage`, and on success call `Queue.setAck(jobId, ackMessageId)` (W-7); finally call `JobWorker.nudge()` and return (W-7, W-8). Do NOT `sendMessage` before the transaction — the atomic commit is what guarantees no accepted update is lost on a crash (W-7a).
- Remove the `ChatState.processing`/`queue` serialization; per-chat ordering is now enforced by the worker's per-chat in-flight guard (W-15). The only retained in-heap state is caches reconstructable from the DB (CC-1).

### Delivery loop (`src/telegram/bot.ts`, owns the token)

- Started in `TelegramBot.start` alongside `pollLoop`, on a ~1–2s `setInterval`.
- Each pass: `Queue.pendingDelivery()`; for each job, format the terminal result (or cancellation/error). WHEN `ack_message_id` is non-NULL, `editMessageText(token, chat_id, ack_message_id, formatted)`; WHEN `ack_message_id` is NULL (a crash lost the ack send per W-7a), deliver via a fresh `sendMessage(token, chat_id, formatted)` instead (optionally `Queue.setAck` with the new id). Then `Queue.markDelivered(id)` (W-17, W-17a, W-18, W-19). Wrap each job's delivery in its own try/catch so one job's edit failure cannot block delivery of others.
- Progress: for undelivered non-terminal jobs with fresh `progress`, edit the ack message, debounced to ~1 edit / few seconds per chat (W-22). Track last-edit time per chat in an in-heap map (reconstructable; safe to lose).
- `JobWorker.nudge()` also triggers one immediate delivery pass (latency); the interval remains the backbone (W-20).

### API addition (`src/telegram/api.ts`)

Add `editMessageText(token, chatId, messageId, text)` modeled on `editMessageReplyMarkup` (`src/telegram/api.ts:58`): POST `editMessageText` with `{ chat_id, message_id, text, parse_mode: "Markdown" }`; catch and swallow the "message is not modified" error (idempotent re-edit per W-19).

### Command addition (`src/harness/commands.ts`)

Add `{ name: "stop", category: "System", description: "Cancel the current job for this chat", execute }`. Because ingestion routes slash commands through `HarnessCommands.execute` before enqueue (`src/telegram/bot.ts:161`), `/stop` calls `Queue.requestCancel(chatId)` (W-24). The chat id MUST be plumbed explicitly, not inferred: extend the command execution path to carry a context object bearing `chat_id` — change `HarnessCommand.execute` from `(args: string) => Promise<CommandResult>` (`src/harness/commands.ts:16`) to `(args: string, ctx: { chatId?: string }) => Promise<CommandResult>` and thread `ctx` through `HarnessCommands.execute(name, args, ctx)` (`src/harness/commands.ts:202`); ingestion passes `{ chatId }` from the update. Do NOT resolve "the active session" from a stateless registry — that is ambiguous under concurrent chats (advisory A2). Encode the W-26 caveat in the command's help text: "cancels and stops replying; the underlying computation may finish in the background."

### Subsystem registration order (`src/cli/cmd/serve.ts`)

Register a new `queue-worker` subsystem AFTER the `http` subsystem (`src/cli/cmd/serve.ts:151`) so `Runner.wire` has run and `HeadlessSession.hasRunner()` is true when `JobWorker.start()` runs. Its `stop()` calls `JobWorker.stop()`. The `telegram` subsystem (`:138`) may remain where it is because ingestion no longer executes; the worker's `hasRunner()` gate (W-16) is the belt-and-suspenders guard.

## VERIFY

Independent agents exercise these against a mocked-Telegram harness (fake `getUpdates`/`sendMessage`/`editMessageText`) and a real SQLite db (`:memory:` or temp file). Each maps 1:1 to WHAT.

- **V-1 (W-3,W-4 / CC-2):** Setup: feed the poller two updates with the SAME `update_id`. Action: run two poll iterations. Expected: `telegram_inbox` has one row; `job_queue` has exactly ONE job.
- **V-2 (W-7,W-8 / CC-4):** Setup: one text message; stub `HeadlessSession.run` to hang. Action: deliver the message. Expected: the inbox row and a `pending` job are committed atomically, then an ack `sendMessage` is recorded and `ack_message_id` is set via `setAck`, AND `processMessage` returns before `HeadlessSession.run` resolves.
- **V-2a (W-3,W-7,W-7a,W-17a / SC-3):** Setup: one text message; make the `sendMessage` ack throw (or drop it) to simulate a crash AFTER the atomic commit but before/at the ack send. Action: run ingestion, then start the worker + delivery loop. Expected: after the throw, `telegram_inbox` has the `update_id` AND `job_queue` has one `pending` job with `ack_message_id` NULL; the poll offset is `max(update_id)+1` (consistent, no redelivery needed); the job runs to terminal and the delivery loop delivers it via a fresh `sendMessage` (NOT `editMessageText`), setting `delivered=true`. No accepted message is lost. Companion: simulate a crash BEFORE the atomic commit (throw inside/around the transaction) and assert the `update_id` is NOT in the inbox, so Telegram redelivers it (at-least-once) and exactly one job is eventually created.
- **V-3 (W-10,W-12,W-17 / CC-5):** Setup: enqueue one job (with a non-NULL `ack_message_id`); stub the runner to return a known response. Action: start `JobWorker` + delivery loop. Expected: `job_queue.session_id` is set (via `onSessionCreated`), status → `done`, and the ack message is delivered by an `editMessageText` (not a new `sendMessage`), `delivered=true`.
- **V-3a (W-12,W-12a / SC-2):** Setup: a chat with a `telegram_session` row whose `session_id` is NULL, `model_override` set; enqueue its chat_message job (payload carries `model`, no `sessionId`); stub the runner to create a NEW session (fire `onSessionCreated(sid)`) and to capture the `model` it received. Action: drain. Expected: the runner received `payload.model`; the new `sid` is written to BOTH `job_queue.session_id` AND the chat's `telegram_session.session_id` (via `TelegramStore.setSession`), so a subsequent message for that chat enqueues with `payload.sessionId = sid` (resume reachable). Second setup: a chat whose `telegram_session.session_id` is already set → payload carries `sessionId`; stub the runner to RESUME (do NOT fire `onSessionCreated`). Expected: no write-back occurs and `telegram_session.session_id` is unchanged.
- **V-4 (W-10,W-11):** Setup: one `pending` job; invoke `Queue.claim` twice concurrently (two worker ids). Expected: exactly one claim returns the job; the other returns `null`; the job runs once (guarded `WHERE ... status='pending'`).
- **V-5 (W-15 / CC-3):** Setup: two messages for the same `chat_id`; cap ≥ 2. Action: drain. Expected: they run one at a time in enqueue order; never two jobs for that chat concurrently.
- **V-6 (W-27,W-28,W-30 / CC-6):** Setup: insert a job in `running` with `attempts=0`; simulate restart by calling `JobWorker.start`. Expected: job re-queued to `pending` (lease cleared); it then runs and delivers. Repeat with `attempts=MAX_ATTEMPTS` → job marked `error` and error delivered to the ack message.
- **V-7 (W-18,W-19 / CC-5):** Setup: insert a `done` job with `delivered=false`; start only the delivery loop (simulating a crash after completion, before delivery). Expected: it is delivered exactly once; running the pass again edits idempotently and the "message is not modified" error is swallowed (no throw).
- **V-8 (W-24,W-25,W-26):** Setup: a running job for a chat; stub the runner to poll `cancel_requested` at a checkpoint. Action: `/stop`. Expected: `cancel_requested=true`, job → `canceled`, delivery reports cancellation, result suppressed. Documented (not asserted as killed): the stubbed computation may continue — assert only that its late result does NOT overwrite the `canceled` status.
- **V-9 (W-21,W-22,W-23 / CC-7):** Setup: a job writing progress rapidly. Action: run the delivery loop. Expected: progress reflected by EDITING the single ack message; edits debounced to ≤ ~1 / few-seconds per chat; NO extra `sendMessage` progress posts.
- **V-10 (W-5,W-6 / CC-2):** Setup: inbox rows with `update_id` 10,11,12; restart the poller with no in-heap offset. Expected: first `getUpdates` uses offset 13 (`max+1`).
- **V-11 (W-16):** Setup: `HeadlessSession.hasRunner()` false. Action: fire a worker tick. Expected: no job claimed; once `Runner.wire` runs and `hasRunner()` is true, the next tick claims.
- **V-12 (W-31,W-29):** Setup: enqueue a `subagent` job with a valid `parent_session_id`; then one whose parent no longer exists, and recover. Expected: valid one runs; orphaned one → `error` delivered to the correlated chat.
- **V-13 (W-1 / migration):** Setup: fresh db. Action: boot. Expected: `20260719120000_telegram_queue` applies cleanly; all three tables + indexes exist; re-boot is idempotent.
- **V-13a (W-1a / SC-1):** Static check across `migration/**`: exactly ONE `CREATE TABLE telegram_session` (and one each for `job_queue`, `telegram_inbox`) exists; no `ALTER TABLE telegram_session ... ADD COLUMN` (e.g. `model_override`) exists; no two migration directories share the `20260719120000` timestamp. Then boot the FULL spec suite's migrations and assert no duplicate-table, duplicate-column, or colliding-timestamp error occurs. Confirm `telegram_session.session_id`, `persona`, and `model_override` are all NULLable (so `/new` can null the session while preserving model/persona).
- **V-14 (build/regression / CC-9):** `bun run typecheck` passes and `bun test` is fully green, including the new queue/worker/delivery tests. No pre-existing test is left red.

### Flagged follow-up

- **FOLLOW-UP-1 (real abort):** Thread an `AbortSignal` from `HeadlessSession.run` through `Runner`'s default executor into `sdk.session.prompt` so `/stop` actually halts computation (today `runner.ts` `_signal` is ignored). Out of scope here; required before `/stop` can claim to "kill" work rather than "suppress."
