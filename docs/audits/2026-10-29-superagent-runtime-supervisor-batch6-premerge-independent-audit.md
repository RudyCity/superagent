# SuperAgent Runtime Supervisor Batch 6 — Independent Pre-Merge Audit

Date: 2026-10-29
Worktree: `D:\backup from pc asus\Documents Development\superagent-runtime-supervisor-m2-20261028`
Branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
Audited HEAD: `eb4742e8`
Decision: **BLOCK MERGE / NOT PRODUCTION CERTIFIED**

## Methodology and scope

Independent source review, multiple fault-injection reproductions in isolated temporary files on D:, and full regression suite run. No production registry was inspected or modified. No reaper, automatic prompt replay, commit, reset, main merge, or push was executed.

Source files inspected:
- `src/core/process/processRegistry.ts`
- `src/core/process/processSupervisor.ts`
- `src/core/tools/cliBridgeReconciliation.ts`
- `src/core/tools/cliBridgeDelegateJobs.ts`
- `tests/processSupervisorBatch6Remediation.test.ts`

## Confirmed findings

### P0-1 — Manual lock recovery deletes newly active replacement lock

Source: `src/core/process/processRegistry.ts:357-410`.

`recoverStaleLock(lockPath, options)` reads the old lock, checks its PID with `process.kill(pid,0)`, and then unlinks `lockPath` with no atomic identity check. A replacement lock can appear after the read.

Injected interleaving on a temporary D: registry: after the original read but before recovery verification/unlink, the lock was replaced with `{pid:process.pid, token:'ACTIVE-OWNER'}`. Result:

```json
{"swapped":true,"result":{"recovered":true},"activeReplacementStillExists":false}
```

Full command evidence: `cmd_1793238566958_jn2ub`.

Impact: false successful manual recovery and deletion of a live lock, allowing concurrent writers. Prior disabling of **automatic** stale reclaim does not fix this manual path.

### P0-2 — Owner-lock finalizer still has check-then-unlink race

Source: `src/core/process/processRegistry.ts:490-508`.

Finalizer performs `stat(lockPath)`, `readFile(lockPath)`, compares inode/token/PID, then separately calls `unlink(lockPath)`. The check and delete are not atomic. Injected replacement at the unlink boundary:

```json
{"result":"save succeeded","replacementCreated":true,"activeReplacementStillExists":false}
```

Evidence: `cmd_1793238770075_5fq4l`.

A stat/inode comparison prior to unlink is not sufficient when the pathname can change between operations. Normal-path multi-process tests do not force this interleaving. Treat registry lock exclusivity as unverified under adversarial/crash-recovery races.

### P0-3 — Restart reconciliation accepts malformed or stale checkpoints as proof for automatic retry

Source: `src/core/tools/cliBridgeReconciliation.ts:189-195,251-283`.

Current `isCheckpointValid` checks only that checkpoint is an object and `checkpoint.jobId === job.jobId`. It does not validate required schema fields, timestamp freshness, verified origin, format, or integrity before trusting `hasMutatingWrite:false` as positive evidence.

Direct function tests:
- `{jobId:'j1',hasMutatingWrite:false}` => `reconciledStatus:'interrupted', eligibleForRetry:true, requiresReview:false`.
- Checkpoint with timestamp `1` and `hasMutatingWrite:false` => same retry permission.
- Checkpoint with wrong types, e.g. `lastEvent:5`, causes `TypeError: checkpoint?.lastEvent?.startsWith is not a function`.

Evidence: `cmd_1793238629615_7iidr`.

The absence and mismatched-job checkpoint defects fixed in Batch 6 are now covered, but the advertised **validated durable proof** is not true for incomplete/malformed files. Fail closed on invalid schema or stale evidence; define trustworthy positive read-only provenance.

### P1-1 — Manual recovery can delete arbitrary JSON paths

Source: `src/core/process/processRegistry.ts:357-410`.

