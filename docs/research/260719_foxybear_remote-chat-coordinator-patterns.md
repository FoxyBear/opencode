# Remote Chat Control of a Headless AI Coordinator: Design and Implementation Patterns

**Date:** 2026-07-19
**Project:** FoxyBear CLI (Telegram client overhaul)
**Phase:** Research (feeds a subsequent requirements analysis phase)
**Status:** Research complete, no decisions made

## Purpose

The FoxyBear CLI Telegram client has three failures that make it unfit for real use:

1. **No conversation context.** Long async conversations lose their thread.
2. **No model visibility or control.** The user cannot see which model is active or change it from chat.
3. **Sub-agent dispatch does not work.** Firing off sub-agents from Telegram and getting results back is broken.

The stated conclusion from the PO: the entire design needs an overhaul. This document surveys current (2024 to 2026) design and implementation patterns for remote-chat control of headless AI agents, so the requirements phase can proceed from evidence rather than guesswork. It does not propose a design. It maps the problem space, names the patterns real systems use, records their tradeoffs, and flags what remains unverified.

## Current implementation (baseline)

Established from a read of `packages/opencode/src/telegram/` and the daemon/session code:

- **Transport:** long-polling `getUpdates` (30s), single daemon process (`foxybear serve`). Telegram registered as a non-fatal daemon subsystem.
- **Sessions:** every inbound message spawns a **brand-new stateless `HeadlessSession`**. The only continuity is a **500-char summary** of the previous response, prepended within a **30-minute in-memory TTL** (`ChatState`). All state (`_chatStates`, `_sessionToChat`, pending questions) is in-memory and lost on restart.
- **Model:** locked to whatever the configured `telegram.persona` (default `katya`) declares in its `.md` front-matter. No runtime visibility or switching.
- **Question relay:** the Telegram side is fully built (inline keyboards, callback handling, `Question.globalReply`), but **`Question.globalRegister()` has zero callers**. The headless session's question tool goes through the Effect-based service, not the global registry the bot polls. The bridge is plumbed but not wired. This is the root cause of "sub-agent dispatch does not work."
- **Concurrency:** per-chat `processing` flag with an in-memory queue; serializes one session per chat.

These three defects each map to a distinct, well-studied solution class. The research below is organized around them plus the underlying architecture.

---

## 1. Conversation session and context management

### The three sub-problems, named separately

Modern systems solve these with three different mechanisms, and conflating them is a common error:

| Defect (ours) | Mechanism that fixes it |
|---|---|
| No durable session identity (fresh session per message) | Deterministic session ID derived from the chat, mapped to a persisted session |
| Lossy continuity (500-char summary only) | Full-transcript persistence, with compaction as a fallback when the window fills, not the primary store |
| No restart durability (in-memory, 30-min TTL) | Durable session store (checkpoint rows or append-only event log) |

The near-universal production answer: **derive a stable session ID from the chat thread, persist the full event log keyed by that ID, reload it on each inbound message, and apply compaction only when the context window actually fills.**

### Session identity and thread modeling

