# SDD-02: Runtime Model Control + Katya Security Guard

**Date:** 2026-07-19
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Model tier:** authored at Opus tier
**Refines:** `260719_telegram_sdd-00-master.md`
**Depends on:** SDD-04 foundation (the `telegram_session` table — including the `model_override` column declared there per SC-1 — and the run-chain `model` parameter per SC-2) and SDD-01 (per-chat session identity). This spec does NOT create or alter any shared table: it accesses `telegram_session.model_override` only through `TelegramStore` (`setModel` to write; `getModel` for the `/model` and `/status` commands; and the `getByChat` row-read that ingestion, owned by SDD-01/SDD-04, uses to populate `payload.model`), and CONSUMES the run-chain `model` parameter owned by SDD-04.

This spec owns the Katya security invariant (SEC-1..SEC-4) in detail and the `/model` runtime-selection feature. Where this document restates a master requirement, the master (`sdd-00`) still wins on conflict; the restatements here refine it into concrete, testable WHEN/SHALL requirements.

## Background and current behavior (verified against code)

- The daemon executor resolves the model from the persona frontmatter and nothing else. `packages/opencode/src/daemon/runner.ts:91` reads `const model = resolvedPersona?.model ? Provider.parseModel(resolvedPersona.model) : undefined` and passes `...(model ? { model } : {})` into `sdk.session.prompt` (`runner.ts:92`). When the persona omits `model`, the field is `undefined` and resolution falls through to the SDK/session defaults.
- Those defaults are Anthropic/OpenAI-biased and **persona-unaware**: `Provider.getSmallModel` priority begins `claude-haiku-4-5 … gpt-5-nano` (`packages/opencode/src/provider/provider.ts:1693`), `Provider.defaultModel` falls back to `sort` (`provider.ts:1765`), and `Provider.sort` priority is `["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]` (`provider.ts:1787`). So a persona with no explicit allowed model can silently resolve to a forbidden provider. This is the exact hole SEC-1..SEC-4 close.
- Per-prompt / per-session model override **already works** end to end and is the mechanism this feature rides on:
  - `SessionPrompt.PromptInput` carries an optional `model { providerID, modelID }` (`packages/opencode/src/session/prompt.ts:1725`).
  - `createUserMessage` persists it onto the user message: `const model = input.model ?? ag.model ?? (yield* lastModel(...))` (`prompt.ts:929`) written into `info.model` (`prompt.ts:944`).
  - `runLoop` resolves the model **from the last user message every turn**: `getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)` (`prompt.ts:1364`), and `lastModel` (`prompt.ts:912`) reads the most recent user message's model as the fallback.
  - Therefore, if each Telegram prompt to a reused chat session is sent with the override `model`, the choice sticks for that turn and later turns.
- `Provider.parseModel` (`provider.ts:1797`) splits a `"providerID/modelID"` string into a branded `{ providerID, modelID }`; it does not validate existence. `Provider.getModel` (`provider.ts:1603`) validates and throws `Provider.ModelNotFoundError`.
- `PersonaConfig` (`packages/opencode/src/persona/index.ts:11`) currently exposes `name`, `model?`, `tools?`, `content`. `parsePersonaFile` (`persona/index.ts:111`) reads only `data.name`, `data.model`, `data.tools`. `PersonaSession.ResolvedPersona` (`packages/opencode/src/persona/session.ts:8`) carries `name`, `config`, `systemPrompt`, `model?`.
- Telegram already dispatches slash commands inside `handleMessage` (`packages/opencode/src/telegram/bot.ts:160-173`, delegating unknown ones to `HarnessCommands.execute`) and already handles inline-keyboard callbacks in `handleCallbackQuery` (`bot.ts:312`) with prefix branches (`QUESTION_PREFIX = "q:"`, `CUSTOM_PREFIX = "qcustom:"`, `bot.ts:48`). Inline keyboards are sent via `sendMessageWithKeyboard` (`packages/opencode/src/telegram/api.ts:44`), which renders **one button per row** (`rows = buttons.map((b) => [b])`, `api.ts:53`).