The public static recovery accepts any `lockPath`; it does not restrict paths to the configured registry's `.lock` file. The `operatorConfirmation` is a fixed string literal and `expectedPid` is optional. It deletes a plain unrelated JSON file containing a dead `pid`, calling the removal a successful lock recovery.

Reproduction:
```json
{"targetIsLockFile":false,"result":{"recovered":true},"unrelatedFileStillExists":false}
```

Evidence: `cmd_1793238790394_ly9fj`.

No public remote invocation was found in the searched source references. This is a dangerous internal API contract; do not overstate as a remotely exploitable issue. Bind to known registry path, require authenticated operator authorization, enforce file type/identity/ownership, and remove static shared confirmation string as an authorization mechanism.

### P1-2 — Operator capability issuance remains unrestricted at API level

Source: `src/core/process/processSupervisor.ts:147-180,436-452`.

`issueOperatorCapability()` is a public method on `ProcessSupervisor`. It mints a random privileged token and stores it in an in-memory set without verifying an operator identity or role. A caller with reference to the supervisor instance can mint its own capability.

Local in-process proof:
```json
{"noCapCount":0,"selfIssuedCapCount":1,"foreignJobVisible":"sensitive-job","operatorIdentitySupplied":false}
```

Evidence: `cmd_1793238613123_cfyvs`.

The new capability blocks forged JSON booleans and arbitrary token objects. However, possession of in-process object access is not equivalent to authenticated operator authorization. No external endpoint allowing arbitrary issuance was established. Restrict capability minting to a trusted operator-authenticated control plane with explicit authorizations, or ensure API is provably internal and non-exported to untrusted plugins.

## Passing gates and positive improvements

- **197 passed, 0 failed, 992 assertions over 17 test files** independently rerun with `bun test --timeout 30000` and isolated D: temporary directory. Test execution completed normally in 102.32 seconds. The previous 197-pass/993-assertion claim was not reused; this is a separate result.
- `bun run build` had passed in the earlier verification; recheck on audit completion.
- `git diff --check 70af5b46..HEAD`: exit 0.
- Missing checkpoint and mismatched job IDs now fail closed, existing review flags persist, Windows splash tests pass, and automatic stale-lock reclaim is disabled.
- Unit tests cover ordinary path; they do not cover the above adversarial interleavings, malformed checkpoint acceptance, or unauthenticated issuance.

## Environment and branch safety

At audit:
- `C:/Users/USER/AppData/Local/Temp`: 601G total, 589G used, ~12G free (99%).
- `D:`: 352G total, 291G used, 61G free.
- Isolated worktree branch was 2 commits behind and 6 ahead of `main`. Parallel dirty scratch files and previous audits were preserved.
- The audit's dedicated D: temporary test directory is the only eligible artifact for cleanup. Do not delete unrelated files, caches, or logs.

## Mandatory pre-merge remediation

1. P0: Design a lock protocol where **manual recovery AND ordinary release** cannot delete an active replacement lock. Avoid check-then-unlink; consider a single-owner coordinator, durable OS lock, or a no-automatic-release fail-closed design with safe replacement controls and Windows E2E tests.
2. P0: Validate the *entire* checkpoint schema, provenance, job binding, and trusted evidence of read-only behavior before retry. Malformed/stale/contradictory inputs must never yield `eligibleForRetry:true` or throw uncontrolled exceptions. Add fault-injection tests that match the exact cases above.
3. P1: Confine `recoverStaleLock` to a trusted registry path and enforce genuine operator authorization; the fixed confirmation string is not authentication.
4. P1: Restrict operator capability issuance to authenticated trusted code; verify no untrusted MCP/plugin endpoint exposes it. Document privilege-scoped threat model.
5. Run full tests, Windows power-loss/reboot, antivirus handle-contention and process-concurrency drills. No main merge or production certification until independent gates pass.

**FINAL DECISION: BLOCK MERGE.**