The cleanest pattern is **"thread timestamp as session ID"** (AWS Bedrock AgentCore + Slack, and Slack's own agent guidance): `session_id = thread_ts`, `actor_id = user_id`, no external mapping table needed because every threaded reply shares the parent timestamp.

**Telegram caveat (important):** Telegram has no per-DM equivalent of Slack's `thread_ts`. It has forum "topics" (`message_thread_id`) only in supergroups, and `reply_to_message` chains. So the elegant zero-state trick does not map to Telegram DMs. Practical choices:

- **Default: one session per chat** (`chat_id` as key), with explicit `/new` to start fresh and `/resume <id>` to switch. This is the documented production Telegram pattern.
- **Topic isolation:** key on `(chat_id, message_thread_id)` in forum groups.
- Precedent: Nous Research's Hermes Agent stores every Telegram conversation as a session with full history in SQLite (FTS5 + structured metadata).

Granularity options observed: per-chat/DM (most Telegram bots), per-thread (Slack, Discord), per-task (Cursor background agents, Devin sessions).

### Context-window management for long conversations

Four strategies, layered by real systems in roughly this order of sophistication:

- **A. Automatic compaction (summarize-and-replace).** Now a first-class API primitive. The **Anthropic Context Compaction API** (beta `compact-2026-01-12`) triggers at a configurable token threshold (default 150k, min 50k), emits a `compaction` block, and auto-drops earlier blocks on the next request. **Claude Code auto-compact** does the same near 75 to 95 percent of the window depending on client. Our 500-char prepend is a degenerate form of this: summary-only, no full history, fixed tiny budget.
- **B. Tiered memory (Letta/MemGPT).** Core memory (always in context, self-edited), recall memory (searchable recent), archival (long-term via tool). History compacts into a recursive summary when context fills; old messages stay retrievable.
- **C. Retrieval-augmented / structured interstitial state (Slack best practice).** Maintain a structured `{ goal, constraints, decisions, artifacts, sources }` object, progressively summarize, enforce token budgets, detect drift. Do not re-inject the whole thread each turn.
- **D. Sliding window / truncation.** Crudest: drop oldest N. Cheap, lossy, superseded by A/B/C for long-lived chats.

### State persistence across restarts

Four storage architectures seen in production:

| Pattern | What it is | Reference | Tradeoffs |
|---|---|---|---|
| Checkpoint rows (RDBMS) | State snapshot per step (`checkpoints`/`blobs`/`writes` tables) | LangGraph PostgresSaver | Queryable, time-travel, mature; you run the DB; blob bloat needs pruning |
| Event-sourced log + base snapshot | Append-only events + `base_state.json`, replay to rebuild | OpenHands (crash recovery <20ms) | Full auditability, version-tolerant replay; more moving parts |
| JSONL transcript files | Human-readable per-session file on disk | Claude Code / Agent SDK (`~/.claude/projects/`) | Trivial, greppable, `resume`/`fork`; local-only, cwd-coupled, format not a stable API |
| Durable-execution workflow | One workflow per conversation, messages as Signals | Temporal | Best restart survivability, stateless app tier; heavy infra dependency |

Notably, the **Claude Agent SDK explicitly marks its `InMemorySessionStore` as NOT production-suitable** ("all state lost on process exit"). That is our exact current failure mode, reproduced and warned against at the SDK layer. The SDK's own guidance is to configure a durable `SessionStore` adapter.

For a Telegram bot specifically, the pragmatic middle ground most builders use: a `sessions` table `(session_id, chat_id, user_id, created_at, updated_at, status)` plus a `messages` table `(session_id, seq, role, content, tool_calls, created_at)`. We already run SurrealDB in the daemon, so this is available without new infrastructure.

### Resumption

Two families: **reload-and-rehydrate** (replay transcript: Claude Agent SDK `resume: sessionId`, `fork_session`, `continue: true`; LangGraph same-`thread_id`; OpenHands `create()` factory rebuilds the view) and **reload-by-reference** (server holds state: OpenAI Conversations API, just send the next message with the stored ID).

Cross-host resume gotcha (Claude Agent SDK): resume fails silently and returns a fresh session if `cwd` does not match the encoded transcript path. The docs note that capturing distilled results as app state and re-priming a fresh session is often more robust than shipping transcript files around.

---

## 2. Human-in-the-loop and control UX

### Model selection in chat

Three patterns:

- **A. `/model` slash command with autocomplete** (llmcord). Admin-gated. Scales to many models, keyboard-friendly, but invisible (users must know it exists).
- **B. `/model` opens an inline keyboard / dropdown** (Telegram bots `mlloliveira/TelegramBot`, `DoctorLai/llm-telegram-bot`). Buttons carry `callback_data` like `model:claude-opus-4-8`; selection fires a `CallbackQuery`; the bot edits the message to reflect the new selection. Discoverable and tappable on mobile, but does not scale past ~8 to 10 options.
- **C. Curated "specs/presets" + persistent header label** (LibreChat `modelSpecs`, `interface.modelSelect`). Hides model sprawl behind named bundles, gates by role.

Showing the *current* model in a surface with no persistent chrome: echo it in a response footer, and/or a `/status` command. The footer + `/status` combination is the most robust for chat.

### Clarifying questions and approvals mid-task

The dominant architecture is **interrupt-and-resume backed by persisted state**, with the chat platform supplying the input widget. This is exactly the gap in our question relay.

- **Reference implementation: LangGraph `interrupt()`.** Called inside a node, it pauses execution, persists state via a checkpointer, and returns control with a payload. The human reply resumes via `Command(resume=<answer>)`, continuing from that exact line. A checkpointer is mandatory. HITL middleware defines four canonical decision types: **approve** (run as-is), **edit** (modify args then run), **reject** (with feedback), **respond** (answer an ask-user tool directly). This maps cleanly onto chat: interrupt payload becomes a message with buttons, button press becomes the resume command.
- **Telegram mechanics:** send question with `reply_markup` inline keyboard; on `CallbackQuery`, call `answerCallbackQuery` (clears the client spinner), then `editMessageReplyMarkup`/`editMessageText` to disable buttons and show the resolution (prevents double-clicks). No modals; free text via `ForceReply`.
- **"Ask a human" as a tool:** `AskOnSlackMCP` exposes an `ask_on_slack` tool: agent asks, bot mentions a user, human replies in-thread, answer returns to the agent, 60s timeout. A clean template for our question tool.
- **Cross-platform tradeoff:** buttons give unambiguous tappable choices but no free text; modals (Slack/Discord) or reply-in-thread / force-reply (Telegram) capture open answers but need parsing and timeout handling. Production systems combine both: buttons for common decisions plus an "Edit/Other" escape hatch.

### Slash command vocabulary

Common across chat-LLM bots: `/model` (show/switch), `/new` `/reset` `/clear` (fresh conversation), `/stop` `/cancel` (abort run), `/status` (current model, session, active task), `/help`, `/settings`. Telegram has no native command routing: the bot receives `/command args` as plain text and dispatches on prefix. BotFather's command list only provides autocomplete hints. Recurring guidance: keep verbs small and consistent, gate destructive/model-changing commands by role, always provide `/help`, echo state changes back.

### Interruptibility and steering (weakest-supported area)

Most chat-agent bridges run a triggered turn **to completion**; a follow-up "stop" queues behind the running turn and cannot abort it. Patterns that work:

- **Explicit `/stop` bound to the session's cancellation token.** Requires the agent loop to be cancellable (cooperative cancellation points between steps), not a blocking call.
- **Interrupt vs queue is a real design fork.** New message as interrupt vs new message as queued steering. The clean design makes it explicit: `/stop` = brake now, a normal message = queued steering applied on the next step.
- **Per-step checkpoints (LangGraph).** Cancel between steps, resume/redirect from the last checkpoint.

The UI primitive is trivial; the hard part is a cancellable agent loop.

---

## 3. Async sub-agent orchestration over chat

This is the "sub-agent dispatch does not work" problem. The single most important structural finding across the research:

> **Separate the process that owns the Telegram connection from the process that runs sub-agents. Connect them through durable correlation state plus a pub/sub channel. Never through in-memory request context.**

Our current design fails precisely because dispatch and result-delivery share in-memory request context that evaporates when the originating turn ends or the process restarts.

### The universal core: ack-first, execute-async

Every system acknowledges synchronously and executes asynchronously. Slack enforces this with a hard 3-second ack deadline and a `response_url` valid for 30 minutes as the follow-up channel. Telegram has no hard ack deadline but the same discipline applies: the handler enqueues work and returns immediately rather than blocking the update loop. Agent platforms (OpenHands, OpenAI Responses background mode, Claude Agent SDK `Task` with `run_in_background`) return a job/session/task ID synchronously that the caller uses to follow up.

### Progress reporting

- **Edit-in-place** (Slack `chat.update`, Telegram `editMessageText` on a stored `message_id`): a single evolving status line. **Telegram caps edits at ~6/second** and ~1 msg/s per chat, so debounce to roughly one edit every few seconds, never per-token.
- **Emoji reactions as status** (Cursor: hourglass/check/cross; Devin): near-zero cost, no flood risk, ideal for terminal-state signaling.
- **New messages** only for meaningful milestones (phase transitions, questions, final result).

### Result delivery and correlation (the heart of it)

The named pattern is **Request-Reply with Correlation ID + Reply-To** from enterprise messaging. Persist routing coordinates at dispatch time; the worker uses them on completion.

Concrete record to persist at dispatch:

```
job_id (correlation_id)  ->  { chat_id, status_message_id, user_id, thread_id?, created_at, ttl }
```

Store durably (a SurrealDB `job` table). Worker finishes, looks up by `job_id`, calls `editMessageText(chat_id, status_message_id, result)` or `sendMessage`. This survives both the originating request context being gone and a bot process restart, because the mapping is durable, not in-memory. Set a TTL so the table does not grow unbounded.

Three delivery mechanisms: stored reply-to coordinates (Telegram-native), callback URL on completion (Slack `response_url`, OpenAI webhooks), or thread-as-routing-key (Devin/Cursor bind the session to a Slack thread). Since Telegram threads are weak, stored coordinates is the robust path.

### Sub-agent orchestration by system

| System | Dispatch | Progress | Result | Concurrency/monitor |
|---|---|---|---|---|
| Devin (Slack) | `@Devin` + prompt; `!new` forces new session | In-thread replies, emoji, opt-in DM | In-thread, emoji marks | Parent-orchestrates-children (secondary-sourced), up to 10 parallel, Devin Desktop command center |
| Cursor (Slack) | `@Cursor` + inline `env=`/`branch=`/`model=` | Emoji, "Open in Cursor" button | Slack notification + PR link | `list my agents`, context menu stop/delete |
| OpenHands (Cloud API) | `POST /app-conversations` | Poll `execution_status` | Poll until finished | `search?limit=` with paging |
| Claude Agent SDK | `Task` tool `run_in_background:true` -> task ID | Task ID status | `TaskOutput` | Multiple subagents, background maturing (issue #9905) |

Two archetypes: **thread-bound conversational agents** (chat thread is the session, best UX, needs rich threading) and **API-handle agents** (dispatch returns an ID, you build the correlation layer). Telegram's weak threading pushes us toward the API-handle model with our own durable correlation.

### Job lifecycle and restart survival

- **Durable queue baseline (Celery/Redis).** `acks_late=True` returns a job to the queue on worker crash (at-least-once). Watch the **Redis 1-hour visibility timeout**: long agent jobs get redelivered while still running, causing duplicate execution. `worker_prefetch_multiplier=1` for heavy tasks. Idempotency is mandatory.
- **Durable execution (Temporal/Inngest)** is the 2025 consensus for long agent loops. Event-sourced history replays to resume exactly where it stopped after a crash. **Signals** route external events (a cancel or approval from chat) into a running workflow instance; a durable wait costs no compute while suspended. This fits our question-relay use case directly: agent pauses for user input, chat sends a Signal to resume. `continue-as-new` lets a workflow run indefinitely without unbounded history.
- **Cancellation:** a flag in shared state keyed by `job_id` that the worker checks at checkpoints (Celery revocation is best-effort and does not reliably kill running work), or a Temporal Signal.

---

## 4. Architecture and protocol

### The target shape (convergent across all references)

A 4-stage pipeline with a durable queue in the middle:

```
Ingestion            Durable Queue        Worker pool              Output routing
(fast ACK, dedup) -> (at-least-once   ->  (agent execution,   ->  (send + retry
 webhook/poll         buffer,             idempotent,             via bot API)
 update_id dedup)     backpressure)       per-conversation state)
```

**The single most important structural change:** decouple ingestion from agent execution with a durable queue, and move conversation state out of process memory into a datastore. Everything else is refinement.

### Transport: webhooks vs long-polling

- Telegram offers only `getUpdates` (poll) and `setWebhook` (push).
- **`getUpdates` rejects concurrent polls from the same token with HTTP 409.** This hard-blocks horizontally scaling a polling bot: you cannot run two pollers on one token. Webhooks have no such limit.
- Webhook constraints: ports 443/80/88/8443 only, IPv4, TLS 1.2+, optional `secret_token` returned in the `X-Telegram-Bot-Api-Secret-Token` header (verify it), `max_connections` default 40, `getWebhookInfo.pending_update_count` as the backpressure signal.
- **Decision rule:** transport choice is a scale decision, not a latency one. Single long-running daemon (our current shape) -> polling is simpler and avoids a public endpoint. More than one instance or serverless -> webhooks. Slack's own docs make the identical recommendation (HTTP for production scale, Socket Mode for dev only).

### Delivery guarantees and idempotency

- **Telegram guarantees at-least-once delivery.** The bot, not the platform, owns deduplication.
- **Idempotent Consumer / Inbox pattern:** every inbound event carries a stable ID (`update_id`). Check an idempotency store before processing; insert the ID in the same transaction that commits business state. Store in the DB, never memory (our current bug: a restart loses all dedup history).
- **Offset management:** persist `offset = max(update_id) + 1` durably so a restart resumes at the right place.
- **Exactly-once is not achievable across a broker + DB without distributed transactions.** The honest target is at-least-once + idempotent consumer ("effectively-once").

### Ordering (specifically bites chat)

A plain worker pool processes concurrently and out of order, fatal for multi-turn chat where turn 2 must not precede turn 1. Fixes: partition by conversation key (`chat_id`), or use an actor mailbox. On our TS/Bun stack, **grammY** is the strongest framework fit: it supports both polling and webhooks with identical handlers, has a concurrency runner, and a `sequentialize` middleware that runs updates concurrently across chats but sequentially within a chat.

### Conversation as a state machine

Three approaches by durability guarantee: **actor model** (XState v5, per-conversation actor with a mailbox, but in-memory actors lose spawned children on restart unless snapshotted), **LangGraph** (graph nodes with checkpointed state, `interrupt()` for HITL, sync checkpointing in 1.0), **Temporal** (durable execution, event-sourced, survives mid-turn crashes, Signals for HITL, heaviest ops cost). Map: `chat_id` -> workflow/actor ID, each inbound message -> a Signal/event, agent output -> routed back out.

### MCP note (avoid conflation)

MCP is the tool/data plane behind the coordinator (stdio for local, Streamable HTTP for remote, the HTTP+SSE transport is deprecated). It is **not** the chat transport. Telegram/Slack is the human ingress; MCP is how the coordinator exposes and consumes tools. Do not conflate the two.

---

## Convergent architecture (what the evidence points toward)

Not a decision, a synthesis of where every reference system lands for this exact problem:

1. **Kill in-memory state.** Move dedup (`update_id`), conversation state, poll `offset`, and job correlation into SurrealDB (already in the daemon).
2. **Stable session identity.** `chat_id` for DMs with `/new` and `/resume`, `(chat_id, message_thread_id)` for forum topics. Drop the 30-min TTL. On each inbound message, look up the session, rehydrate full context, append the new message. No fresh stateless spawn.
3. **Split the connection-owner process from the execution process.** Only one process holds the Telegram token (409 constraint). Sub-agents run elsewhere. Connect via durable correlation state + pub/sub (SurrealDB live query is available).
4. **Ack-first dispatch.** On a sub-agent command: create `job_id`, persist `{job_id -> chat_id, message_id, user}`, enqueue, post "started," return. Worker delivers by looking up the correlation record on completion.
5. **Wire the question bridge.** Model it as interrupt-and-resume with persisted state: the agent emits a typed decision request (approve/edit/reject/respond), rendered as Telegram inline keyboard + a force-reply escape hatch, with a timeout and default. The missing `Question.globalRegister()` call is the concrete first fix.
6. **Context via API-native compaction** (Anthropic `compact_20260112` or SDK auto-compact), keeping the full log durable so compaction is recoverable. Not a 500-char prepend.
7. **Model control** via `/model` (print current with no arg, plus an inline keyboard of allowed models), `/status`, and a response footer. Gate switching by role.
8. **Idempotent, ordered consumer.** Check-and-insert `update_id` transactionally; preserve per-chat ordering (grammY `sequentialize` or partition-by-`chat_id`).
9. **Interruptibility** via `/stop` bound to a per-session cancellation token, with an explicit interrupt-vs-queue policy for stray messages.

---

## Open questions for the requirements phase

- **Session grain:** one-per-chat with explicit `/new`, or auto-segment by idle gap? Telegram's weak threading forces a choice.
- **Execution model:** stay single-daemon (polling, simplest) or move to split ingestion/execution with a queue now? The sub-agent requirement may force the split regardless.
- **Durable execution:** is Temporal-grade crash survival a hard requirement, or is at-least-once + idempotent consumer on SurrealDB sufficient? Temporal's Signals fit the question-relay cleanly but add heavy infra.
- **Does the coordinator adopt the Claude Agent SDK's session model** (own the JSONL transcript, store `session_id <-> chat_id`, resume by ID) or roll its own `sessions`/`messages` tables? The security boundary matters: Katya must not touch Anthropic/OpenAI APIs (see memory `feedback_security_boundary`), which constrains which SDK session machinery is usable for which persona.
- **Sub-agent concurrency cap** per chat and globally.
- **Model allow-list** per persona and per role for `/model`.

## Verification caveats (flagged per no-fabrication rule)

- Devin "up to 10 parallel sessions" and parent-orchestrates-children are secondary-sourced (industry news + Devin docs), not confirmed in Devin primary docs.
- Claude Agent SDK `run_in_background`/`TaskOutput` are documented but native background Task orchestration is an evolving feature (issue #9905). Verify against the live SDK before depending on it.
- OpenHands appears poll-only (no webhook found in its docs). Budget for a polling loop if adopted.
- Telegram webhook retry cadence (exponential 1s to 64s) is a third-party claim, not in official docs.
- Claude Code auto-compact trigger percentages (75 vs 95) come from community sources and vary by client/version.
- MCP governance "Agentic AI Foundation" donation is single-sourced, not corroborated.
- Two repos (`openclaw/openclaw`, `NousResearch/hermes-agent`) recurred in searches with implausible star counts; their specific claims were not trusted, only patterns corroborated elsewhere.

## Key sources

Session/context: LangGraph persistence (docs.langchain.com/oss/python/langgraph/persistence), Anthropic Compaction API (platform.claude.com/docs/en/build-with-claude/compaction), Claude Agent SDK sessions (code.claude.com/docs/en/agent-sdk/sessions), OpenAI conversation state (developers.openai.com/api/docs/guides/conversation-state), Bedrock AgentCore + Slack (aws.amazon.com/blogs/machine-learning/integrating-amazon-bedrock-agentcore-with-slack), OpenHands ConversationState (github.com/OpenHands/software-agent-sdk), Temporal durable chatbot (temporal.io/blog/building-a-persistent-conversational-ai-chatbot-with-temporal).

Async orchestration: Slack commands/response_url (docs.slack.dev), Telegram flood limits (github.com/python-telegram-bot wiki), RabbitMQ request-reply (oneuptime.com/blog/post/2026-01-27-rabbitmq-request-reply), Temporal AI agents (temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal), Devin Slack (docs.devin.ai/integrations/slack), Cursor Slack (cursor.com/docs/integrations/slack).

HITL UX: LangChain human-in-the-loop (docs.langchain.com/oss/python/langchain/human-in-the-loop), Slack interactivity (docs.slack.dev/interactivity/handling-user-interaction), Telegram Bot API (core.telegram.org/bots/api), llmcord (github.com/jakobdylanc/llmcord), AskOnSlackMCP (mcpservers.org/servers/trtd56/AskOnSlackMCP).

Architecture: Telegram webhooks (core.telegram.org/bots/webhooks), grammY deployment/concurrency (grammy.dev/guide/deployment-types), Slack HTTP vs Socket Mode (docs.slack.dev/apis/events-api/comparing-http-socket-mode), Inbox pattern (dev.to/actor-dev/inbox-pattern-51af), MCP transports (modelcontextprotocol.io/specification/2025-11-25/basic/transports), Claude Agent SDK hosting (code.claude.com/docs/en/agent-sdk/hosting).