## WHAT

Behavioral requirements. `WHEN`/`SHALL` are literal tokens. Negative requirements use `SHALL NOT`. Cross-cutting IDs (CC-n, SEC-n) are from `sdd-00`.

### Persona model policy (SEC-4)

1. WHEN a persona file is parsed, the system SHALL read an optional frontmatter object `models: { allow?: string[]; deny?: string[] }` of `providerID/modelID` globs and expose it on `PersonaConfig.models`; WHEN the frontmatter omits `models`, the field SHALL be `undefined` and behavior SHALL be unchanged from today.
2. WHEN matching an effective model `{ providerID, modelID }` against a glob list, the system SHALL match against the string `` `${providerID}/${modelID}` `` using only two wildcard forms: a trailing `*` and a bare `*` segment (e.g. `anthropic/*`, `openai/*`, `openai/gpt-5*`, `*`); it SHALL introduce no new dependency to do so.
3. WHEN both `allow` and `deny` are present, `deny` SHALL take precedence: a model matching any `deny` glob SHALL be treated as forbidden even if it also matches an `allow` glob.
4. WHEN `allow` is present and a model matches no `allow` glob, the model SHALL be treated as forbidden (allow acts as an allowlist). WHEN `allow` is absent, every model not matching `deny` SHALL be treated as allowed.

### Enforcement choke point (SEC-1)

5. WHEN the daemon executor is about to send a prompt for a session whose resolved persona declares any `models` policy, the system SHALL compute the concrete effective model and assert it is allowed at a single helper (`assertModelAllowed(policy, model)`) in `buildDefaultExecutor`, before calling `sdk.session.prompt`, and SHALL throw a clear, named error (not a downgrade) when the model is forbidden. The guard SHALL read the policy from `resolvedPersona.config.models` (the real location per SC-4), NEVER from a non-existent `resolvedPersona.models`. An `undefined` policy read is a bug, not an allow-all; the helper SHALL be given the actual policy carrier (`resolvedPersona.config`) so it cannot silently no-op.
6. WHEN neither a chat override nor a persona frontmatter `model` supplies an explicit model and the persona declares a `deny` list, the system SHALL resolve the effective model concretely (via `Provider.defaultModel`) and run it through `assertModelAllowed` before use; it SHALL NOT pass `undefined` down to the SDK such that a denied default could be selected without a check. (This closes the fallback hole in `runner.ts:91`.)
7. WHEN `assertModelAllowed` throws, the failure SHALL propagate to the caller as an error result (delivered to chat per CC-5) and the system SHALL NOT silently substitute any other model.
8. The enforcement SHALL live in the shared executor so it covers **all** entry points that run through `HeadlessSession.run` (Telegram worker, scheduler, mesh), not only `/model`. No caller SHALL be able to reach `sdk.session.prompt` for a policy-bearing persona without passing through `assertModelAllowed`.

### Startup / first-use validation (SEC-2)

9. WHEN a persona that declares ANY `models` policy (a `deny` list, an `allow` list, or both) is resolved (`PersonaSession.resolve`), the system SHALL validate that the persona also declares an explicit frontmatter `model` and that this `model` is itself allowed under its own `allow`/`deny` policy; WHEN it does not, the system SHALL fail loudly with a clear error naming the persona, and SHALL NOT fall back to an unconstrained default. (SEC-2, SC-4: allow-only personas are covered — a persona declaring an `allow` list whose frontmatter `model` is absent or falls outside that list SHALL fail validation, exactly as a `deny`-declaring persona does.)
10. WHEN the Katya persona is loaded and its `model` is absent or resolves to a denied provider, the resolution SHALL fail (per requirement 9) rather than continue toward a `claude/*` or `gpt/*` default.
10a. WHEN a persona that is configured/expected to carry a `models` policy fails to parse or load (malformed YAML frontmatter, missing file, renamed file, or any load error), the system SHALL fail closed: it SHALL raise a clear, named error rather than resolve to an unconstrained default, and SHALL NOT fall open to permitting all providers. (SEC-4, CC-8: the security boundary is tied to load success, not merely to successful parse; a silently missing policy is a denial, never an allow-all.)

