# Verification: SDD-03 question / sub-agent relay

VERDICT: PASS

Independently-derived acceptance tests (`test/telegram/verify/sdd-03.test.ts`,
authored from the spec without reading bot.ts/correlation.ts bodies or the
impl-aware correlation.test.ts) run green: 12 pass, 2 todo, 0 fail.

## The critical round-trip — GENUINELY WORKS
V-2 proves the full loop end-to-end: a stub executor calls Question.Service.ask
under a real Instance.provide({directory: process.cwd(), init: InstanceBootstrap})
(as the daemon does); the Bus bridge delivers the inline keyboard to the correct
chat; injecting the button callback resolves the parked Deferred and ask returns
the chosen label; the job reaches done. The author empirically observed that a
bare AppRuntime reply lands on a different pending map and times out (the exact
LocalContext.NotFound failure mode SC-5 warns about) — confirming the
Instance.provide wrapping is what makes the fix work.

## Coverage (1:1 with QR-*)
V-1 Layer B deleted (global* undefined) + exactly one Bus.subscribe(Event.Asked);
V-2 round-trip; V-3 child/sub-agent session routes to the parent chat via
parent_id walk; V-4 no-chat (scheduler/mesh) question not relayed, no throw;
V-5 multi-question one-at-a-time ordered reply; V-6 custom text answer path;
V-7 unknown/expired callback graceful; V-8 answered keyboard edited, no dup;
V-9 restart fails the parked Deferred, durable mapping survives; V-10 worker
onSessionCreated persists mapping and the bridge resolves chat from it.

## Documented gaps (todo, not hidden)
- V-9b post-restart NEW question resolves: requires a genuine fresh process; the
  in-process Instance.reload cannot fully simulate it (persistent AppRuntime/Bus
  survive while the ScopedCache is invalidated). The no-restart round-trip is
  fully proven by V-2. Not a demonstrated production defect.
- V-11 whole-repo gate: CI-level, enforced by `make sdd implement`.

No implementation bug found. Incidental doc nit: resolveChatForSession is sync
while the spec HOW prose said Promise; behavior matches the spec.

Note: RETROACTIVE — tests derived after implementation.
