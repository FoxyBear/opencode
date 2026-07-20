# Verification: SDD-02 model control + Katya security guard

VERDICT: PASS

Independently-derived acceptance tests (`test/telegram/verify/sdd-02.test.ts`,
authored from SEC-1..4 in the spec without reading implementation bodies or
copying the impl-aware security.test.ts) run green: 30 pass, 2 todo, 0 fail.

## Security core (the Katya invariant) — HOLDS
A deny-policy persona can NEVER resolve to an anthropic/* or openai/* model. A
denied model was driven through EVERY path at the choke point and rejected:
- chat override -> throws
- persona frontmatter model -> throws
- default fallback (biased Provider.defaultModel) -> throws
- allow-only persona, override outside allow -> throws
`sdk.session.prompt` is provably never reached (zero calls) on a denial. A
positive control confirms an allowed override passes (guard is not blanket).
Field-path correctness (SC-4) proven: policy lives only at config.models; a
wrong-field read would return "allowed" and fail these tests.

## Coverage (1:1)
V1 parse allow/deny; V2 glob + deny-wins + allowlist; V4 reject denied via /model
arg and inline callback (override unchanged); V5 allowed selection persists +
threads to prompts; V6 SEC-2 validation (deny+no-model, allow-only+no-model,
allow-only+mismatch); V6a fail-closed on persona load failure; V7 executor guard
all-paths + field-path regression; V8 non-policy persona unaffected; V9 /status.

## Documented gaps (todo, not hidden)
- V3 end-to-end /model keyboard (sort/cap/callback_data shape): the headless test
  env (test/preload.ts) deletes all provider API keys, so Provider.list yields no
  configured providers and the no-arg keyboard is empty. The filter LOGIC is
  covered by the V3 predicate test + V2, and the real security boundary (executor
  guard) by V7.
- V10 whole-repo gate: CI-level, enforced by `make sdd implement`.

The security-relevant behavior is fully covered. No implementation bug found.

Note: RETROACTIVE — tests derived after implementation.