### `/model` command (SEC-3, chat-scoped)

11. WHEN a chat sends `/model` with no argument, the system SHALL reply with the current effective model for that chat and render an inline keyboard (via `sendMessageWithKeyboard`) of allowed models, each button carrying `callback_data` of the form `` `model:${providerID}/${modelID}` ``.
12. WHEN building the `/model` keyboard, the system SHALL exclude every model forbidden for the active persona (defense in depth over SEC-1), SHALL order candidates via `Provider.sort`, and SHALL cap the keyboard to at most N buttons (N = 8) because `sendMessageWithKeyboard` renders one button per row.
13. WHEN a chat sends `/model <providerID>/<modelID>`, the system SHALL parse it with `Provider.parseModel`, validate it exists (`Provider.getModel`) and is allowed for the active persona, and on success SHALL persist it as the per-chat override and confirm; WHEN it is unknown or forbidden, the system SHALL reply with a clear error and SHALL NOT change the stored override.
14. WHEN a `/model` inline selection callback (`data` starting with `model:`) arrives, `handleCallbackQuery` SHALL parse the provider/model, re-check it against the persona policy, persist it as the per-chat override on success, and confirm; WHEN the selected model is forbidden, the system SHALL answer with an error and SHALL NOT change the stored override. `/model` SHALL be handled in the Telegram bot, not in `HarnessCommands`.
15. WHEN a per-chat override is set, the system SHALL store it in `telegram_session.model_override` for that `chat_id` via `TelegramStore.setModel(chatId, model)`, and WHEN the override is cleared it SHALL store `null` via `TelegramStore.setModel(chatId, null)` (CC-1: durable, survives restart).

### Threading the override into execution

16. WHEN a chat message is ingested, the system SHALL populate `payload.model` from that chat's `telegram_session.model_override` (parsed via `Provider.parseModel`); WHEN the Telegram worker executes that job, it SHALL forward `payload.model` through `HeadlessSession.run` → `SessionRunner` → `Runner.SessionExecutor.execute` → `sdk.session.prompt` (per SC-2), and SHALL NOT re-read `TelegramStore.getModel` at drain time.
17. The effective-model precedence at the executor SHALL be: explicit chat override (requirement 15) > persona frontmatter `model` > session/agent default (`Provider.defaultModel`). The chosen model SHALL be passed explicitly to `sdk.session.prompt` so it is persisted on the user message (`prompt.ts:944`) and reused by `runLoop` (`prompt.ts:1364`).
18. WHEN a chat sets an allowed override and then sends further messages in the same durable session, each subsequent prompt SHALL carry that override, so the selection sticks for later turns (verified via the persisted `info.model`).

### `/status` command

19. WHEN a chat sends `/status`, the system SHALL reply with the chat's `session_id` (from `telegram_session`), the active model (the override if set, otherwise the persona/default effective model), and the active persona name.

### Non-regression

20. WHEN this feature is implemented, the existing test suite SHALL remain green and typecheck SHALL pass (CC-9). Personas that declare no `models` policy SHALL behave exactly as before (no new failure paths, no forced explicit resolution).

## HOW

### Reuse map (existing code to extend, with anchors)

