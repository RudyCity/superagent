# SuperAgent Runtime Supervisor — Batch 7 Independent Pre-Merge Audit

Date: 2026-10-29  
Reviewed commit: `2300852c`  
Branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`  
Decision: **BLOCK MERGE / NOT PRODUCTION CERTIFIED**  
Auditor: Independent verification, not the implementing AGY or author of Batch 7.  
Scope: Read-only source inspection, non-destructive fault/logic reproductions, complete regression rerun. No source/test edits, commit, merge, rebase or push during this audit.

## Executive result

The Batch 7 OS-managed SQLite transaction lock, unconditional denial of manual pathname lock recovery, strict default-deny operator capability and removal of automatic retry are real improvements. However, two **confirmed P0 outcome-integrity defects** remain in `processReconciliation.ts`. A checkpoint field without authenticated provenance can still suppress review for potential side effects or manufacture an apparently "authoritative" successful verification. The SQLite/legacy lock protocols also remain mutually incompatible during rolling deployment, an explicitly documented migration prerequisite requiring enforcement.

Full existing tests passed but do not exercise these adverse cases.

## Confirmed findings

### P0-1 — Untrusted non-mutating checkpoint suppresses required operator review

Source: `src/core/process/processReconciliation.ts:414-418,584-644`.

The new `isProvenReadOnly=false` disables automatic retry but **does not alter** `hadMutatingWrite = checkpoint.hasMutatingWrite === true`. If a structurally valid checkpoint says `hasMutatingWrite:false`, the reconciliation of a failed/nonzero-exit terminal job can follow the "definitive non-mutating failure" path, mark `requiresReview:false`, and claim zero side effects without independent evidence.

Direct in-memory reproduction:
- Terminal process `state:'failed'`, `exitCode:1`, consistent `terminalObservation.exitCode:1`.
- Job `job_false_readonly`.
- Well-formed local checkpoint `hasMutatingWrite:false`, `verificationState:'failed'`, `lastEvent:'job_finished_failed'`.
- Actual output:
```json
{"jobId":"job_false_readonly","reconciledStatus":"failed","hasMutatingWrite":false,"requiresReview":false,"eligibleForRetry":false}
```
`mutatingJobsRequiringReview:0`.

Evidence: command `cmd_1793242592836_eyhw6`.

This is **not** evidence that a particular real job wrote data; it demonstrates that the classification cannot prove non-mutation from the offered checkpoint. Fix requires a canonical trusted read-only attestation before setting `hasMutatingWrite:false` or `requiresReview:false` for ambiguous outcomes. Otherwise fail closed to `unknown_outcome_review_required` and count the item as review-required.

### P0-2 — Verified success accepted solely from checkpoint status flag

Source: `src/core/process/processReconciliation.ts:467-504,572-583`.

`hasConsistentVerifiedProof` accepts a checkpoint with `verificationState:'verified'` or `'artifacts_verified'` and no contradicting fields as authoritative evidence, even if `lastEvent` contains arbitrary text and no actual verifier receipt/artifact assertion is supplied or independently checked. The job is then classified `succeeded` and `requiresReview:false`.

Direct in-memory reproduction:
- Terminal process with consistent clean `exitCode:0` and matching terminal observation.
- Checkpoint `{checkpointId:'cp_success', jobId:'job_untrusted_success', timestamp:now, lastEvent:'arbitrary', resourceClaims:[], verificationState:'verified', hasMutatingWrite:true}`.
- Results for BOTH `verified` and `artifacts_verified`:
```json
{"reconciledStatus":"succeeded","hasMutatingWrite":true,"requiresReview":false,"eligibleForRetry":false}
```

Evidence: `cmd_1793242636710_vf22k`.

No external tampering route is proven. This is a **verified-completion evidence-contract defect**: a local self-reported status is not independent durable proof of verified side effects. Require authenticated, job-bound verifier receipts with explicit successful result, artifact checks, and terminal-consistency evidence (and distrust arbitrary checkpoint strings on restart); otherwise retain review status.

### P1-1 — SQLite and legacy pathname locks can coexist

Source: `src/core/process/processRegistry.ts:375-427`.

New writer checks `<registry>.lock` before and after `BEGIN IMMEDIATE`. A legacy writer can create its lock *after* that check, while the SQLite transaction is still active. These are two independent lock namespaces. Thus the new protocol does not itself prevent cross-version concurrent writes. This is acknowledged in the Batch 7 migration notes but **no enforced upgrade barrier or process proof** exists in the code reviewed.

Direct isolated D: reproduction: inside an active SQLite registry critical section, `fsp.open(<registry>.lock, 'wx')` succeeded. Output:
```json
{"newSqliteWriterInsideCriticalSection":true,"legacyLockAcquisitionAlsoSucceeded":true}
```

Evidence: `cmd_1793242638628_x5i9b`. The temporary test directory was removed; no production registry lock was changed.

Mandatory gate: supervised shutdown of *all* legacy writers, verification against process ownership/creation identities, backup and operator-approved legacy lock migration, and a startup protocol/version fence before activating SQLite-only writers. Do **not** perform rolling mixed-version deployment or delete stale legacy locks automatically.

### P1-2 — Global operator access has no production identity-provider wiring

Source: `src/core/process/processSupervisor.ts:84-93,174-204`.

The new capability is immutable and identity-bound, and no capability is issued without a runtime-supplied trusted authorizer. This is a valid default-deny mechanism. Source search found only tests constructing `trustedOperatorAuthorizer`, not a production authenticated host integration. Consequently legitimate global diagnostics remain unavailable until the host supplies and verifies real operator principals. Not a privilege bypass in current routes; it is an incomplete integration gate.

### P2-1 — Checkpoint timestamp validity does not enforce age

Source: `src/core/tools/cliBridgeReconciliation.ts:27-45`.

A structurally valid checkpoint with `timestamp:1` passes `isValidJobCheckpoint`. Independent reproduction: `{"checkpointTimestamp":1,"valid":true}` (evidence `cmd_1793242640112_m7ooz`). Auto-retry remains disabled, so this is not a current P0 retry bypass; however it contradicts any claim of freshness validation. Define lifetime, generation and replay protection when introducing attested receipts.

### P2-2 — Environment risk: Windows temp drive nearly full

At the start of this audit `C:/Users/USER/AppData/Local/Temp` had ~5.8 GiB available out of 601 GiB total, while D: had ~61 GiB available. Temp pressure could affect processes and tests. No global cleanup was attempted.

## Positive independent verification

1. `bun test --timeout 30000` on **18 suites / 204 tests** — **204 passed, 0 failed, 1009 assertions**, 52.36 seconds. Temporary files redirected to an audit-only folder on D:. Includes Windows subprocess splash/descendant regression tests, registry concurrency tests, and all Batch 4/5/6/7 remediation suites. Evidence: current audit command after prior independent reproductions.
2. `bun run build` — exit 0, TypeScript and MCP schema synchronization successful. Evidence: `cmd_1793242738175_tbo3x`.
3. `git diff --check HEAD^..HEAD` — exit 0.
4. Branch `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028` HEAD unchanged `2300852c`, two commits behind / seven commits ahead of `main`; main and pre-existing dirty files unchanged.
5. Old pathname recovery API always refuses; new SQLite lock paths do not unlink ownership files on completion. Existing tests demonstrate SQLite transaction exclusion between cooperating new writers. These improvements are not disputed.
6. `reconcileJobOnRestart` now blocks automatic retry when checkpoint is invalid, and also when a local checkpoint only says read-only. The P0 findings are in the separate `processReconciliation.ts` result/verification classifier.

## Pre-merge gates

1. Fix P0-1 and P0-2 by moving all job reconciliation branches to a **single trusted evidence policy**: malformed, replayed, or self-declared checkpoint status must not prove non-mutation or verified success. Add negative tests exactly matching the independent reproductions (including `lastEvent:'arbitrary'`).
2. Define and implement verifier provenance, ownership binding, immutable receipt integrity and explicit artifact verification, or keep ambiguous outcomes review-required.
3. Enforce a real single-version migration barrier and audit legacy process shutdown before SQLite-only deployment. Add a test that no legacy writer can acquire a lock while a new writer is active **or** explicitly require an operator-controlled downtime gate that prevents this state.
4. Integrate host-authenticated operator policy for legitimately privileged diagnostics, with no untrusted plugin path.
5. Run Windows reboot/power-loss and antivirus-contention drills; evaluate SQLite coordination file handles and recovery under crash.
6. Keep `main` untouched, do not reset dirty worktrees, and do not merge until an independent gate rerun passes.

**Decision: BLOCK MERGE. Do not label as globally production-certified.**
