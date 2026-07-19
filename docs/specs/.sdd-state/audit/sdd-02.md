# SDD-02 Independent Re-Audit (post wording fix at line 148)

VERDICT: PASS

Auditor: independent (did not author). Target: `260719_telegram_sdd-02-model-control.md`. Cross-checked against `260719_telegram_sdd-04-split-queue-worker-routing.md` W-24.

## 1. Line 148 rationale is now accurate — PASS

The prior falsely claimed `HarnessCommands` is "transport-agnostic and has no chat context." SDD-04 W-24 contradicts that: W-24 (line 64) and its HOW anchor (line 179) change `HarnessCommand.execute` from `(args: string) => Promise<CommandResult>` to `(args: string, ctx: { chatId?: string }) => Promise<CommandResult>` and thread `ctx` through `HarnessCommands.execute(name, args, ctx)`; ingestion passes `{ chatId }`. So the registry CAN carry `chatId`.

SDD-02 line 148 now states `/model` and `/status` "are chat-scoped and need `chatId`, persona resolution, `TelegramStore`, and the provider list — bot-layer concerns" and explicitly adds: "SDD-04 W-24 adds `ctx: { chatId? }` to `HarnessCommand.execute`, so the registry can carry `chatId`; these commands are kept local for the bot-layer dependencies above, not because the registry lacks `chatId`." This matches SDD-04 exactly and no longer contradicts it. The justification for bot-local placement (persona resolution, `TelegramStore`, `Provider.list`, per-chat scope) is genuine and independent of the chatId point. Accurate and consistent.

## 2. No regression — security boundary airtight — PASS

- Accessor consistency: `getModel` consumed only by `/model` + `/status` (lines 8, 144, 155, req 16); ingestion uses `getByChat`; worker forwards `payload.model` and SHALL NOT re-read `getModel` at drain (lines 59, 111, 155). Uniform.
- Guard reads `resolvedPersona.config.models`, never `resolvedPersona.models`; undefined policy is a bug, not allow-all (req 5 line 38, HOW item 4 lines 121/125/130 read the same `config.models` field; line 138 confirms same-field gate + call).
- Denied model rejected on all three arrival paths (chat override, frontmatter, `Provider.defaultModel()` fallback) before `sdk.session.prompt` (req 6-8, item 4, V7 third case line 189).
- Fail-closed on load/parse failure via `Persona.PolicyLoadError` (req 10a, item 2, V6a).
- Allow-only allowlist + deny-wins precedence (req 3-4, 9; `validateModelPolicy`) covered by V6.
- Single shared choke point covering all entry points (req 8).
- `/status` registry-shadow note (line 151) intact and unchanged.

## 3. No new inconsistency introduced.

Line 54 ("`/model` SHALL be handled in the Telegram bot, not in `HarnessCommands`") is a placement statement consistent with the revised line 148 rationale.

## Summary

The single changed line (148) now correctly reflects SDD-04 W-24's `ctx: { chatId? }` extension of `HarnessCommand.execute` and gives an accurate bot-layer rationale for keeping `/model`//`/status` local, replacing the prior false "transport-agnostic / no chat context" claim. Nothing regressed: accessor roles, override threading, and the fail-closed, deny-wins, single-choke-point, allow-only security boundary (SEC-1..SEC-4, V6/V6a/V7 with zero-prompt-call assertions) all remain intact, and the `/status` shadow note is preserved. No new inconsistency was found.

VERDICT: PASS