| Concern | Reuse | Anchor |
|---|---|---|
| Parse `providerID/modelID` string | `Provider.parseModel` | `provider.ts:1797` |
| Validate a model exists | `Provider.getModel` (throws `ModelNotFoundError`) | `provider.ts:1603`, error `provider.ts:1805` |
| Enumerate providers/models for the keyboard | `Provider.list` (`Interface.list`) | `provider.ts:1460`, `:994` |
| Rank keyboard candidates | `Provider.sort` | `provider.ts:1788` |
| Concrete default resolution for fallback | `Provider.defaultModel` | `provider.ts:1737` |
| Persona parse | `parsePersonaFile` | `persona/index.ts:111` |
| Persona resolve + validation hook | `PersonaSession.resolve` | `persona/session.ts:24` |
| Executor choke point | `Runner.buildDefaultExecutor` | `runner.ts:44`, model resolve/pass `runner.ts:91-96` |
| Run-chain seam | `HeadlessSession.run` / `SessionRunner` / `Runner.wire` | `headless.ts:31,12,22`; `runner.ts:23-31` |
| Per-prompt model already persisted/resolved | `PromptInput.model`, `createUserMessage`, `lastModel`, `runLoop` | `prompt.ts:1725,929,912,1364` |
| Slash-command dispatch | `handleMessage` command branch | `bot.ts:160-173` |
| Inline keyboard send | `sendMessageWithKeyboard` (one button per row) | `api.ts:44-56` |
| Callback prefix branching | `handleCallbackQuery` | `bot.ts:312`, prefixes `bot.ts:48` |
| Durable model_override storage | `TelegramStore` accessors over the SDD-04-owned `telegram_session` table (NO new table/migration, SC-1) | `src/queue/queue.sql.ts` (`telegram_session`), `TelegramStore.setModel/getModel` |

Per CC-10, no new mechanism is introduced where these fit: the override rides the existing `PromptInput.model` path, the keyboard rides `sendMessageWithKeyboard`, and durable state rides the SDD-04-owned `telegram_session.model_override` column (declared once per SC-1; SDD-02 issues no `CREATE`/`ALTER` and only reads/writes via `TelegramStore`).

### New / changed code

**1. Persona policy type + parse (`persona/index.ts`).**
- Extend `PersonaConfig` (`:11`) with `readonly models?: { allow?: string[]; deny?: string[] }`.
- In `parsePersonaFile` (`:111`), read `data.models` and coerce `allow`/`deny` to `string[] | undefined` (mirroring the existing `tools.require/prefer` array-guarding at `:118-123`).
- Add a pure helper module (e.g. `persona/policy.ts`) exporting:
  - `matchesGlob(modelKey: string, glob: string): boolean` — anchored match where `*` → `.*` after regex-escaping the rest. No dependency added.
  - `isModelAllowed(policy, modelKey): boolean` — deny-wins, then allowlist semantics (requirements 3-4). `modelKey = ` `` `${providerID}/${modelID}` ``.
  - `assertModelAllowed(config: PersonaConfig, model: { providerID; modelID }): void` — throws a named error (reuse `NamedError` style, e.g. `Persona.ModelForbiddenError` carrying `config.name`, `model`) when `!isModelAllowed(config.models, key)` (requirement 5). NORMATIVE: the policy is read from `config.models`, the real field (SC-4). The helper SHALL be called with the `PersonaConfig` (which carries both `name` and `models`), NOT with a `ResolvedPersona` — `ResolvedPersona` (`persona/session.ts:8`) has no top-level `models`, so passing it would read `undefined` and silently no-op. TypeScript does not catch that (`models?` is optional), so this field path is a normative requirement, not a suggestion.
  - `validateModelPolicy(config: PersonaConfig): void` — SEC-2 (requirement 9, SC-4): WHEN `config.models` declares ANY policy (`deny` present, `allow` present, or both), require `config.model` to exist AND satisfy `isModelAllowed(config.models, key)`; else throw a named error naming the persona. This covers allow-only personas: an `allow` list whose frontmatter `model` is absent or outside the list fails validation exactly as a `deny`-only persona does.

