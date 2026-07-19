# SDD-00 Whole-Suite Coherence Audit (final gate)

VERDICT: PASS

**Date:** 2026-07-19
**Auditor:** independent whole-suite coherence gate
**Scope:** SDD-00 master + SDD-01..04 read in full.

## Fix verification

1. **SDD-02 line 148** — CORRECTED. No longer claims the registry "has no chat context." It now states "SDD-04 W-24 adds `ctx: { chatId? }` to `HarnessCommand.execute`, so the registry can carry `chatId`; these commands are kept local for the bot-layer dependencies above, not because the registry lacks `chatId`." Consistent with SDD-04 W-24's `ctx: { chatId? }` and with the SDD-01 fixes.

2. **SDD-01 lines 48 and 111** — CORRECTED and mutually consistent. Line 48: "SDD-04 W-24 extends `HarnessCommand.execute` with a `ctx: { chatId? }` so the registry CAN receive `chatId`... not because the registry lacks `chatId`." Line 111: "the registry does carry `chatId`... not because the registry cannot receive `chatId`." Both give the true bot-layer rationale (per-chat session mutation + SDK session validation).

3. **No remaining false instance.** Grep sweep for `no chat context | transport-agnostic | cannot (get|carry|receive) | transport is HTTP | registry (cannot|has no|lacks)` across all five specs returns only the three now-negated/corrected passages above. SDD-03 line 31 (QR-4) matched only on "no chat-owning ancestor," which is legitimate: it describes a session with no chat-owning ancestor in the `parent_id` walk (scheduler/mesh-origin sessions), not a registry capability claim. Same legitimate usage at SDD-03 lines 85 and 107.

## Contract re-confirmation (coherent)

- **Command ownership.** Chat-scoped `/new`,`/resume` (SDD-01 req 11), `/model`,`/status` (SDD-02 #14,#19) intercepted in the bot before the `HarnessCommands.execute` fallback; registry `/stop` (SDD-04 W-24, ctx.chatId) and `/peers` reach the registry. Dispatch ordering consistent across SDD-01:111, SDD-02:148, SDD-04:96/179. `/peers` used correctly as the non-chat-scoped registry example (SDD-01 V11), which also correctly notes `/status`,`/model` are NOT valid registry examples.
- **Accessor usage.** `getModel` used ONLY by `/model` + `/status` (SDD-02:8,144,155); ingestion uses `getByChat` for the single row read of sessionId+model+persona (SDD-01:101, SDD-02:144,155); worker forwards `payload.model` and SHALL NOT re-read `getModel` at drain (SDD-02 #16,#155; SDD-04 W-12). No conflict.
- **SC-1..SC-5.** Payload shape `{ prompt, persona?, timeoutMs?, sessionId?, model? }` identical in master:124, SDD-01:101, SDD-02:111/155, SDD-04:114. Single table owner = SDD-04 (`queue.sql.ts` + one migration `20260719120000_telegram_queue`); SDD-01/02/03 reference only, no CREATE/ALTER (W-1a, V-13a). Nullable `session_id`/`persona`/`model_override` consistent (SC-1, SDD-04:102-108). Atomic ingestion (SC-3, W-3, V-2a). Security: field path `resolvedPersona.config.models`, fail-closed on load/parse, allow-only coverage all present and mutually consistent (SC-4, SDD-02 #5,#9,#10a, V-6/V-6a/V-7). Instance context `Instance.provide({ directory: process.cwd(), ... })` (SC-5, SDD-03 QR-7/QR-13). Create-only write-back to BOTH `job_queue.session_id` and `telegram_session.session_id`, no write-back on resume (SC-2, W-12a, SDD-01 req 1-3).
- **`/status` shadow** documented at SDD-02:151 (shadows registry `/status` on the Telegram surface; registry `/status` remains on other transports). `ack_message_id` INTEGER NULL consistent (master:118, SDD-04:117). `onSessionCreated` fires at creation before `sdk.session.prompt` (runner.ts:80 precedes :92) so question correlation has no race (SC-5, QR-3) — consistent.

## Result

The false "registry cannot carry chatId" justification is eliminated in all three prior locations and replaced with accurate bot-layer reasoning that explicitly acknowledges SDD-04 W-24. No remaining genuine contradictions were found in a fresh whole-suite scan: command ownership, accessor usage, payload/table/security/instance contracts, and the `/status` shadow are all internally consistent and consistent with the master. Suite is coherent.

VERDICT: PASS
