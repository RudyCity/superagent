# SuperAgent Runtime Supervisor Batch 4: Independent Pre-Merge Remediation & Verification Report

Date: 2026-10-28
Branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
Target: Independent remediation of blocking findings from Batch 2–3 Pre-Merge Audit (`docs/audits/2026-10-28-superagent-runtime-supervisor-batch2-3-premerge-independent-audit.md`)
Scope: Isolated worktree (`superagent-runtime-supervisor-m2-20261028`); no changes to `main` branch or parallel job trees.

---

## 1. Executive Summary

This report documents the independent remediation and verification of all confirmed blockers (P0-1, P0-2, P0-3) and high-priority audit items (P1-1, P1-2, P1-3, P1-4, P2-1, P2-2) identified in the Batch 2–3 Pre-Merge Deep Audit.

Every finding was reproduced with deterministic test assertions before applying surgical source fixes. All test suites pass with **100% success rate (146 tests passed, 0 failed, 723 assertions across 14 test files)**, clean TypeScript compilation (`bun run build` exit code 0), and clean git diff checks (`git diff --check` exit code 0).

---

## 2. Remediation Matrix & Source Fix Details

### P0-1: Runtime Startup Reconciliation Wiring
- **Finding**: `reconcileOnStartup()` existed in `ProcessSupervisor` but was never triggered during normal application boot. Only on-demand diagnostics (`/status processes`) executed it.
- **Source Fix**:
  - In `src/core/process/processSupervisor.ts`: Implemented `bootstrapProcessSupervisorOnStartup(options)`. It executes once per process lifetime (guarded by `hasBootstrapped` flag) after registry initialization, performs read-only reconciliation scoped to the startup workspace (`process.cwd()`), caches the startup report for non-blocking inspection via `getStartupReconciliationReport()`, and captures warnings without throwing or crashing boot.
  - In `src/cliMain.tsx`: Wired `await bootstrapProcessSupervisorOnStartup({ workspaceRoot: process.cwd() })` inside `runCli()` immediately after initializing storage and config directories.
  - In `src/server.ts`: Wired `await bootstrapProcessSupervisorOnStartup({ workspaceRoot: process.cwd() })` inside `runServer()` for daemon/server mode.
- **Verification**: `tests/processSupervisorBatch4Remediation.test.ts` (test: *"wires bootstrap reconciliation to startup and caches report without manual /status call"*) proves that booting the CLI runtime populates cached reconciliation diagnostics without calling `/status`.

---

### P0-2 & P1-4: Workspace-Scoped Privacy & Ownerless Record Isolation
- **Finding**: In `processReconciliation.ts`, workspace filtering only skipped records when *both* `callerWorkspaceRoot` and `record.ownership.workspaceRoot` were defined and mismatched. Records without `workspaceRoot` (ownerless or legacy) bypassed the filter and leaked into tenant-scoped scans, review counts, and diagnostics reports.
- **Source Fix**:
  - In `src/core/process/processReconciliation.ts`: Hardened the filter loop to enforce strict equality:
    ```typescript
    if (callerWs && recordWs !== callerWs) {
      continue;
    }
    ```
    Records missing `ownership.workspaceRoot` are now strictly omitted from scoped counts, classification entries, owner probes, and checkpoint file reads.
  - In `src/core/process/processSupervisor.ts` (`getProcessDiagnostics`):
    - When `filter.filterByWorkspaceRoot` is specified, strictly requires `record.ownership?.workspaceRoot === targetWs` (rejects missing workspace).
    - When `filter.callerWorkspaceRoot` is provided, masks ownerless records (`isForeign = Boolean(callerWs && recordWs !== callerWs)`).
    - Computes `totalTracked` based on the scoped matching count rather than leaking the global un-redacted total.
- **Verification**: `tests/processSupervisorBatch4Remediation.test.ts` reproduces the exact audit leak (`private_job_123` with no workspace appearing under `D:/unrelated-workspace`), and asserts it is completely excluded from scoped entries (`scopedResult.totalRecords === 0`, `scopedResult.review === 0`).

---