**2. Startup / first-use validation (`persona/session.ts`).**
- In `PersonaSession.resolve` (`:24`), after `Persona.buildSystemPrompt`, call `validateModelPolicy(config)` and let it throw (do not swallow). `Persona.resolve` (`persona/index.ts:58`) currently downgrades load failures to `undefined`; the policy failure must be a hard throw that reaches the executor, so it is raised in `PersonaSession.resolve` where callers already expect throws (see the missing-MCP throw at `session.ts:39`).
- **Fail closed on load/parse failure (requirement 10a, SC-4).** A persona named by a chat/config but whose file is missing, renamed, or has malformed frontmatter currently flows `parsePersonaFile` swallow (`index.ts:126-127`) → `Persona.resolve` swallow-to-`undefined` (`index.ts:58-68`) → `PersonaSession.resolve` returns `undefined` (`session.ts:33-36`) BEFORE `validateModelPolicy` runs, so the policy silently vanishes and the executor falls to the unconstrained default. To close this: WHEN `PersonaSession.resolve` is asked for a persona that was explicitly requested (a non-empty persona name resolved from `telegram_session.persona`/config, not the "no persona" case) and the load yields `undefined`, it SHALL throw a clear, named error (e.g. `Persona.PolicyLoadError` naming the persona) rather than return `undefined`. The security boundary is thus tied to load success, never to a best-effort parse. Personas that are genuinely absent by design (no persona requested at all) are unaffected — this only fails closed for a persona that was named and expected to resolve.

**3. Run-chain `model` parameter (consumed; owned by SDD-04 per SC-2).**
- The run-chain `model` parameter — optional `model?: { providerID: string; modelID: string }` on the `HeadlessSession.run` input (`src/daemon/headless.ts:31`), the `SessionRunner` type (`src/daemon/headless.ts:12`), `Runner.SessionExecutor.execute` (`src/daemon/runner.ts:9`), and the `Runner.wire` adapter (`src/daemon/runner.ts:23`) — is **owned and added once by SDD-04** (SC-2). SDD-02 does **not** edit `headless.ts`/`runner.ts` to add these signatures; it CONSUMES the `model` parameter, mirroring how SDD-01 consumes `sessionId`.
- SDD-02's responsibility is to POPULATE the parameter: ingestion reads the chat's `telegram_session.model_override`, parses it via `Provider.parseModel` (`src/provider/provider.ts:1797`), and places the result on `payload.model`; SDD-04's worker forwards `payload.model` into `HeadlessSession.run({ ..., model })`. The precedence + guard in item 4 (also inside `buildDefaultExecutor`, complementary to SDD-04's resume/create branch) then applies.

**4. Executor choke point (`runner.ts:buildDefaultExecutor`).**
Replace the model resolution at `:91` with explicit precedence + guard:
```
// precedence: chat override > persona frontmatter > default
let effective =
  model /* chat override */
  ?? (resolvedPersona?.model ? Provider.parseModel(resolvedPersona.model) : undefined)

if (!effective && resolvedPersona?.config.models) {
  // never let a policy-bearing persona fall through to an unchecked default
  effective = await AppRuntime.runPromise(Provider.defaultModel())
}
if (resolvedPersona?.config.models && effective) {
  // NORMATIVE (SC-4): pass the policy CARRIER (resolvedPersona.config), never
  // resolvedPersona itself. ResolvedPersona has no top-level `models`
  // (persona/session.ts:8); passing it would read `undefined` and silently
  // no-op the guard. assertModelAllowed reads config.models internally.
  assertModelAllowed(resolvedPersona.config, effective)   // SEC-1, throws on deny
}
const response = await sdk.session.prompt({
  sessionID,
  parts: [{ type: "text", text: prompt }],
  ...(effective ? { model: effective } : {}),
} as any)
```
This satisfies requirements 5-8 and 17: the guard fires for policy-bearing personas whether the model arrived by override, frontmatter, or default fallback; personas with no `models` policy keep the original `undefined`-passthrough behavior (requirement 20). The gate condition (`resolvedPersona?.config.models`) and the helper call (`assertModelAllowed(resolvedPersona.config, …)`) read `models` from the SAME field — `config.models` — so the guard cannot be a no-op. An `undefined` policy is impossible on this path because a policy-bearing persona that failed to load has already thrown (requirement 10a); if `config.models` is genuinely absent the persona is non-policy and the guard is correctly skipped.

