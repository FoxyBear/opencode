# SDD-03: Question / Sub-Agent Relay

**Date:** 2026-07-19
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Model tier:** authored at Opus tier
**Master:** `docs/specs/260719_telegram_sdd-00-master.md` (this spec refines it; where they conflict, the master wins)

This spec fixes the broken sub-agent / question relay: the `question` tool never reaches Telegram, so the tool blocks until the session timeout and sub-agent dispatch "does not work at all." It deletes the dead Layer B global registry, wires a single daemon-side question bridge, and correlates questions back to the originating chat durably and sub-session-aware.

## Context: the two-layer break

Confirmed by reading the code:

- **Layer A** is the working producer. `Question.Service.ask` (`packages/opencode/src/question/index.ts:131`) creates a `QuestionID`, parks on an Effect `Deferred` (`:140`), publishes Bus `Event.Asked` (`:148`), and returns the answers when the Deferred is succeeded by `Question.Service.reply` (`:158`). The `question` tool calls exactly this: `question.ask(...)` (`packages/opencode/src/tool/question.ts:25`). The TUI answers through the REST endpoint `POST /question/:requestID/reply`, whose handler runs `Question.Service.reply` on `AppRuntime` (`packages/opencode/src/server/instance/question.ts:60-72`). This whole path is proven in production by the GUI.
- **Layer B** is a dead in-heap registry in the same file: `globalRegister/globalUnregister/globalList/globalReply/globalReject` over `_globalPending`/`_globalDeferreds` (`packages/opencode/src/question/index.ts:202-235`). Telegram polls it every 2s (`pollPendingQuestions` -> `Question.globalList()`, `packages/opencode/src/telegram/bot.ts:293-294`) and answers it (`Question.globalReply`, `bot.ts:409`).
- **The bridge is missing.** `globalRegister()` has zero callers (grep confirms only `question/index.ts` defines it). The producer writes Layer A; the consumer reads Layer B; nothing copies A into B, so `globalList()` is always empty. No question is ever relayed, and the tool's `Deferred` stays parked until `HeadlessSession.run`'s timeout (`packages/opencode/src/daemon/headless.ts:47-52`).

The fix is a hybrid built from the two proven halves: subscribe to `Event.Asked` (Layer A inbound) and reply through the same runtime path the REST endpoint uses — `Question.Service.reply` on `AppRuntime` run inside a directory-scoped `Instance.provide` (Layer A outbound). The `Instance.provide` wrap is essential: `Question.Service` state is instance-scoped by `directory`, and the REST endpoint only works because its middleware supplies that context (SC-5). Layer B is removed entirely.

## WHAT

Requirements use the literal tokens `WHEN` and `SHALL`. Cross-cutting IDs (CC-n) are defined in SDD-00.

- **QR-1.** WHEN the daemon starts the Telegram bot, the system SHALL register exactly one daemon-side `Bus.subscribe(Question.Event.Asked, handler)` as the inbound half of the question bridge, and SHALL NOT start any timer that polls Layer B. The 2s poller (`startQuestionPoller`, `pollPendingQuestions`) and its handle (`_questionPollTimer`) SHALL be deleted (CC-10).

- **QR-2.** WHEN `Question.Service.ask` publishes `Event.Asked` for a request, the bridge handler SHALL resolve the originating chat for the request's `sessionID` via durable correlation (QR-3), and, if a chat is found, SHALL deliver the request's first question to that chat as an inline keyboard through the existing `sendQuestionKeyboard`. It SHALL send only the first question at this point (QR-5).

- **QR-3.** WHEN the bridge resolves the chat for a question's `sessionID`, the system SHALL consult the durable correlation (the `telegram_session` table from SDD-01 and/or `job_queue.session_id` from SDD-04), and SHALL NOT read the deleted in-heap `_sessionToChat` map (CC-1). WHEN the `sessionID` is a child session with no direct chat mapping, the system SHALL walk `SessionTable.parent_id` (`packages/opencode/src/session/session.sql.ts:24`, index `session_parent_idx`) upward, up to a bounded hop limit, until it finds a chat-owning ancestor session; a question from a sub-agent SHALL thus route to the chat that originated the top-level request, across the poller/worker boundary and across restarts. WHEN the worker creates a session, `onSessionCreated` (SC-2) persists the new `session_id` to BOTH `job_queue.session_id` and the chat's `telegram_session.session_id` at session CREATION, before `sdk.session.prompt` runs (`packages/opencode/src/daemon/runner.ts:80` precedes `:92`) and therefore before any `question` tool can fire; the chat correlation is thus durably committed by the time any question is asked and there is NO race. For a sub-agent/child session, correlation does not depend on the child's own `session_id` being persisted first: it resolves through the already-durable ancestor `telegram_session`/`job_queue.session_id` mapping via the bounded `SessionTable.parent_id` chain.

