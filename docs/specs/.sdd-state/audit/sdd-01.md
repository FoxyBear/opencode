# SDD-01 Re-Audit — Durable Per-Chat Sessions with Resume

VERDICT: PASS

## Scope
Independent re-audit after the wording fix to lines 48 and 111 (removing the false "cannot carry chatId (HTTP transport)" claim). Focused on rationale accuracy/consistency vs SDD-04 and regression of previously-passing checks.

## Findings

### 1. Reworded rationale (lines 48, 111) — ACCURATE and CONSISTENT
- SDD-04 line 179 (W-24) confirms the ctx.chatId claim: it changes `HarnessCommand.execute` from `(args: string) => Promise<CommandResult>` to `(args: string, ctx: { chatId?: string }) => Promise<CommandResult>` and threads `ctx` through `HarnessCommands.execute(name, args, ctx)`. So the registry demonstrably CAN receive `chatId`.
- SDD-01 line 48 and line 111 now both state the correct rationale: `/new`/`/resume` are kept bot-local because they mutate this chat's `telegram_session` mapping and validate sessions via the SDK (bot-layer concerns), and explicitly acknowledge "not because the registry cannot receive `chatId`," directly referencing SDD-04 W-24's `ctx: { chatId? }`. No residual "HTTP transport" contradiction remains.

### 2. No regressions
- **SC-1 (no table redefinition):** Lines 58-60, 119 — SDD-01 issues no CREATE/ALTER/snapshot and adds no telegram.sql.ts; reaches the SDD-04-owned table only via `TelegramStore`. Intact.
- **SC-2 (worker write-back):** Lines 28, 102, 131 — `onSessionCreated` fires only on create, writing new id to both `job_queue.session_id` and `telegram_session.session_id`; no write-back on resume. Intact.
- **/new nulls session:** Lines 38, 76-77, 113 — `setSession(chatId, null)` preserving `model_override`/`persona`; underlying session rows untouched. Intact.
- **/resume via sdk.session.messages:** Lines 40, 91, 114 — validates existence by probing `sdk.session.messages`, binds on success, leaves mapping untouched on miss. Intact.
- **V11 uses /peers:** Line 151 — `/peers` cited as the non-chat-scoped registry example; verified `/peers` ("List mesh peers") is a genuine registry command in `src/harness/commands.ts:63` and is not chat-scoped. The note correctly excludes `/status`/`/model` (SDD-02, chat-scoped). Accurate.
- **VERIFY 1:1:** V1-V12 map to WHAT reqs 1-12 respectively; V13 covers build/regression (CC-9). Complete 1:1 coverage.

### 3. No new inconsistency introduced
The edits are confined to rationale text; behavior, contracts, and cross-references are unchanged and internally consistent.

## Conclusion
The reworded rationale is accurate and consistent with SDD-04 W-24 (line 179), and nothing else regressed. PASS.
