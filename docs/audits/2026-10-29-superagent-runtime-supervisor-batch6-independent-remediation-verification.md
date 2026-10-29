# SuperAgent Runtime Supervisor — Batch 6 Independent Remediation Verification

Date: 2026-10-29
Branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
Base Commit: `1b0ff4d7`
Auditor / Implementer: Precision Software Engineer (SuperAgent Runtime Supervisor Team)
Status: **P0 / P1 DEFECTS DETERMINISTICALLY REMEDIATED & VERIFIED** (Staging-certified; final production cutover awaits physical host power-loss/AV soak per release gates R0-R7).
Scope: In-place remediation of confirmed findings from Batch 5 independent audit (`docs/audits/2026-10-29-superagent-runtime-supervisor-batch5-premerge-independent-audit.md`).

---

## 1. Executive Summary

This remediation directly eliminates the four critical security, durability, and safety vulnerabilities confirmed by the Batch 5 independent audit:
1. **P0-1 (Unsafe Restart Retry in CLI Bridge)**: Eliminated unsafe `eligibleForRetry: true` when checkpoints are absent, unreadable, invalid, or belong to another job. Enforced positive durable checkpoint verification with exact `jobId` match.
2. **P0-2 (TOCTOU Stale-Lock Race on Active Replacement)**: Eliminated the fragile check-read-then-unlink pattern in `src/core/process/processRegistry.ts`. Adopted a strict fail-closed single-writer lock architecture that completely disables unsafe automatic stale lock deletion during acquisition, binds lock release to the exact acquired file inode (`ino`), token, and PID, and introduces explicitly authorized manual safe recovery (`ProcessRegistry.recoverStaleLock`).
3. **P1-1 (Unauthenticated Privilege Switch in Diagnostics)**: Replaced untrusted public JSON boolean escalation (`isPrivilegedOperator: true`) with a non-forgeable, branded server-internal `OperatorCapability` held strictly by the authorized runtime.
4. **P1-2 (Terminal Review Flag Loss on Restart)**: Preserved `requiresReview: true` for all review-needed terminal statuses (`unknown_outcome_review_required`, `verification_failed`, `permission_blocked`) across restart and reconciliation.

---

## 2. Root Cause Analysis & Surgical Remediation

### P0-1: CLI Bridge Restart Safety & Validated Checkpoint Proof
- **Source**: `src/core/tools/cliBridgeReconciliation.ts:80-181`, `src/core/tools/cliBridgeDelegateJobs.ts:415-428`.
- **Root Cause**:
  - `reconcileJobOnRestart` evaluated `const hadMutatingWrite = !(job.hasMutatingWrite === false || (checkpoint !== null && checkpoint !== undefined && checkpoint.hasMutatingWrite === false));`.
  - When `checkpoint` was `null` or belonged to another job, an in-memory `job.hasMutatingWrite === false` was blindly trusted, classifying dead-child jobs as `interrupted` with `eligibleForRetry: true` and `requiresReview: false`.
  - In `cliBridgeDelegateJobs.ts`, startup reconciliation skipped uncompleted active jobs when `cp` was null.
- **Surgical Fix**:
  - Required positive evidence: a durable, non-null, valid checkpoint whose `jobId` strictly matches `job.jobId` (`checkpoint.jobId === job.jobId`).
  - Missing, unreadable, invalid, or mismatched checkpoints FAIL CLOSED to `reconciledStatus: "unknown_outcome_review_required"` with `requiresReview: true` and `eligibleForRetry: false`.
  - Added detection of contradictory verifier receipts (e.g. `verified` paired with failure or in-progress) and exit signals.
  - Granted `eligibleForRetry: true` (`reconciledStatus: "interrupted"`, `requiresReview: false`) ONLY when a valid matching checkpoint affirmatively proves `hasMutatingWrite === false` and `job.hasMutatingWrite !== true`.
  - Reconciled all uncompleted active jobs on startup in `cliBridgeDelegateJobs.ts` regardless of checkpoint presence.

### P0-2: Safe Single-Writer Registry Lock Architecture & TOCTOU Elimination
- **Source**: `src/core/process/processRegistry.ts:356-485`.
- **Root Cause**:
  - Stale-lock recovery inspected the lock file content and then issued a separate `fsp.unlink(lockPath)` syscall. Injected interleaving proved that an active replacement lock placed by another concurrent process between verification and unlink would be deleted (`deletedActive: true`), defeating the exclusive writer guarantee.
  - The finalizer also relied on a separate check-read-then-unlink syscall sequence.