- **QR-4.** WHEN a question originates from a session that has no chat-owning ancestor within the hop limit (for example a scheduler-origin or mesh-origin session, which are created without an `onSessionCreated` chat mapping), the system SHALL NOT relay the question to any chat and SHALL NOT throw. The question remains parked on its Layer A `Deferred` and resolves only through its own tool/session timeout, exactly as before this feature existed (no regression, no crash).

- **QR-5.** WHEN a single request contains multiple questions, the system SHALL send them one at a time, sending question `n+1` only after question `n` is answered. Multi-question progression SHALL be tracked in the in-memory `_pendingQuestions` map keyed by `requestID` (acceptable in-heap state, because a question is live only while its `Deferred` is parked; see QR-10).

- **QR-6.** WHEN the user taps the "Type your answer" button for a question, the system SHALL record `awaitingCustomAnswer` for that chat and question index, and SHALL treat the next inbound text message from that chat as the free-text answer for that question index (routing it into `submitQuestionAnswer`), rather than as a new prompt.

- **QR-7.** WHEN all answers for a request are collected in `submitQuestionAnswer`, the system SHALL succeed the parked Layer A `Deferred` by invoking `Question.Service.reply` via `AppRuntime`, and SHALL NOT call `Question.globalReply`. This call SHALL run inside a directory-scoped `Instance.provide({ directory: process.cwd(), init: () => AppRuntime.runPromise(InstanceBootstrap), fn })` context (SC-5, QR-13), matching the tool's instance so `InstanceState.get` resolves the same directory-keyed `pending` map the tool parked its `Deferred` on. A bare `AppRuntime.runPromise(Question.Service.use((svc) => svc.reply(...)))` from the Telegram process or the `Bus.subscribe` fiber SHALL NOT be used: it carries no ambient Instance ALS context, `InstanceState.get` throws `LocalContext.NotFound`, and the parked `Deferred` is never succeeded. As a result of the correctly-scoped reply the `question` tool's `question.ask` SHALL return the chosen answers and the session SHALL continue (CC-10).

- **QR-8.** WHEN a callback query or free-text answer references a `requestID` that is unknown or expired (no `_pendingQuestions` entry, or `Question.Service.reply` finds no pending request and logs a warning per `packages/opencode/src/question/index.ts:161`), the system SHALL handle it gracefully: acknowledge the Telegram callback, optionally inform the chat the question expired, and SHALL NOT throw or crash the poller.

- **QR-9.** WHEN a question is answered, the system SHALL edit the answered message's reply markup to remove its keyboard (via `editMessageReplyMarkup`) and confirm the chosen answer, rather than posting a growing stack of new prompts (CC-7).

- **QR-10.** WHEN the daemon restarts while a question is parked, the system SHALL abandon the in-flight question consistently on both sides: the Layer A `Deferred` is in-memory and is failed by the `Question` service finalizer (`packages/opencode/src/question/index.ts:118-125`), and the in-heap `_pendingQuestions` map is empty on the fresh process. Unanswered questions SHALL NOT survive a restart (matching current tool-timeout behavior and CC-6), while the durable chat/session mapping in `telegram_session` SHALL survive (CC-1). A late Telegram callback for a question lost to restart is handled by QR-8.

- **QR-11.** The system SHALL delete Layer B: `globalRegister`, `globalUnregister`, `globalList`, `globalReply`, `globalReject`, and the backing `_globalPending`/`_globalDeferreds` maps (`packages/opencode/src/question/index.ts:202-235`). WHEN the change is complete, a grep for those symbols SHALL return no references outside their (now removed) definition site, and no code SHALL reference any Layer B symbol. (bot.ts is confirmed the only external caller today: `bot.ts:294,333,397,409`.)

- **QR-12.** WHEN the ingestion/worker split of SDD-04 is in place, the session is created inside the worker, so the worker persists `job_queue.session_id`; the bridge's chat lookup (QR-3) SHALL read that durable mapping rather than any value set in the request context that produced it. The `onSessionCreated` hook (`packages/opencode/src/daemon/headless.ts:35`) is the only chat-supplying hook; scheduler and mesh sessions do not pass through it and therefore correctly do not correlate (QR-4).

