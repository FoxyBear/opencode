# Verification: SDD-01 durable per-chat sessions

VERDICT: PASS

Independently-derived acceptance tests (`test/telegram/verify/sdd-01.test.ts`,
authored from the spec VERIFY without reading implementation bodies) run green:
16 pass, 2 todo, 0 fail, stable across repeated runs.

## Coverage (1:1 with SDD-01 VERIFY)
- V1/V2 durable resume: message A then B target the SAME session_id; the second
  resumes (one create); new id written back to job_queue + telegram_session.
- V3 stale-id self-heal (create-on-stale overwrites both tables, normal reply).
- V4 mapping survives job success AND error terminal states.
- V5 restart durability: stored id read from SQLite and resumed.
- V6 /new nulls session_id, preserves model_override + persona, next message
  creates a new distinct id; /new enqueues no job; bypasses the registry.
- V7 /resume binds an existing id, rejects missing/no-arg without changing state.
- V8/V9 per-chat ordering + cross-chat independence.
- V10 legacy TTL/summary continuity removed (static + behavioral).
- V11 /new,/resume bypass HarnessCommands; /peers (non-chat-scoped) reaches it.
- V12 no SDD-01 model resolution (payload.model undefined without override).

## Documented gaps (todo, not hidden)
- V2b message-stream context accrual: the harness stubs the executor, so no
  message/part rows are written; real accrual is the reused TUI/web run-loop,
  outside SDD-01's own code.
- V13 whole-repo typecheck + full suite: a CI-level gate, not a single unit test
  (enforced separately by `make sdd implement` typecheck + baseline-tolerant run).

Neither gap leaves core SDD-01 behavior unverified. No implementation bug found.

Note: RETROACTIVE — tests were derived after implementation (not red-first), per
the one-time exception recorded in the pipeline state.
