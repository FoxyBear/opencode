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

## Amendment A (2026-07-20): /model search picker

The flat 8-cap picker (found inadequate during the live smoke: a provider has
~200 models) was replaced by a search-first + recent + paginated picker
(requirements A1-A6, VERIFY VA1-VA5). Unlike the main suite, Amendment A was
implemented GENUINELY test-first: the VA1-VA5 acceptance tests were written and
run RED (6 failing: feature absent) BEFORE implementation, then GREEN (34 pass,
0 fail). VA3 proves the Telegram 64-byte callback_data limit is respected — a
>64-byte model key is selectable via a short `model:pick:<n>` token while every
rendered callback_data is asserted <= 64 bytes (a latent bug the flat scheme
would have hit). VA4/VA5/A5 confirm the Katya deny boundary holds across recent,
suggested, and search surfaces, and a stale/forbidden token changes nothing.

Note: RETROACTIVE flag applies to the ORIGINAL SDD-02 suite (tests after code).
Amendment A was red-first.