- **QR-13.** WHEN any code in the Telegram process or the `Bus.subscribe(Event.Asked)` fiber invokes `Question.Service` (the outbound reply of QR-7, or any `Question.Service` access) or reads the durable correlation stores (QR-3), it SHALL execute inside `Instance.provide({ directory: process.cwd(), init: () => AppRuntime.runPromise(InstanceBootstrap), fn })`, mirroring `packages/opencode/src/daemon/runner.ts:56-58` and `packages/opencode/src/server/instance/middleware.ts:68-74` (SC-5). Because the daemon is single-host with one `process.cwd()`, this directory deterministically matches the instance under which the tool parked its `Deferred`. A REST call to the in-process `POST /question/:requestID/reply` endpoint is an acceptable alternative ONLY because it passes through `WorkspaceRouterMiddleware`, which supplies the same `Instance.provide` context; the explicit `Instance.provide` wrap is preferred so the instance seam is unambiguous. The system SHALL NOT rely on a bare `AppRuntime` call, which the master (SC-5) forbids as it throws `LocalContext.NotFound`.

## HOW

### Reuse map (existing code to reuse, with anchors)

- **Inbound subscription:** `Bus.subscribe(def, callback)` static helper returning an unsub function (`packages/opencode/src/bus/index.ts:183-188`); pattern in `packages/opencode/src/lsp/client.ts:219`. Subscribe to `Question.Event.Asked` (`packages/opencode/src/question/index.ts:60`).
- **Outbound reply (instance-scoped path):** `Question.Service.reply` on `AppRuntime`, run INSIDE a directory-scoped `Instance.provide` (SC-5, QR-7, QR-13). `Question.Service` state is instance-scoped: the tool's `pending` map lives in `InstanceState.make` keyed by `directory` (`packages/opencode/src/question/index.ts:112`), resolved via `Instance.current` (`packages/opencode/src/project/instance.ts:72-73`). The REST endpoint (`packages/opencode/src/server/instance/question.ts:60-72`) works ONLY because `WorkspaceRouterMiddleware` wraps it in `Instance.provide({ directory, init: () => AppRuntime.runPromise(InstanceBootstrap) })` (`packages/opencode/src/server/instance/middleware.ts:68-74`); a bare in-process `AppRuntime.runPromise(Question.Service.use(...))` from `bot.ts` runs with no ambient Instance ALS context and throws `LocalContext.NotFound` (`packages/opencode/src/util/local-context.ts:11-16`), never succeeding the `Deferred`. The correct call is:
  ```ts
  await Instance.provide({
    directory: process.cwd(),
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: () => AppRuntime.runPromise(
      Question.Service.use((svc) => svc.reply({ requestID, answers })),
    ),
  })
  ```
  mirroring `packages/opencode/src/daemon/runner.ts:56-58`. Single-host daemon → one `process.cwd()`, deterministically matching where the tool parked. On success this succeeds the parked `Deferred` (`packages/opencode/src/question/index.ts:158-173`) and publishes `Event.Replied`. (A localhost `POST /question/:requestID/reply` is acceptable only because it goes through the same middleware; prefer the explicit `Instance.provide` wrap.)
- **Keyboard send / edit / progression:** keep `sendQuestionKeyboard` (`bot.ts:356`), `handleCallbackQuery` (`bot.ts:312`), `submitQuestionAnswer` (`bot.ts:379`), `_pendingQuestions` (`bot.ts:59`), `awaitingCustomAnswer` (`bot.ts:35-38,178-184`), and the `q:` / `qcustom:` callback prefixes (`bot.ts:48-49`).
- **Durable correlation source:** `telegram_session` (SDD-01) and `job_queue.session_id` (SDD-04); parent walk over `SessionTable.parent_id` (`packages/opencode/src/session/session.sql.ts:24`).

### Changes

1. **Delete Layer B** from `packages/opencode/src/question/index.ts`: remove `_globalPending`, `_globalDeferreds`, and `globalRegister/globalUnregister/globalList/globalReply/globalReject` (`:202-235`). Nothing else in that file depends on them.

