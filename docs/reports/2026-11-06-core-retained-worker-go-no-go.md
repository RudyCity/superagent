# Core 7888 retained-worker read-only audit — 2026-11-06

## Verified observation

Core status: supervisor PID 25900; active PID 32564; retained PID 35756, 29912, 34160, 11896; 4 retained of maximum 4. `mayCreateCoreGeneration(retained.length)` is false, so restart is refused in `coreSupervisor.ts:486-493`. The status reports zero affinity sessions, **not** proof of no active requests, subprocesses or helper ownership. Current build digest differs from active build; restart is nonetheless capacity-blocked.

Last reported drain inspected one candidate and blocked PID 35756 with “owns helper or adopted process (cannot signal)”; that is historical evidence, not a fresh inspection of all four. No worker was retired by that report. PID 35756 is the earliest listed generation and may be first-generation helper owner, but status alone does not prove which branch of the shared guard applies.

## Source-backed findings

- `coreGenerationPolicy.ts:6,14-16` hard caps retained workers at four.
- `coreSupervisor.ts:254-328` marks the first worker transport/non-isolated and owner of fixed-port vision/Delegate helper. On restart a new worker is API-isolated.
- `coreSupervisor.ts:565-627` refuses drain for exited workers, helper owners, adopted workers, sessions, in-flight requests, missing/unsafe internal reports or failed second inspection. Only a supervisor-owned child is signalled; inspection uses nonce and authenticated localhost endpoint.
- `coreSupervisorCheckpoint.ts` stores generation IDs and session owners, but never expose its bearer tokens. `coreLifecycleLedger.ts` refuses automatic replay of pending operations.
- `coreSupervisor.ts:331-351` status omits generation nonce, child/adopted state, drainEligible, per-worker sessions and in-flight counts; an external auditor cannot assert that a candidate is safe from status alone.

## Safe operational recommendation

**NO-GO** for manual PID termination or forced restart. Obtain an owner-authenticated read-only inspection of each worker with generation nonce, child/adopted ownership, helper/transport flags, session and in-flight counters and two distinct fresh internal drain reports. Reconcile checkpoint and ledger; refuse on any mismatch. The supervisor's guarded drain remains the only permitted retirement workflow, following separate operator authorization.

## Shared-code patch suggestion (not applied)

Add a read-only supervisor-owned `/_core/control/retained-audit` endpoint or CLI command that exposes **redacted** generation identities and individually classified blockers without bearer tokens; include checkpoint reconciliation, adopted/verified flags, session/in-flight counts and drain-report freshness. In `drain()`, consider reporting `!drainEligible` and `adopted` as distinct blocker reasons rather than the current combined “owns helper or adopted process”, and audit all candidates in read-only mode separately before any retirement. Do not lift the four-worker limit or remove retained entries based solely on a zero affinity count.
