# SDD-01: Durable Per-Chat Sessions with Resume

**Date:** 2026-07-19
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `docs/specs/260719_telegram_sdd-00-master.md`
**Depends on:** the shared `telegram_session` table and the `HeadlessSession` run-chain `sessionId` parameter, **both owned and defined by SDD-04** (SDD-00 Dependency Order item 1; Shared Contract SC-1 and SC-2). SDD-01 REFERENCES the table (via the `TelegramStore` data-access module it owns) and CONSUMES the run-chain `sessionId` parameter; it does not define either.

This feature spec makes one **chat session** (SDD-00 glossary) durable per **chat**, reused across messages so context accrues, and resettable with `/new`. It refines SDD-00 and inherits all cross-cutting requirements (CC-1..CC-10) and the security invariant (SEC-1..4). Where this document conflicts with the master, the master wins; in particular the Shared Contract (SC-1..SC-5) is authoritative.

## Background (why this is a reuse, not a build)

Durable resume already works for the TUI/web path and is **not** re-implemented here. The prompt run loop rebuilds the full conversation context from SQLite on every turn:

- `runLoop` (`src/session/prompt.ts:1305`) calls `MessageV2.filterCompactedEffect(sessionID)` (`src/session/prompt.ts:1317`) at the top of each iteration, reconstructing the message stream (including compaction boundaries) directly from the `message`/`part` tables (`src/session/session.sql.ts:47,61`).
- Model continuity is likewise recovered from stored history: `lastModel(sessionID)` (`src/session/prompt.ts:912`) reads the last user message's model, and `createUserMessage` resolves `input.model ?? ag.model ?? lastModel(...)` (`src/session/prompt.ts:929`).

Therefore calling `sdk.session.prompt({ sessionID })` against an **existing** session id auto-resumes with full history plus auto-compaction. **No session persistence is built.** This spec only persists and reuses a stored `session_id` per chat: ingestion contributes the stored id to the enqueued job's `payload.sessionId` and the SDD-04 **worker** threads it into the existing choke point (`src/daemon/runner.ts:92`), writing a newly created id back via `onSessionCreated` (SC-2).

The current bot does the opposite: `buildDefaultExecutor` unconditionally calls `sdk.session.create` (`src/daemon/runner.ts:74`) for every message, and `processMessage` fakes continuity with a 500-char summary (`src/telegram/bot.ts:230`) held in an in-memory `ChatState` under a 30-minute TTL (`src/telegram/bot.ts:203-207`), then deletes the session→chat mapping in `finally` (`src/telegram/bot.ts:226`). All of this is replaced.