2. **Rewrite the relay in `packages/opencode/src/telegram/bot.ts`:**
   - Delete `startQuestionPoller`, `pollPendingQuestions`, `_questionPollTimer`, and their references in `start`/`stop`/`_reset` (`bot.ts:60,86,92-97,281-310,432-435`).
   - In `start`, after the bot is verified, register the bridge: `const unsub = Bus.subscribe(Question.Event.Asked, (evt) => handleAsked(evt.properties))`. Store `unsub` and call it in `stop`/`_reset`.
   - Add `handleAsked(req: Question.Request)`: resolve chat via `resolveChatForSession(req.sessionID)` (QR-3); if none, log and return (QR-4); else seed `_pendingQuestions.set(String(req.id), { chatId, totalQuestions, answers, telegramMessageIds: [] })` and `sendQuestionKeyboard(String(req.id), req.questions[0], 0, chatId)`.
   - Replace the two Layer B reads inside `handleCallbackQuery` and `submitQuestionAnswer` (`bot.ts:333,397`) that call `Question.globalList()` to look up the live request: carry the question `Info[]` in the `_pendingQuestions` entry (add a `questions` field seeded in `handleAsked`) so option labels and follow-up questions come from the entry, not from a global list.
   - Replace the reply at `bot.ts:405-414`: build `answers = pending.answers.map((a) => [a!])` and call the instance-scoped outbound path from the reuse map (the `Instance.provide({ directory: process.cwd(), init, fn })` wrap around `Question.Service.reply`, per QR-7/QR-13/SC-5) — NOT a bare `AppRuntime.runPromise`; on the "unknown request" case, follow QR-8. Note that a bare call surfaces as a caught `LocalContext.NotFound` exception ("Failed to submit answers"), which is a distinct failure from the benign QR-8 "expired request" path (`Question.Service.reply` logs and returns void for a missing id, `packages/opencode/src/question/index.ts:161-164`); do not conflate the two.

3. **Add durable correlation helper** (in `bot.ts` or a small `telegram/correlation.ts`): `resolveChatForSession(sessionID): Promise<string | undefined>`.
   - Look up `telegram_session` by `session_id`; if found, return its `chat_id`.
   - Else fetch the session row and, if `parent_id` is set, repeat on the parent, up to a bounded hop cap (for example 8) to prevent cycles/unbounded walks.
   - Also accept `job_queue.session_id` as a correlation source per QR-12; where both exist, either resolving to the same chat is acceptable.
   - Return `undefined` when no chat-owning ancestor exists (QR-4). Reads use `Database.use`/`Database.transaction` per SDD-00 durable-stores, and — like the outbound reply — run inside the directory-scoped `Instance.provide` context (QR-13/SC-5) when invoked from the `Bus.subscribe` fiber, so any instance-scoped access resolves correctly. The correlation these reads consult is durably present because `onSessionCreated` persisted it at session creation before any question fired (QR-3); there is no read-before-write race.

### Precedence / ordering

- The bridge subscribes once at bot start; it does not poll. `Event.Asked` delivery order from the Bus is preserved per subscriber (single PubSub), satisfying CC-3 for question delivery within a chat.
- Free-text answer (QR-6) takes precedence over new-prompt handling: `awaitingCustomAnswer` is checked before queueing/processing in `handleMessage` (`bot.ts:178-184`), which is retained.
- Chat resolution reads durable state only (QR-3/QR-12); the in-heap `_sessionToChat` map (`bot.ts:58,220-226`) is removed.

### Out of scope (documented, not built)

A durable question table is explicitly out of scope per SDD-00 "Right-sizing": the `Deferred` is in-heap, so an unanswered question cannot survive a restart (QR-10). This matches today's tool-timeout behavior and is the accepted trade-off.

## VERIFY

Independent agents exercise full functionality against a mocked-Telegram harness (stub `getUpdates`/`sendMessage`/`sendMessageWithKeyboard`/`answerCallbackQuery`/`editMessageReplyMarkup` and a mocked `HeadlessSession` runner that invokes the real `question` tool). Each criterion states setup, action, and expected observable result, mapped 1:1 to WHAT.

- **V-1 (QR-1, QR-11): bridge exists, Layer B is gone.** Setup: fresh build. Action: `grep -rn "globalRegister\|globalUnregister\|globalList\|globalReply\|globalReject\|_globalPending\|_globalDeferreds\|startQuestionPoller\|pollPendingQuestions\|_questionPollTimer" packages/opencode/src`. Expected: no matches. And `grep` shows exactly one `Bus.subscribe(Question.Event.Asked ...)` registration in the Telegram start path.