**5. `telegram_session.model_override` store accessors (column OWNED by SDD-04).**
- The `model_override` column is declared EXACTLY ONCE by the SDD-04 foundation table (`src/queue/queue.sql.ts`, migration `migration/20260719120000_telegram_queue/migration.sql`, per master SC-1). SDD-02 SHALL NOT issue any `CREATE TABLE` or `ALTER TABLE` and SHALL NOT add a separate migration for this column — it only READS/WRITES it through `TelegramStore`. Per SC-1 the authoritative type is `model_override` TEXT NULL storing a JSON-encoded `{ providerID, modelID }`; `TelegramStore` handles the parse/stringify.
- Add to the `TelegramStore` (defined against the SDD-04-owned table) these data-access accessors (new methods only, no schema change):
  - `setModel(chatId: string, model: { providerID; modelID } | null): Promise<void>` — upsert the `model_override` cell within `Database.transaction`.
  - `getModel(chatId: string): Promise<{ providerID; modelID } | null>` — read + parse the column. Consumers: `/model`, to show the current override (requirement 12), and `/status` (requirement 19). It is NOT used by ingestion or the worker: ingestion reads the whole `telegram_session` row via `TelegramStore.getByChat` (SDD-01) to populate `payload.model` per SC-2 (one row read for `sessionId` + `model` + `persona`), and the worker forwards `payload.model`.

**6. `/model` + `/status` in the Telegram bot (`telegram/bot.ts`).**
- Add a `MODEL_PREFIX = "model:"` alongside the existing prefixes (`:48`).
- In `handleMessage` command branch (`:160-173`), before delegating to `HarnessCommands`, intercept `/model` and `/status` (they are chat-scoped and need `chatId`, persona resolution, `TelegramStore`, and the provider list — bot-layer concerns. Note: SDD-04 W-24 adds `ctx: { chatId? }` to `HarnessCommand.execute`, so the registry can carry `chatId`; these commands are kept local for the bot-layer dependencies above, not because the registry lacks `chatId`):
  - `/model` no arg → resolve current effective model (override else persona/default), build allowed candidate list from `Provider.list`, filter via `isModelAllowed`, sort via `Provider.sort`, cap to 8, and `sendMessageWithKeyboard` with `callback_data = ` `` `model:${providerID}/${modelID}` ``.
  - `/model <arg>` → `Provider.parseModel` → `Provider.getModel` (exists?) → `isModelAllowed` (allowed?) → `TelegramStore.setModel` + confirm, else error (requirement 13).
  - `/status` → read `telegram_session` (session_id, model_override) + `_config.persona`; reply (requirement 19). Note: this chat-scoped `/status` intentionally SHADOWS the pre-existing registry `/status` ("Daemon health and uptime", `src/harness/commands.ts:48`) on the Telegram surface, because the per-chat view (session, model, persona) is more useful there; the registry `/status` remains available on other transports.
- In `handleCallbackQuery` (`:312`), add an `else if (data.startsWith(MODEL_PREFIX))` branch: parse `providerID/modelID`, re-check `isModelAllowed`, `TelegramStore.setModel`, confirm via `answerCallbackQuery` + `sendMessage`; on forbidden, answer with an error and leave the override unchanged (requirement 14, SEC-3).