- **Surgical Fix**:
  - **Disabled Automatic Stale Lock Reclamation**: When `fsp.open(lockPath, "wx")` encounters `EEXIST`, `withRegistryLock` NEVER unlinks or inspects another process's lock. It waits with randomized backoff until the lock holder finishes and releases the lock. If `timeoutMs` expires, it fails closed with a descriptive error.
  - **Inode-Bound Own Lock Release**: At acquisition time, the process records the open handle's filesystem inode (`myIno = (await acquiredHandle.stat()).ino`), `activeLockToken`, and `pid`. In the `finally` block, it verifies that the file at `lockPath` matches `myIno`, `activeLockToken`, and `process.pid` before unlinking. If the file was replaced, unlinked, or swapped, the finalizer skips unlinking, preserving the replacement lock.
  - **Explicitly Authorized Safe Manual Recovery**: Implemented `ProcessRegistry.recoverStaleLock(lockPath, options)` requiring `operatorConfirmation: "CONFIRM_MANUAL_STALE_LOCK_REMOVAL"`. It tests the recorded PID with non-destructive `process.kill(pid, 0)`: if the owner process is still alive, recovery is strictly refused (fails closed); if confirmed dead (`ESRCH`), the orphaned lock is safely unlinked.

### P1-1: Non-Forgeable Server-Internal Capability & Operator Authorization Boundary
- **Source**: `src/core/process/processSupervisor.ts:75-95, 145-180, 420-455`.
- **Root Cause**:
  - `getProcessDiagnostics` evaluated `filter.isPrivilegedOperator === true`. Any caller supplying this boolean in JSON gained unauthenticated host-wide diagnostic inspection, disclosing foreign jobs and global services.
- **Surgical Fix**:
  - Defined branded, non-forgeable `OperatorCapability`:
    ```ts
    const OPERATOR_CAPABILITY_BRAND = Symbol("OPERATOR_CAPABILITY_BRAND");
    export interface OperatorCapability {
      readonly [OPERATOR_CAPABILITY_BRAND]: true;
      readonly capabilityId: string;
    }
    ```
  - Added runtime-generated in-memory capability tracking on `ProcessSupervisor` via `issueOperatorCapability()` and `verifyOperatorCapability()`.
  - In `getProcessDiagnostics`: verified `filter.operatorCapability`. Untrusted caller boolean `isPrivilegedOperator: true` is strictly ignored / rejected.
  - Without verified `OperatorCapability`, queries are strictly tenant-scoped to caller workspace, completely omitting foreign records and ownerless records from entries and counts.

### P1-2: Terminal Review Flag Retention
- **Source**: `src/core/tools/cliBridgeReconciliation.ts:90-130`.
- **Root Cause**:
  - `reconcileJobOnRestart` previously included `unknown_outcome_review_required` and `verification_failed` in `terminalStatuses` and returned `requiresReview: false`.
- **Surgical Fix**:
  - Added explicit terminal checks preserving `requiresReview: true` for `unknown_outcome_review_required`, `verification_failed`, and `permission_blocked`.
  - Safe terminal statuses (`succeeded`, `failed`, `cancelled`, `timed_out`, `interrupted`) return `requiresReview: false`.

---

## 3. Operator Runbook: Stale Lock Diagnosis & Safe Recovery

When a writer process crashes catastrophically (e.g. host power loss or unhandled kill), the `.lock` file remains on disk. Normal acquisition fails closed after timeout:
`Timed out waiting for process registry lock: <path>.lock. Automatic stale-lock reclamation is disabled to prevent TOCTOU lock races.`

### Operator Recovery Procedure:
1. **Inspect Lock State**:
   Read `<registryPath>.lock` JSON content to identify the recorded `pid`, `createdAt`, and `token`.
2. **Verify Process Liveness**:
   Confirm whether the recorded PID is dead using OS tools (`Get-Process -Id <pid>` or `tasklist /fi "PID eq <pid>"`).
   Do NOT delete the lock if the process is active or unresponsive (investigate thread hangs first).
3. **Execute Safe Recovery**:
   Invoke `ProcessRegistry.recoverStaleLock(lockPath, { operatorConfirmation: "CONFIRM_MANUAL_STALE_LOCK_REMOVAL", expectedPid: <pid> })`.
   - If the recorded PID is still alive, `recoverStaleLock` automatically fails closed and refuses removal.
   - If the PID is dead, the orphaned lock is safely unlinked, permitting immediate resumption.

---

## 4. Comprehensive Test Verification Evidence