### P0-3: Multi-Process Registry Durability & Lost-Update Prevention
- **Finding**: `ProcessRegistry` was an in-memory singleton per process with instance-local `saveQueue`. When multiple CLI, MCP, or Core processes loaded and saved to the same `processes.json` file, the second process's full-map overwrite erased records registered by the first process. On Windows, `fs.unlink(storagePath)` preceded `rename`, creating an unlink gap.
- **Source Fix**:
  - In `src/core/process/processRegistry.ts`:
    1. **Exclusive Cross-Process File Lock**: Implemented `withRegistryLock<T>` using an atomic `.lock` file created via `fsp.open(lockPath, 'wx')`. Supports retry loops (50ms interval, 5000ms timeout) and detects stale locks by checking lockfile age and verifying owner PID liveness via `process.kill(pid, 0)` (`ESRCH` means owner process is dead).
    2. **Compare-and-Swap (CAS) Disk Merge Inside Lock**: Inside the critical lock section, `save()` re-reads the latest persisted records from disk and merges them with memory records by `recordId`.
    3. **Monotonic Terminal State Merge**: Terminal records (`exited`, `failed`, `terminated`) take precedence over active states (`registered`, `running`) so a lagging process cannot resurrect a dead process.
    4. **Fail-Closed on Corrupt Disk**: If the on-disk file was modified by an external tool into unparseable JSON, `save()` aborts immediately and throws rather than blindly clobbering disk data.
    5. **Windows-Safe Atomic Replacement**: Generates temporary file `processes.json.<pid>.<ts>.tmp`, writes fully, and uses atomic `fsp.rename()`. If Windows throws `EPERM` or `EEXIST`, it retries up to 5 times with exponential backoff before fallback.
- **Verification**:
  - `tests/processSupervisorBatch4Remediation.test.ts` reproduces two independent `ProcessRegistry` instances loading the same empty file and saving `owner_A` and `owner_B` respectively; reloaded disk contains **both** records (length 2).
  - Multi-process concurrency test spawns **2 separate OS child processes** concurrently writing 12 records each (24 records total); disk re-read confirms all 24 records survived with zero lost updates.
  - Fail-closed corrupt test verifies `save()` refuses to overwrite corrupt disk files.

---

### P1-1: Authoritative Terminal Job Verification Outcome
- **Finding**: In `processReconciliation.ts`, any job record with `hasMutatingWrite: true` was flagged as `unknown_outcome_review_required` regardless of whether the job had completed successfully with authoritative verification receipts (`verificationState: 'verified'`, `lastEvent: 'verified_succeeded'`, `exitCode: 0`).
- **Source Fix**:
  - In `src/core/process/processReconciliation.ts`: Added authoritative verification check:
    ```typescript
    const isCleanTerminal = record.state === 'exited' && record.exitCode === 0;
    const isAuthoritativelyVerified =
      isCleanTerminal &&
      (checkpoint.verificationState === 'verified' ||
        checkpoint.verificationState === 'artifacts_verified' ||
        checkpoint.lastEvent === 'verified_succeeded');
    ```
    Jobs matching these criteria are classified as `reconciledStatus: 'succeeded'` and `requiresReview: false`, eliminating false positive operator alerts.
  - Interrupted mutating jobs (e.g. `verificationState: 'verifying'`, unverified termination, or non-zero exit) remain strictly classified as `unknown_outcome_review_required`.
- **Verification**: Verified in `tests/processSupervisorBatch4Remediation.test.ts`. Verified jobs return `reconciledStatus: 'succeeded'`, `requiresReview: false`. Interrupted jobs return `unknown_outcome_review_required`.

---

### P1-2: Global-System vs Workspace Ownership Contract
- **Finding**: Background services and tunnels registered processes without `ownership.workspaceRoot`, causing them to disappear from workspace diagnostics. However, fabricating `process.cwd()` as tenant ownership would violate isolation.
- **Source Fix**:
  - Extended `ProcessRecordOwnership` and `RegisterProcessOptions` in `src/core/process/processRegistry.ts` with `systemScope?: 'global' | 'workspace'`.
  - Added `systemScope: "global"` to all shared system-level service registrations:
    - `src/core/runtime/museWatchdogSupervisor.ts` (Muse watchdog)
    - `src/core/runtime/mcpOwnerLifecycle.ts` (MCP owner sandbox)
    - `src/core/runtime/coreSupervisor.ts` (Core supervisor)
    - `src/core/senopatiLifecycle.ts` (Senopati classifier service)
    - `src/core/mcp/openaiTunnelClient.ts` (OpenAI tunnel)
    - `src/core/remoteAgent/cloudflareTunnel.ts` (Cloudflare tunnel)
  - Global services are strictly omitted from tenant-scoped workspace scans and visible only to authorized unscoped operator diagnostics.
