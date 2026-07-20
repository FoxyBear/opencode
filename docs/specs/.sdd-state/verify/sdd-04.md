# Verification: SDD-04 split queue / worker / routing

VERDICT: PASS

Independently-derived acceptance tests (`test/telegram/verify/sdd-04.test.ts`,
authored from the spec without reading queue/worker/bot bodies) run green: 11
tests, 9 pass, 2 todo, 0 fail, stable across 3 whole-file runs (~2.2-2.8s).

The first attempt at this suite hung in afterEach (a hanging-executor stub that
ignored the abort signal blocked JobWorker.stop); it was discarded and re-derived
with clean teardown (ack-first proven without starting the worker; the one gated
runner races its gate against the shutdown AbortSignal).

## Coverage (1:1)
V-1 dup update_id -> one job + one inbox row; V-2 ack-first (pending job + ack +
ack_message_id set, no inline execution); V-2a crashed ack send -> null
ack_message_id, atomic inbox+job present, offset max+1, delivered via fresh
sendMessage not edit; V-3 worker runs job -> delivered by EDITING the ack,
session_id written to both tables; V-5 per-chat ordering (never concurrent, order
preserved); V-6 restart sweep (attempts<max re-queued+delivered; >=max errored to
same ack); V-7 completed-but-undelivered delivered once, idempotent re-edit
"not modified" swallowed; V-10 poll offset = max(update_id)+1; V-13 migration
applied (three tables + indexes exist). Notably covers two paths no sibling test
exercised: the delivery-loop editMessageText routing and the not-modified swallow.

## Documented gaps (todo, not hidden)
- V-2a before-commit companion (crash INSIDE the synchronous ingest transaction):
  no harness seam to fault the transaction; the atomic all-or-nothing property is
  covered positively by V-1 + V-2a.
- V-4 claim atomicity: covered in test/queue/queue.test.ts, not duplicated.

No implementation bug found.

Note: RETROACTIVE — tests derived after implementation.