All tests executed via `bun test` in Windows PowerShell on branch `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`:

### Gate A: Dedicated Batch 6 Remediation Suite (`tests/processSupervisorBatch6Remediation.test.ts`)
```powershell
bun test tests/processSupervisorBatch6Remediation.test.ts
```
**Outcome**: **16 passed, 0 failed, 85 expect() assertions (3.30s)**
- P0-1: Missing checkpoint fails closed to `unknown_outcome_review_required` even with `hasMutatingWrite: false` (PASS).
- P0-1: Checkpoint with mismatched `jobId` fails closed (PASS).
- P1-2: Terminal `unknown_outcome_review_required` preserves `requiresReview: true` (PASS).
- P1-2: Terminal `verification_failed` and `permission_blocked` preserve `requiresReview: true` (PASS).
- P0-1: Safe terminal statuses preserve `requiresReview: false` (PASS).
- P0-1: Valid matching checkpoint with `hasMutatingWrite: false` grants `eligibleForRetry: true` (PASS).
- P0-1: Contradictory checkpoint receipts fail closed (PASS).
- P0-1: Mutating interrupted jobs block retry and require review (PASS).
- P0-2: Automatic stale lock reclamation disabled; active replacement lock preserved (PASS).
- P0-2: Release of OWN lock verifies inode/token; replaced lock is not deleted (PASS).
- P0-2: `recoverStaleLock` enforces confirmation token, rejects live owners, removes dead owner lock (PASS).
- P0-2: Crash simulation: unrecovered lock fails closed, manual recovery restores acquisition (PASS).
- P0-2: Concurrent saves serialize with zero data loss (PASS).
- P1-1: Caller-supplied boolean `isPrivilegedOperator: true` fails to escalate; 0 records leaked (PASS).
- P1-1: Unauthenticated unscoped query returns 0 records (PASS).
- P1-1: Genuine `OperatorCapability` grants host-wide diagnostics while forged objects are rejected (PASS).

### Gate B: Comprehensive 12-Suite Process Supervisor Matrix
```powershell
bun test --timeout 30000 tests/processSupervisorBatch6Remediation.test.ts `
                         tests/processSupervisorBatch5Remediation.test.ts `
                         tests/processSupervisorBatch4Remediation.test.ts `
                         tests/processRegistryLegacySafety.test.ts `
                         tests/processOrphanScanner.test.ts `
                         tests/processStatusCommands.test.ts `
                         tests/processRegistry.test.ts `
                         tests/processSpawnPolicy.test.ts `
                         tests/windowsSubprocessSplashRegression.test.ts `
                         tests/cliBridgeTool.test.ts `
                         tests/processStartupReconciliation.test.ts `
                         tests/processSubprocessCoverageM1.test.ts
```
**Outcome**: **177 passed, 0 failed, 857 expect() assertions across 12 files (45.32s)**

### Gate B (cont.): Related Subsystem & Reconciliation Suites
```powershell
bun test --timeout 30000 tests/coreSupervisor.test.ts `
                         tests/coreSupervisorCheckpoint.test.ts `
                         tests/cliBridgeWorktreeIsolation.test.ts `
                         tests/dynamicHookDiscoveryRefresh.test.ts `
                         tests/cliBridgeReconciliation.test.ts
```
**Outcome**: **20 passed, 0 failed, 136 expect() assertions across 5 files (22.5s)**

### Total Process & Supervisor Verification
**197 passed, 0 failed, 993 expect() assertions across 17 test files**.

### Gate C: Static Analysis, Build & Subprocess Hygiene
- `bun run build`: Exit Code 0 (clean TypeScript build, 0 errors, MCP Chrome schemas synced).
- `git diff --check 70af5b46..HEAD`: Exit Code 0 (clean, 0 whitespace errors, 0 conflict markers).
- Windows console splash elimination: 7/7 passed headlessly with `windowsHide: true`.
- Zero leaked subprocesses across all soak and execution tests.

---

## 5. Remaining Risks & Gate Certification

- **Live Host Power-Loss / AV Soak**: In-memory and deterministic filesystem simulations prove that the lock race, checkpoint bypass, and privilege escalation are completely eliminated in code. As mandated by the repository deployment policy, final production cutover remains subject to physical Windows host power-loss/restart soak and anti-virus file-contention soak before R0-R7 gates are marked fully closed.
- **Staging Certification**: Staging and pre-merge verification criteria are fully satisfied. Code is strictly fail-closed, self-consistent, and verified against all independent audit findings.