- **Verification**: `tests/processSupervisorBatch4Remediation.test.ts` asserts that `systemScope: 'global'` processes are omitted from tenant scans and visible in global unscoped queries.

---

### P1-3: Monotonic Terminal Lifecycle Protection
- **Finding**: Asynchronous spawn observations (`recordProcessSpawn`) unconditionally overwrote `state: 'running'` even if the process had already exited and been recorded as `exited`/`failed`/`terminated`.
- **Source Fix**:
  - In `src/core/process/processSupervisor.ts` (`recordProcessSpawn`): If an existing record is already in a terminal state (`exited`, `failed`, `terminated`), `recordProcessSpawn` preserves the terminal state and refuses to reset `state: 'running'`.
  - In `src/core/process/processRegistry.ts` (`updateRecord`): Validates state transition patches; attempts to patch a terminal record back to `running` or `registered` are rejected.
  - In `src/core/process/processRegistry.ts` (`recordHeartbeat`): Heartbeats on terminal records are silently ignored.
- **Verification**: Tested in `tests/processSupervisorBatch4Remediation.test.ts`: `recordProcessExit` followed by late `recordProcessSpawn` preserves `state: 'exited'`.

---

### P2-1 & P2-2: Pure Read-Only Default & Checkpoint Path Containment
- **Finding**:
  - P2-1: `processReconciliation.ts` accepted `persistInterruptedMutations: true`. Pure read-only reconciliation should be the enforced default.
  - P2-2: `cliBridgeReconciliation.ts` resolved checkpoint paths without validating canonical job IDs against directory traversal characters.
- **Source Fix**:
  - In `src/core/tools/cliBridgeReconciliation.ts`:
    - Added `CANONICAL_JOB_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/`.
    - Added `isValidJobId(jobId)` validator.
    - Added `resolveSecureCheckpointPath(checkpointRoot, jobId)` which rejects invalid IDs and verifies that the resolved path is strictly contained within `path.resolve(checkpointRoot)`.
    - `readJobCheckpoint` fails closed and returns `null` for invalid or traversing job IDs.
    - `writeJobCheckpoint` throws an error if an invalid or traversing job ID is provided.
  - In `src/core/process/processReconciliation.ts`: Default for `persistInterruptedMutations` is explicitly `false`.
- **Verification**: Tested in `tests/processSupervisorBatch4Remediation.test.ts`: path traversals (`../../malicious_job`, special chars, null bytes) are rejected and return `null` without throwing on read.

---

## 3. Test Verification Suite Results

### A. New Batch 4 Test Suite (`tests/processSupervisorBatch4Remediation.test.ts`)
```
bun test v1.4.2
tests\processSupervisorBatch4Remediation.test.ts:
  P0-1: Runtime Startup Reconciliation Bootstrap
    (pass) wires bootstrap reconciliation to startup and caches report without manual /status call [46.03ms]
  P0-2: Workspace Scoped Privacy & Ownerless Record Isolation
    (pass) reproduces and eliminates audit P0-2 leak: ownerless records are omitted from scoped scans [1.75ms]
    (pass) P1-4: hardens getProcessDiagnostics against ownerless record leaks [671.23ms]
  P0-3: Multi-Process Registry Durability & Lost-Update Prevention
    (pass) reproduces and eliminates audit P0-3: concurrent instances A and B never lose records [29.70ms]
    (pass) runs 2 separate OS child processes saving concurrently with zero lost updates [340.00ms]
    (pass) preserves terminal state monotonically during multi-process CAS merge [30.58ms]
    (pass) fails closed on corrupt registry encountered during lock re-read without overwriting [10.54ms]
  P1-1: Authoritative Terminal Job Verification
    (pass) classifies terminal verified mutating job as succeeded, NOT unknown_outcome_review_required [1.06ms]
    (pass) classifies interrupted verifier job as unknown_outcome_review_required [0.81ms]
  P1-2: Explicit Global-System Service Ownership
    (pass) models global system services with systemScope: 'global' and excludes from tenant scans [21.41ms]
  P1-3: Monotonic Terminal Lifecycle Protection
    (pass) prevents late recordProcessSpawn from resurrecting an exited process back to running [54.95ms]
    (pass) registry.updateRecord rejects patch state regression from terminal to running [0.85ms]
  P2-2: Checkpoint Canonical ID Validation & Path Containment
    (pass) validates canonical job IDs and rejects path traversals [0.78ms]
    (pass) writeJobCheckpoint rejects path traversal job IDs [1.56ms]
    (pass) readJobCheckpoint returns null for invalid job IDs without throwing [0.81ms]

15 pass, 0 fail, 76 expect() calls [1.24s]
```

