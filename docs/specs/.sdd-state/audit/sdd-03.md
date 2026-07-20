# Independent Adversarial Re-Audit — SDD-03 Question / Sub-Agent Relay

VERDICT: PASS

**Target:** `docs/specs/260719_telegram_sdd-03-question-relay.md`
**Auditor:** independent re-audit (did not author the spec)
**Date:** 2026-07-19
**Prior verdict:** FAIL (B-1: bare `AppRuntime.runPromise(Question.Service.use(...))` throws `LocalContext.NotFound`, never resolves the parked `Deferred`).

---

## Summary

The BLOCKING defect is fixed and the fix is provably correct against the live code. QR-7, QR-13, and the HOW reuse map now REQUIRE the outbound reply (and every `Question.Service`/durable-store access from the Telegram process or the `Bus.subscribe` fiber) to run inside `Instance.provide({ directory: process.cwd(), init: () => AppRuntime.runPromise(InstanceBootstrap), fn })`, and explicitly FORBID the bare call, naming the exact `LocalContext.NotFound` failure mode. The HOW code shape matches `daemon/runner.ts:56-58` and `server/instance/middleware.ts:68-74` verbatim, and the master's new `## Shared Contract` SC-5 binds SDD-03 with identical language. I verified the crux end-to-end: `InstanceState` (`src/effect/instance-state.ts`) keys its `ScopedCache` by directory string, and the `Question.Service` layer holding that cache is a singleton on `AppRuntime`; the tool parks under `process.cwd()` (via the server middleware fallback / runner wrap) and the reply, wrapped in `Instance.provide({directory: process.cwd()})`, resolves the SAME directory-keyed `pending` map and succeeds the exact `Deferred` (`question/index.ts:112,147,158-172`). Single-host daemon → one `process.cwd()` → deterministic match. Race is closed, VERIFY is hardened, Layer B deletion is safe, and there is no inconsistency with SDD-04's session_id seam.

---

## Verification detail (all points confirmed)

1. **SC-5 / SC-2 (master).** SC-5 exists, binds SDD-03, mandates the `Instance.provide({directory: process.cwd(), init, fn})` wrap, states the bare call throws `LocalContext.NotFound`, and asserts no race because `onSessionCreated` persists `session_id` at creation before `sdk.session.prompt`. SC-2 owns the run-chain/`onSessionCreated` seam in SDD-04. Both consistent with SDD-03.

2. **BLOCKING fix (audit point 2) — CORRECT.** QR-7 (line 37), QR-13 (line 49), HOW reuse map (line 56-66), and Change step 2 (line 79) all require the instance-scoped wrap and explicitly forbid the bare `AppRuntime.runPromise(Question.Service.use(...))`. Code shape matches the two references exactly (`runner.ts:56-58`, `middleware.ts:68-74`, both read and confirmed). Provable resolution: `InstanceState.get` → `ScopedCache.get(cache, directory)` where `directory = (InstanceRef ?? Instance.current)`; the cache is a per-layer singleton on `AppRuntime`, so tool (parked under `process.cwd()`) and reply (wrapped to `process.cwd()`) hit the same map. `Instance.provide`'s `init: InstanceBootstrap` does not touch the Question cache (it lives in the service layer scope, not the Instance context), so re-provide is safe and idempotent.

3. **Correlation / race (audit point 3) — CLOSED.** QR-3 states `onSessionCreated` persists `session_id` to BOTH `job_queue.session_id` and `telegram_session.session_id` at CREATION, before `sdk.session.prompt` and thus before any question fires. Verified in `runner.ts`: `onSessionCreated?.(sessionID)` (line 80) precedes `sdk.session.prompt` (line 92). Child/sub-agent sessions resolve via the already-durable ancestor mapping over a bounded `SessionTable.parent_id` walk (hop cap 8, cycle-safe), not the child's own id — no read-before-write race.

4. **VERIFY hardened (audit point 4) — YES.** V-2 (line 103) now REQUIRES the mocked runner to park the `Deferred` under a real `Instance.provide({directory: process.cwd(), init: InstanceBootstrap})` (exactly as production), forbids parking in a shared/ambient context, and mandates the scenario go RED on a bare-`AppRuntime` implementation ((b)/(c) time out). V-9 (line 117) mirrors this for restart. This closes the prior A-1 testability gap: a regression to the bare call is caught. Round-trip (V-2), sub-agent parent-walk (V-3), and no-chat no-crash (V-4) preserved.

5. **Layer B deletion safe; SDD-04 seam consistent.** Confirmed Layer B (`globalRegister/List/Reply/Reject`, `_globalPending/_globalDeferreds`, `question/index.ts:202-235`) has no callers except `bot.ts` (`globalList` 294/333/397, `globalReply` 409) — the only external consumer, being rewritten. V-1 grep-asserts removal. SDD-04 W-12/W-12a own the dual-write of `session_id` at creation; SDD-03 reads it plus walks `SessionTable.parent_id` (a distinct, complementary session-tree seam). No new inconsistency.

---

## Advisory (non-blocking, does not affect verdict)

- Prior A-2 (fire-and-forget `Queue.setSession` not awaited in `runner.ts:80`) is now correctly neutralized in QR-3/A-3 framing: top-level correlation survives the un-awaited window because the question fires only after the LLM round-trip, and child correlation rides the already-durable ancestor mapping. SDD-04 W-12a should still `await setSession` before dispatch as belt-and-suspenders; not a blocker for SDD-03.

---

VERDICT: PASS