- **V-2 (QR-2, QR-7, QR-13, SC-5): keyboard delivered, Deferred resolved through the instance-scoped path, session continues.** Setup: a chat with a durable `telegram_session` mapping. The mocked runner MUST park the tool's `Deferred` under a real directory-scoped `Instance.provide({ directory: process.cwd(), init: () => AppRuntime.runPromise(InstanceBootstrap) })` (exactly as `daemon/runner.ts` does), so `Question.Service` state is instance-keyed as in production — the harness MUST NOT park the `Deferred` in a shared/ambient context that would let a bare `AppRuntime` reply resolve it. Start the bot with mocked API. Action: run a session (via the mocked runner) whose agent calls the `question` tool with one question and two options. Expected: the mocked `sendMessageWithKeyboard` is called once for the correct `chat_id` with the two option buttons plus "Type your answer"; then simulate a `callback_query` selecting option 0; assert (a) the answered message's markup is edited to remove the keyboard, (b) `question.ask` returns `[["<label 0>"]]`, and (c) the tool's `execute` output contains the chosen label, proving the parked `Deferred` was succeeded through the directory-scoped `Instance.provide` reply path. This scenario SHALL be constructed so that a bare `AppRuntime.runPromise(Question.Service.use((svc) => svc.reply(...)))` implementation FAILS it: with the tool parked under `process.cwd()`'s instance, a bare reply throws `LocalContext.NotFound`, the `Deferred` never resolves, and (b)/(c) time out — the test must go red on that implementation.

- **V-3 (QR-3): sub-agent (child session) routes to the parent chat.** Setup: durable mapping exists for a parent session bound to chat C; create a child session row with `parent_id` = parent (no direct mapping). Action: the child session's agent calls the `question` tool. Expected: `resolveChatForSession(childSessionID)` walks `parent_id` and the keyboard is delivered to chat C, not dropped.

- **V-4 (QR-4): scheduler-origin question is not relayed and does not error.** Setup: a session with no `telegram_session` mapping and no chat-owning ancestor. Action: that session calls the `question` tool. Expected: no `sendMessage*` call is made, the bridge handler logs and returns cleanly (no throw, poller stays alive), and the question resolves only via its own timeout.

- **V-5 (QR-5): multiple sequential questions are sent one at a time.** Setup: chat mapped. Action: agent calls `question` with three questions. Expected: exactly one keyboard is sent initially; after answering each, exactly one further keyboard is sent for the next index; after the third answer the outbound reply fires once with all three answers in order.

- **V-6 (QR-6): free-text answer path.** Action: on a delivered keyboard, simulate the `qcustom:` callback, then send a text message "my custom answer". Expected: the text is consumed as the answer for that question index (not treated as a new prompt), confirmed, and folded into the collected answers.

- **V-7 (QR-8): unknown/expired callback handled gracefully.** Action: simulate a `q:` callback for a `requestID` with no `_pendingQuestions` entry (for example after restart). Expected: the callback is acknowledged, no throw, no reply is attempted for a nonexistent request, and the poller continues.

- **V-8 (QR-9, CC-7): edits not spam.** Assertion across V-2/V-5: answered questions are updated via `editMessageReplyMarkup` and no duplicate keyboards are posted for an already-answered index.

- **V-9 (QR-10, QR-13, CC-1/CC-6): restart abandons in-flight question, keeps mapping.** Setup: park a question under a real directory-scoped `Instance.provide` (as in V-2), then `_reset()`/re-init the bot (simulated restart). Expected: the in-heap `_pendingQuestions` is empty and the Layer A finalizer fails the parked `Deferred` (tool sees `RejectedError`/timeout, no hang); the `telegram_session` mapping still resolves the chat for a new question, and the post-restart question's reply path again runs inside its own `Instance.provide` (the fresh process re-establishes the directory-scoped context), succeeding the new `Deferred` — a bare reply would fail here for the same `LocalContext.NotFound` reason as V-2.

- **V-10 (QR-12): chat lookup reads worker-persisted session id.** Setup: simulate the SDD-04 split where the worker persists `job_queue.session_id`. Action: a question from that worker-created session is asked. Expected: `resolveChatForSession` finds the chat via the durable mapping (not via any removed in-heap `_sessionToChat`).

- **V-11 (CC-9, build/regression): typecheck + tests green.** Action: run the repo typecheck and `bun test`. Expected: both pass, including the existing `packages/opencode/test/question/question.test.ts` and `packages/opencode/test/tool/question.test.ts`. The feature is not done if any test is red.