**7. Override travels via the job payload (SC-2).**
- Ingestion reads the chat's `telegram_session` row via `TelegramStore.getByChat` (SDD-01) and populates `payload.model` from its `model_override` (parsed via `Provider.parseModel`); SDD-04's worker forwards `payload.model` into `HeadlessSession.run({ ..., model })` (SDD-04 `drain`, W-12). The worker SHALL NOT call `TelegramStore.getModel` at drain time, and ingestion uses `getByChat` (not `getModel`) — `getModel` is used only by the `/model` and `/status` commands. Because SDD-01 reuses one durable session per chat and the override rides every prompt, the choice persists across turns (requirement 18) via `info.model`/`lastModel`.

### Precedence and ordering rules (normative)

- Effective model = first defined of: chat `model_override` → persona `model` → `Provider.defaultModel()`.
- Policy evaluation order = `deny` first (forbidden if matched), then `allow` allowlist (forbidden if `allow` present and unmatched), else allowed.
- Guard placement = exactly one call site (`buildDefaultExecutor`, after persona resolution, before `sdk.session.prompt`). `/model` keyboard filtering and selection re-checks are defense in depth and never the sole gate.

## VERIFY

Independent agents exercise these against the mocked-Telegram harness plus injectable stubs: `PersonaSession.resolve(..., { load })` for persona frontmatter, a mock `Runner.SessionExecutor` / captured `sdk.session.prompt` argument for model assertions, and the in-memory/SQLite `TelegramStore`. Each criterion states setup, action, expected. Criteria map 1:1 to WHAT.

**V1 — persona policy parse (WHAT 1).**
Setup: persona markdown with `models:\n  deny: ["anthropic/*", "openai/*"]\n  allow: ["deepseek/*"]` and `model: deepseek/deepseek-chat`. Action: `parsePersonaFile`. Expected: `config.models.deny == ["anthropic/*","openai/*"]`, `config.models.allow == ["deepseek/*"]`. A persona with no `models` key yields `config.models === undefined`.

**V2 — glob matching + precedence (WHAT 2-4).**
Setup: policy `{ deny: ["anthropic/*"], allow: ["deepseek/*"] }`. Action: `isModelAllowed` over `deepseek/deepseek-chat`, `anthropic/claude-sonnet-4-5`, `openai/gpt-5`. Expected: `true`, `false` (deny), `false` (not in allow). With policy `{ deny: ["anthropic/*"] }` only, `openai/gpt-5` → `true`. With `{ allow: ["*"] , deny: ["anthropic/*"] }`, `anthropic/claude-x` → `false` (deny wins over allow).

**V3 — `/model` no-arg lists only allowed models for Katya, excludes anthropic/openai (WHAT 11-12).**
Setup: mocked Telegram, active persona Katya with `deny: ["anthropic/*","openai/*"]`; `Provider.list` returns a mix including `anthropic/*`, `openai/*`, and allowed providers. Action: chat sends `/model`. Expected: `sendMessageWithKeyboard` is called; every `callback_data` is `model:<allowed>`; no button's provider is `anthropic` or `openai`; button count ≤ 8; order matches `Provider.sort`; the reply text names the current effective model.

**V4 — attempt to set an anthropic model for Katya is rejected, override unchanged (WHAT 13-14, SEC-3).**
Setup: Katya persona (deny anthropic/openai), no override set. Action (a): `/model anthropic/claude-sonnet-4-5`. Action (b): a `model:anthropic/claude-sonnet-4-5` callback. Expected (both): a clear error reply, `TelegramStore.getModel(chatId)` still returns the prior value (unchanged / `null`); `setModel` is never called with the forbidden model.

**V5 — set an allowed model; subsequent prompts use it (WHAT 15-18).**
Setup: Katya persona, allowed provider available. Action: `/model deepseek/deepseek-chat`, then two chat messages in the same durable session. Expected: `TelegramStore.setModel` stored `{ providerID: "deepseek", modelID: "deepseek-chat" }`; each execution passes that `model` to `sdk.session.prompt`; the persisted user message `info.model` equals the override on both turns (asserting the choice sticks via `lastModel`/`runLoop`).