---

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL` tokens are machine-checkable. Cross-cutting references in parentheses.

1. **WHEN** a chat message is accepted and the chat has **no** stored `session_id`, ingestion (`processMessage`) **SHALL** enqueue a job whose `payload.sessionId` is undefined (plus `payload.persona` and, if set, `payload.model` from `model_override`), and the **worker** **SHALL** create exactly one new FoxyBear session, run the prompt against it, and — via `onSessionCreated` — persist the new id back to **both** `job_queue.session_id` and the chat's `telegram_session.session_id` before the job reaches a terminal state. (CC-1, SC-2)

2. **WHEN** a chat message is accepted and the chat **has** a stored `session_id` that still exists, ingestion **SHALL** set `payload.sessionId` to that stored id, and the **worker** **SHALL** run the prompt against that existing session id via `sdk.session.prompt` (resume) and **SHALL NOT** create a new session. `onSessionCreated` **SHALL NOT** fire on resume, so no write-back occurs. Context from prior turns in that chat **SHALL** be visible to the model on the new turn. (CC-1, SC-2)

3. **WHEN** a chat message is accepted and the chat has a stored `session_id` that **no longer exists** (deleted or never resolvable), the **worker** **SHALL** self-heal by creating a new session, running the prompt against it, and — via `onSessionCreated` — overwriting the stored mapping in both `job_queue.session_id` and `telegram_session.session_id` with the new `session_id`. The user **SHALL** receive a normal response, not an error. (CC-1, SC-2)

4. **WHEN** a turn completes (success or error), the system **SHALL NOT** delete or clear the chat's stored `session_id`. The mapping persists across turns and across daemon restarts. (CC-1)

5. **WHEN** the daemon restarts and a chat that had a stored `session_id` sends its next message, ingestion **SHALL** read that id back from SQLite into `payload.sessionId` and the worker **SHALL** resume that same stored `session_id` (subject to requirement 3 if it was deleted while down). No conversation identity may be reconstructed from process memory. (CC-1, SC-2)

6. **WHEN** the user sends `/new` in a chat, the system **SHALL** set that chat's stored `session_id` to **NULL** while **preserving** `model_override` and `persona` (so the very next message enqueues a job with `payload.sessionId` undefined and the worker starts a fresh session per requirement 1, writing the new id back) and **SHALL** confirm the reset to the chat. `/new` **SHALL NOT** delete the underlying FoxyBear session rows; it only unbinds the chat. `/new` is chat-scoped. (SC-1, SC-2)

7. **WHEN** the user sends `/resume <id>` in a chat and `<id>` names an existing FoxyBear session, the system **SHALL** validate the session exists, then bind that chat to `<id>` (overwriting any current mapping) and confirm the bind. **WHEN** `<id>` is missing or names no existing session, the system **SHALL** reject the command with a usage/not-found message and **SHALL NOT** change the existing mapping. `/resume` is chat-scoped.

8. **WHEN** two or more messages for the **same** chat are in flight, the system **SHALL** apply them to that chat's session strictly in arrival order and **SHALL NOT** run two prompts against the same `session_id` concurrently. Per-chat ordering is enforced by the SDD-04 durable queue/worker (the worker serializes claims per `chat_id`); SDD-01 relies on that seam and adds no parallel ordering mechanism. (CC-3, CC-10)

9. **WHEN** messages for **different** chats are in flight, the system **MAY** process them concurrently; per-chat serialization **SHALL NOT** block unrelated chats. (CC-3)

10. **WHEN** a chat's session grows large enough to trigger compaction, the system **SHALL** rely on the existing auto-compaction in the prompt run loop and **SHALL NOT** add any Telegram-side truncation, summary prepending, or TTL. The legacy 500-char summary and 30-minute TTL **SHALL** be removed. (CC-10)

11. **WHEN** `/new` or `/resume` is issued, the system **SHALL** dispatch it in the Telegram command layer (which has `chatId`, `TelegramStore`, and the SDK in scope) and **SHALL NOT** route it through the shared `HarnessCommands` registry. Rationale: these are per-chat session-mutating operations that read/write the chat's `TelegramStore` row and validate sessions via the SDK, which belongs in the bot layer. (Note: SDD-04 W-24 extends `HarnessCommand.execute` with a `ctx: { chatId? }` so the registry CAN receive `chatId` for `/stop`; `/new`/`/resume` are kept local because they mutate this chat's session mapping, not because the registry lacks `chatId`.) (CC-10)

12. **WHEN** the executor resolves the effective model for the persona, the model policy choke point owned by SDD-02 **SHALL** remain the single point of enforcement; this spec **SHALL NOT** route around SEC-1. (SEC-1, CC-8) The `model_override` column is declared by SDD-04 (SC-1) and written only by SDD-02.

---

## HOW

Implementation approach, FoxyBear best practices, explicit reuse map. No new mechanism where an existing one fits (CC-10).

### Shared table `telegram_session` — REFERENCED, not defined here (SC-1)

Per master **SC-1**, the `telegram_session` table is defined **exactly once** by SDD-04 in `src/queue/queue.sql.ts` and the single migration `migration/20260719120000_telegram_queue/migration.sql`. SDD-01 issues **no** `CREATE TABLE`/`ALTER TABLE`/`snapshot.json` and adds **no** `src/telegram/telegram.sql.ts`. It reaches the table only through the `TelegramStore` data-access module (below).

The SDD-04-owned schema SDD-01 depends on (authoritative form in SC-1):
- `chat_id` TEXT PRIMARY KEY — one row per chat (the unit of session identity per the glossary).
- `session_id` TEXT **NULL** — nullable per SC-1 so `/new` is a clear (`setSession(chatId, null)`), and requirement 1's "no stored session" state is `row absent OR session_id IS NULL`. This nullability is required by SDD-01 and guaranteed by SC-1.
- `persona` TEXT NULL — falls back to the config default persona when NULL.
- `model_override` TEXT NULL — declared once by SDD-04 (per SC-1); written only by SDD-02.
- `...Timestamps`, plus an index on `session_id` for reverse lookup (`getBySession`), which SDD-03's question bridge needs to walk from a `job_queue.session_id` back to the chat.

### New file: `src/telegram/store.ts` (namespace `TelegramStore`)

SDD-01 **does** own this data-access module, which operates on the SDD-04-owned `telegram_session` table (importing `TelegramSessionTable` from SDD-04's `src/queue/queue.sql.ts`). Reuses `Database.use`/`Database.transaction` (`src/storage/db.ts:130,155`) and drizzle `eq` (imported as in `src/scheduler/scheduler.ts:2`). API surface:

- `getByChat(chatId): TelegramSessionRow | undefined` — `Database.use(db => db.select().from(TelegramSessionTable).where(eq(...chat_id, chatId)).get())`.
- `getBySession(sessionId): TelegramSessionRow | undefined` — reverse lookup via the `session_id` index (used by SDD-03).
- `upsert(chatId, fields)` — insert-or-update the row; used to create the mapping and to set persona.
- `setSession(chatId, sessionId | null)` — bind (requirement 1/3/7) or clear (requirement 6). Clearing is `setSession(chatId, null)`.
- `clearSession(chatId)` — convenience for `/new`; equivalent to `setSession(chatId, null)`.
- `setModel(chatId, modelOverride | null)` — declared here, written by SDD-02.

**Instance-context handling.** `Database.use`/`transaction` need instance context, but both have a `LocalContext.NotFound` fallback that opens the process-global DB client directly (`src/storage/db.ts:134-139` and `164-169`). The DB path is a process-global singleton, not instance-scoped (`src/storage/db.ts:38`, `Global.Path.data`). Therefore:
- Store **write-back on session creation** happens inside the worker-supplied `onSessionCreated` callback (per SC-2), which fires within `buildDefaultExecutor`'s `Instance.provide` body (`src/daemon/runner.ts:56`) — full context, effects flushed normally.
- Store **reads from ingestion** (`processMessage` lookup before enqueue) and **reads/writes from the Telegram command layer** (`/new`, `/resume`) run outside instance context and rely on the documented `NotFound` fallback. `TelegramStore` functions therefore make plain `Database.use`/`Database.transaction` calls with no assumption of an ambient instance, and are safe from both call sites. Do **not** introduce a second DB path or a bespoke connection.

### Consume the `sessionId` run-chain parameter (owned by SDD-04, per SC-2)

The run-chain plumbing — optional `sessionId`/`chatId`/`model` on `HeadlessSession.run`, the `SessionRunner` type, `Runner.SessionExecutor.execute`, the `Runner.wire` adapter, and the resume/create branch in `buildDefaultExecutor` — is **owned and added once by SDD-04** (SC-2). SDD-01 does **not** edit `headless.ts`/`runner.ts` to add these signatures; it CONSUMES the `sessionId` parameter. This subsection documents the SDD-04 behavior SDD-01 relies on so the requirements are self-contained:

- `HeadlessSession.run` accepts optional `sessionId?: string` and `chatId?: string` (added by SDD-04 at `src/daemon/headless.ts:31-36`), threaded through the `SessionRunner` type (`src/daemon/headless.ts:12-17`), `Runner.SessionExecutor.execute` (`src/daemon/runner.ts:9-16`), and the `Runner.wire` adapter (`src/daemon/runner.ts:25-29`).
- `buildDefaultExecutor` (`src/daemon/runner.ts:44`) branches inside the `Instance.provide` body (`src/daemon/runner.ts:56`):
  - If `sessionId` is provided **and still exists**, skip `sdk.session.create`, use the provided id directly, and call `sdk.session.prompt({ sessionID })` (`src/daemon/runner.ts:92`) — resume. `onSessionCreated` does **not** fire.
  - Existence is probed via `sdk.session.messages` (proven to exist at `src/daemon/runner.ts:101`): a thrown error or empty/not-found result means the id is gone. (`sdk.session.get` is not relied upon; use `sdk.session.messages` as the concrete probe.)
  - Else call `sdk.session.create` (`src/daemon/runner.ts:74`) as today and fire `onSessionCreated(sessionID)` (`src/daemon/runner.ts:80`) so the **worker's** callback persists the new mapping.
  - A stale/deleted provided id falls through to the create branch (self-heal, requirement 3) and fires `onSessionCreated` with the new id.

  Persona attach/clear (`src/daemon/runner.ts:82-88,124-126`) is unchanged and applies to both branches.

### Ingestion (`processMessage`) contributes resume context; the worker writes back (SC-2)

After the SDD-04 split, ingestion does **not** call `HeadlessSession.run` inline. `processMessage` (`src/telegram/bot.ts:196-251`) becomes an enqueue path:

- Before enqueue: `const row = TelegramStore.getByChat(chatId)`; contribute to the job payload `sessionId: row?.session_id ?? undefined` (the durable resume seam), `model: row?.model_override` parsed (written by SDD-02), and `persona: row?.persona ?? <config default>`. The full payload shape is SC-2's `{ prompt, persona?, timeoutMs?, sessionId?, model? }`. Ingestion enqueues into `job_queue` (SDD-04), posts the ack, and returns — it never executes the prompt.
- The **worker** (SDD-04 `JobWorker.drain`) passes `payload.sessionId` (and `payload.model`) into `HeadlessSession.run` and supplies `onSessionCreated:(sid) => { Queue.setSession(job.id, sid); if (job.chat_id) TelegramStore.setSession(job.chat_id, sid) }`. Because the runner fires `onSessionCreated` **only** when it creates a NEW session (not on resume), a fresh chat session id is persisted to **both** `job_queue.session_id` and `telegram_session.session_id`; a resumed session needs no write-back. This covers requirement 1 (fresh) and requirement 3 (self-heal overwrite). (SC-2)
- **Delete** the TTL/summary block (`src/telegram/bot.ts:201-207`), the summary write (`src/telegram/bot.ts:229-230`), and the in-`finally` `_sessionToChat.delete` (`src/telegram/bot.ts:226`). The mapping must persist (requirement 4). `_sessionToChat`/`_chatStates` session fields (`lastSessionTime`, `lastSessionSummary`) and `session_ttl_ms` config are removed; residual `ChatState` fields (e.g. `awaitingCustomAnswer`) are retained only as SDD-04's ingestion/worker split requires.

### Per-chat ordering (CC-3)

Per-chat ordering is enforced by the **SDD-04 durable queue and worker**: ingestion enqueues in arrival order and the worker serializes claims per `chat_id`, guaranteeing requirement 8 (one prompt per chat's `session_id` at a time) while allowing requirement 9 (different chats proceed concurrently up to the worker concurrency cap). SDD-01 adds **no** parallel ordering mechanism of its own (CC-10; avoid the glossary's forbidden "lock"). The durable identity (the `session_id`) is what survives restart (CC-1); ordering is the queue's responsibility, owned by SDD-04.

### `/new` and `/resume` command dispatch (chat-scoped)

Handle both in the Telegram slash dispatch in `handleMessage` (`src/telegram/bot.ts:160-173`), **before** the `HarnessCommands.execute` fallback and returning early so they never reach the registry. They are chat-scoped per-chat session operations handled where `chatId`, `TelegramStore`, and the SDK are in scope. (SDD-04 W-24 adds a `ctx: { chatId? }` to `HarnessCommand.execute` for `/stop`, so the registry does carry `chatId`; `/new`/`/resume` are kept local because they mutate this chat's session mapping and validate sessions via the SDK — bot-layer concerns — not because the registry cannot receive `chatId`.) Behavior:

- `/new`: `TelegramStore.setSession(chatId, null)` (equivalently `clearSession(chatId)`), which sets `session_id` to NULL while **preserving** the row's `model_override` and `persona`; reply e.g. "Started a fresh session. Your next message begins a new conversation." The next message enqueues with `payload.sessionId` undefined and the worker writes the new id back. (requirement 6, SC-1/SC-2)
- `/resume <id>`: parse `<id>` from the args; validate the session exists via the SDK by probing `sdk.session.messages(<id>)` (the proven method at `src/daemon/runner.ts:101`; a thrown error or empty/not-found result means it does not exist) inside an `Instance.provide` body (reuse the executor's provide pattern, `src/daemon/runner.ts:56`, or a small shared helper). If it exists, `TelegramStore.setSession(chatId, id)` and confirm; else reply usage/not-found and leave the mapping untouched (requirement 7). Register both in `HarnessCommands.helpText()`-style local help so `/help` still lists them, but keep execution local.

### What is explicitly NOT built

- No session persistence layer (reused, see Background).
- No shared-table definition or migration (SC-1: `telegram_session` is owned by SDD-04; SDD-01 only adds the `TelegramStore` data-access module over it).
- No run-chain signature edits (SC-2: the `sessionId`/`chatId`/`model` plumbing is added once by SDD-04; SDD-01 consumes `sessionId`).
- No model-policy enforcement (SDD-02 owns SEC-1; the `model_override` column is written only by SDD-02).
- No durable job queue / worker / ack routing (SDD-04 owns the queue, the worker, per-chat ordering, and delivery). SDD-01 relies on that seam.
- No question-relay changes (SDD-03).

---

## VERIFY

Acceptance criteria for independent agents, exercising full functionality against a **mocked Telegram harness** (a fake `getUpdates`/`sendMessage`/`sendMessageWithKeyboard` transport that records outbound calls and lets the test inject inbound updates) driving the full ingestion -> durable `job_queue` -> **worker** path (SDD-04), backed by a real temporary SQLite DB so durability is genuinely exercised. Because ingestion no longer executes inline (SC-2), every resume/create assertion below is observed **after the worker drains the job**, not synchronously from `processMessage`. Each item is mapped 1:1 to WHAT requirements. Every scenario states setup, action, expected observable.

- **V1 — new session persists via worker write-back (req 1, SC-2).** Setup: empty `telegram_session`, mocked bot + worker started, executor stubbed to echo its resolved `sessionId`. Action: inject message "A" to chat 100 and let the worker drain the job. Expected: the enqueued job's `payload.sessionId` is undefined; exactly one `sdk.session.create`; the worker's `onSessionCreated` writes the new id to **both** `job_queue.session_id` and `telegram_session.session_id`; after the drain, `TelegramStore.getByChat("100").session_id` is non-null and equals the id the worker ran against.

- **V2 — reuse/resume accrues context through the worker (req 2, SC-2).** Setup: continue from V1. Action: inject message "B" to chat 100 and drain. Expected: ingestion set `payload.sessionId` to the stored id; **zero** additional `sdk.session.create`; `onSessionCreated` did **not** fire on this (resume) job; both prompts targeted the **same** `session_id`; the message stream for that session (via `sdk.session.messages`) contains both "A" and "B" in order — i.e. the second turn sees the first's context.

- **V3 — self-heal on stale id (req 3, SC-2).** Setup: seed `telegram_session` for chat 200 with a `session_id` that does not exist in the session tables. Action: inject a message to chat 200 and drain. Expected: the worker's resume probe (`sdk.session.messages`) fails/returns empty, it creates a new session, fires `onSessionCreated`; the user gets a normal (non-error) reply; `getByChat("200").session_id` is now the new id (overwritten in both tables), and the old id is gone.

- **V4 — mapping survives job completion (req 4).** Setup: V1/V2 state. Action: drive a job to each terminal state (success, and a forced executor error). Expected: in **both** cases `getByChat` still returns the same non-null `session_id` after the job terminates; no code path deletes the row on completion.

- **V5 — restart resumes stored session (req 5, CC-1).** Setup: run V1 to persist chat 300's mapping; capture the `session_id`. Action: call `TelegramBot._reset()` (drops all in-memory state) and re-`start()` the bot + worker pointing at the **same** DB, then inject a new message to chat 300 and drain. Expected: no `sdk.session.create`; ingestion read the pre-restart `session_id` back from SQLite into `payload.sessionId` and the worker resumed it.

- **V6 — `/new` nulls the session, next message starts fresh (req 6, SC-1/SC-2).** Setup: chat 400 has a persisted `session_id` S1 (and a `model_override`/`persona` set). Action: inject `/new` then a normal message and drain. Expected: `/new` reply confirms reset and does **not** reach `HarnessCommands.execute`; after `/new`, `getByChat("400").session_id` is NULL **while `model_override` and `persona` are preserved**; the following message enqueues with `payload.sessionId` undefined, the worker creates exactly one new session S2 ≠ S1 and writes it back. Assert the underlying S1 session rows still exist (only unbound).

- **V7 — `/resume <id>` validates then binds, rejects missing (req 7).** Setup: create a real session S3 out of band; chat 500 bound to S1. Action A: `/resume S3` -> command validates S3 exists (via `sdk.session.messages`), reply confirms, `getByChat("500").session_id == S3`. Action B: `/resume S_nonexistent` -> reply is not-found/usage, `getByChat("500").session_id` unchanged (still S3). Action C: `/resume` with no arg -> usage reply, no change. Assert none of these reached `HarnessCommands.execute`.

- **V8 — per-chat ordering, no concurrent same-session prompt (req 8, CC-3).** Setup: worker executor instrumented to record entry/exit and to block on a gate. Action: inject "A" then "B" to chat 600 while the worker holds "A" at the gate. Expected: the worker does not claim/run "B" for chat 600 concurrently; at no point are two executor invocations for chat 600 active simultaneously; after releasing the gate, "A" then "B" run in that order against the same `session_id` (per-chat serialization is the SDD-04 worker's).

- **V9 — cross-chat concurrency not blocked (req 9, CC-3).** Setup: worker gate as in V8. Action: inject a message to chat 700 and, while it is blocked at the gate, a message to chat 701. Expected: the worker runs chat 701's job without waiting for chat 700 (up to the concurrency cap), each against its own `session_id`.

- **V10 — no TTL/summary/truncation remains (req 10, CC-10).** Static + behavioral: grep confirms `session_ttl_ms`, `lastSessionSummary`, `lastSessionTime`, and the `[Previous session context: ...]` prefix are gone from `bot.ts`. Behavioral: send two messages > any old TTL apart (advance the clock) to the same chat and assert the same `session_id` is still reused (continuity now comes from the durable session, not the summary).

- **V11 — chat-scoped commands bypass the registry (req 11).** Assert (via a spy on `HarnessCommands.execute`) that `/new` and `/resume` never invoke it, while a genuine registry command that is NOT chat-scoped (e.g. `/peers`) still does. Note: `/status` and `/model` are chat-scoped (owned by SDD-02) and are also intercepted before the registry, so they are not valid "registry" examples here. Confirms the dispatch ordering in `handleMessage`.

- **V12 — security choke point untouched (req 12, SEC-1/CC-8).** Assert this feature adds no model resolution of its own: the executor still resolves the model through the same path (`src/daemon/runner.ts:91`, and downstream `createUserMessage`/`lastModel` at `src/session/prompt.ts:918,912`). No test here selects a model; SDD-02 owns SEC verification. This item guards against regression only.

- **V13 — build/regression green (CC-9).** `bun run typecheck` passes and `bun test` is fully green, including the new `store`/`bot` tests above and the untouched scheduler/session suites. A feature is not done with any red test.