### B. Core 9 Targeted Supervisor Test Suites
Command:
```powershell
bun test tests/processRegistryLegacySafety.test.ts tests/processOrphanScanner.test.ts tests/processStatusCommands.test.ts tests/processRegistry.test.ts tests/processSpawnPolicy.test.ts tests/windowsSubprocessSplashRegression.test.ts tests/cliBridgeTool.test.ts tests/processStartupReconciliation.test.ts tests/processSubprocessCoverageM1.test.ts
```
Results:
- `tests\cliBridgeTool.test.ts`: 40 passed
- `tests\processOrphanScanner.test.ts`: 15 passed
- `tests\processRegistry.test.ts`: 18 passed
- `tests\processRegistryLegacySafety.test.ts`: 14 passed
- `tests\processSpawnPolicy.test.ts`: 5 passed
- `tests\processStartupReconciliation.test.ts`: 13 passed
- `tests\processStatusCommands.test.ts`: 4 passed
- `tests\processSubprocessCoverageM1.test.ts`: 4 passed
- `tests\windowsSubprocessSplashRegression.test.ts`: 8 passed
- **Total: 121 pass, 0 fail, 560 expect() calls [25.18s]**

### C. Additional Related Suites
Command:
```powershell
bun test tests/coreSupervisor.test.ts tests/coreSupervisorCheckpoint.test.ts tests/cliBridgeWorktreeIsolation.test.ts tests/dynamicHookDiscoveryRefresh.test.ts
```
Results:
- `tests\cliBridgeWorktreeIsolation.test.ts`: 3 passed
- `tests\coreSupervisor.test.ts`: 2 passed
- `tests\coreSupervisorCheckpoint.test.ts`: 4 passed
- `tests\dynamicHookDiscoveryRefresh.test.ts`: 1 passed
- **Total: 10 pass, 0 fail, 87 expect() calls [24.95s]**

### D. Build & Static Analysis Verification
- `bun run build`: Exit Code **0** (`tsc` compiled successfully, MCP schemas synchronized)
- `git diff --check`: Exit Code **0** (no conflict markers, trailing whitespace, or formatting defects)
- Zero leaked subprocesses confirmed.

---

## 4. Safety Invariants Preserved

1. **Zero Automatic Reaper / Zero Destructive Actions**: The runtime supervisor remains strictly report-only and observational. Zero `process.kill()` calls against unknown, foreign, or historical processes.
2. **Zero Historical Process Adoption**: Historical processes from prior runtime generations are classified as `historical` and never adopted or modified.
3. **Zero Prompt Replay / Mutation Auto-Retry**: Ambiguous or interrupted mutating jobs are flagged as `unknown_outcome_review_required` and never automatically retried.
4. **Preserved Windows GUI Isolation**: All spawn paths continue to enforce `windowsHide: true`, preventing console window popup flicker.
5. **Redaction & Tenant Boundary**: Secrets, auth tokens, command lines, and foreign workspace paths remain strictly redacted; missing workspace records are never leaked to tenant queries.

---

## 5. Certification Status & Scope Boundary

- **Pre-Merge Remediation Status**: **PASSED ALL UNIT, INTEGRATION, AND MULTI-PROCESS GATES**.
- **Certification Boundary**: In accordance with Release Gates R0–R7, full production certification requires live Windows host restart and crash soak tests under active daemon/T-Line operation with operator sign-off. Within isolated worktree and local testing boundaries, all software defects reported in Batch 2–3 audit have been resolved and deterministically verified.