**V6 — persona with a policy but no valid model FAILS validation, incl. allow-only (WHAT 9-10, SEC-2, SC-4).**
Setup: Katya persona with `deny: ["anthropic/*","openai/*"]` but **no** `model`. Action: `PersonaSession.resolve("katya", [], { load })`. Expected: it throws a clear error naming `katya`; it does NOT return a persona; nothing downstream resolves to `claude/*` or `gpt/*`. Second case: persona declares `model: anthropic/claude-sonnet-4-5` while denying `anthropic/*` → also throws. Third case (allow-only, SC-4): persona declares `allow: ["deepseek/*"]` with NO `deny` and NO frontmatter `model` → throws naming the persona. Fourth case (allow-only mismatch, SC-4): persona declares `allow: ["deepseek/*"]` and `model: openai/gpt-5` (outside the allow list) → throws. Neither allow-only case falls through to `defaultModel`.

**V6a — fail-closed on persona load/parse failure (WHAT 10a, SEC-4, CC-8).**
Setup: a chat/config names persona `katya`, but the injected `load` yields `undefined` (simulating a missing/renamed file or malformed YAML frontmatter that `parsePersonaFile`/`Persona.resolve` would swallow). Action: `PersonaSession.resolve("katya", [], { load })`. Expected: it throws a clear, named error (e.g. `Persona.PolicyLoadError`) naming `katya` rather than returning `undefined`; the executor is never reached with a null policy; no default (`claude/*`, `gpt/*`) is resolved. Control: `PersonaSession.resolve` with NO persona requested (the genuine "no persona" case) does NOT throw and behaves as before.

**V7 — executor choke point rejects a denied model arriving via fallback, and reads the RIGHT field (WHAT 5-8, SEC-1, SC-4).**
Setup: a policy-bearing persona (`deny: ["anthropic/*"]`, valid `model` present) but the test forces the effective model to a denied value by supplying a chat override `anthropic/claude-x` straight into the run-chain (bypassing `/model`'s pre-filter). Action: run through `buildDefaultExecutor`. Expected: `assertModelAllowed` throws before `sdk.session.prompt` is called (spy records zero prompt calls); the error surfaces as the run result. Second case (fallback path): no override, no frontmatter model on a deny-list persona → executor resolves `Provider.defaultModel()`, and if that default is denied the guard throws rather than sending it (no silent downgrade). Third case (field-path correctness / no-op guard regression, SC-4): drive a denied model through EACH path — chat override, persona frontmatter `model`, and `defaultModel()` fallback — for a `deny`-list persona and for an `allow`-only persona; every path SHALL throw `Persona.ModelForbiddenError` and record zero `sdk.session.prompt` calls. This proves the guard reads `resolvedPersona.config.models` (not the non-existent `resolvedPersona.models`): were it reading the wrong field, the policy would be `undefined`, the guard would return allowed, and `sdk.session.prompt` would be called with the denied model — the assertion of zero prompt calls fails in that case. The test SHALL construct the executor with a real `ResolvedPersona` (whose policy lives only under `.config.models`) so a wrong-field read is observably non-throwing.

**V8 — non-policy persona is unaffected (WHAT 20).**
Setup: persona with no `models` key and no frontmatter `model`. Action: run through `buildDefaultExecutor`. Expected: `model` passed to `sdk.session.prompt` is `undefined` exactly as before (no forced `defaultModel` resolution, no guard call); behavior is byte-identical to pre-change.

**V9 — `/status` reports session, model, persona (WHAT 19).**
Setup: chat with a durable `telegram_session` row and an override set. Action: `/status`. Expected: reply contains the chat's `session_id`, the active model (the override), and the persona name; with no override, it reports the persona/default effective model.

**V10 — build/regression (CC-9, WHAT 20).**
Action: `bun run typecheck` (or `tsc --noEmit`) and `bun test` for the package. Expected: typecheck passes; the full suite is green, including the added persona-policy, executor-guard, and `/model`/`/status` tests. No pre-existing test is left red or removed to pass.
