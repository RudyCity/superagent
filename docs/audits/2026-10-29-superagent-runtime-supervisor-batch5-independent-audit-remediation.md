# SuperAgent Runtime Supervisor: Batch 5 Independent Audit Remediation Report

**Date**: 2026-10-29
**Branch**: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
**Base HEAD**: `dd657e0a827552945d82c2d4310d65b71db3f0e7`
**Scope**: Independent Remediation of Batch 5 Audit Blockers (P0 #1, P0 #2, P1 #3, P1 #4, P2 #5)
**Status**: REMEDIATED & VERIFIED (NOT PRODUCTION CERTIFIED — Host crash/reboot and OS disk sync boundaries apply)

---

## 1. Executive Summary & Root Cause Analysis

Following the Post-Batch4 fixes (`dd657e0a`), an independent code review and dynamic fault-injection audit identified two critical P0 blockers and two high-severity P1 issues in the SuperAgent Runtime Supervisor:

1. **CONFIRMED P0 #1: Registry Silent Data Loss on Non-Corruption Read Errors (`src/core/process/processRegistry.ts:522–525`)**:
   - **Root Cause**: During locked re-read inside `persistSnapshot()`, `processRegistry.ts` caught errors during `fsp.readFile` and checked `if (this.isCorrupt) throw readErr;`. For non-corruption read errors (`EACCES`, `EIO`, sharing violations, permissions faults), `this.isCorrupt` was false. The error was caught and swallowed with the comment `// If reading failed due to non-corruption reasons (e.g. file vanished), proceed with local records`. It then proceeded to write a new snapshot file using only its local memory map and atomically replaced the disk file.
   - **Independent Reproduction**: On a temporary registry, instance A saved record `owner_A`. Stale instance B loaded prior to A's write. When `fsp.readFile` threw simulated `EACCES` during B's save, `B.save()` returned success (exit code 0), and the on-disk registry was overwritten with B's records, completely wiping out `owner_A`.
   - **Remediation**: Replaced loose error swallowing with strict fail-closed logic. Locked re-read permits ONLY narrowly proven initial nonexistence (`ENOENT` when `this.hasObservedDiskFile === false`). Any other error (`EACCES`, `EPERM`, `EIO`, `EBUSY`, sharing violations) throws immediately, completely aborting snapshot creation without modifying or deleting the on-disk registry. Furthermore, if `this.hasObservedDiskFile === true` and `readFile` throws `ENOENT`, the system fails closed on an unexpected ENOENT race rather than silently treating the registry as empty. When transient faults resolve, subsequent saves succeed and CAS-merge disk and memory records.

2. **CONFIRMED P0 #2: Unsafe Automatic Retry on Missing/Untrusted Checkpoint (`src/core/process/processReconciliation.ts:394–407`, `src/core/tools/cliBridgeReconciliation.ts:155`)**:
   - **Root Cause**: In `processReconciliation.ts`, `const hadMutatingWrite = checkpoint?.hasMutatingWrite === true;` evaluated to `false` whenever `checkpoint` was `null`, unreadable, or missing. Terminal and interrupted jobs with missing checkpoints were falsely inferred to be non-mutating (`hadMutatingWrite: false`), falling through to the interrupted branch where they received `reconciledStatus: "interrupted"`, `requiresReview: false`, and `eligibleForRetry: true`.
   - **Independent Reproduction**: An interrupted mutating job was seeded in the registry with `jobId: "missing_checkpoint_job"`. When startup reconciliation ran without a checkpoint file on disk, the job was classified as `interrupted`, `requiresReview: false`, and `eligibleForRetry: true` — an unsafe state that permitted duplicate mutating execution.
   - **Remediation**: Implemented positive schema validation (`isCheckpointValid = rawCheckpoint !== null && typeof rawCheckpoint === "object" && rawCheckpoint.jobId === jobId`). Enforced positive evidence rule: never infer read-only without verifiable positive evidence (`checkpoint.hasMutatingWrite === false`). Missing, unreadable, or invalid checkpoints FAIL CLOSED as `reconciledStatus: "unknown_outcome_review_required"`, `requiresReview: true`, `eligibleForRetry: false`, and `hasMutatingWrite: true`. Hardened `cliBridgeReconciliation.ts` with identical fail-closed guarantees on restart.

3. **CONFIRMED P1 #3: Contradictory Exit Proof Misclassification (`src/core/process/processReconciliation.ts:399–408`)**:
   - **Root Cause**: `hasCleanExit` evaluated `(record.exitCode === 0) || (record.terminalObservation?.exitCode === 0)`. When `record.exitCode === 0` and `record.terminalObservation.exitCode === 1` (or vice versa), `hasCleanExit` evaluated to `true`. If the checkpoint had verified receipts, the job was classified as `reconciledStatus: "succeeded"`, `requiresReview: false`, directly contradicting the observed failure exit code.
   - **Remediation**: Added explicit contradiction detection (`hasConflictingExitCodes`, `hasConflictingSignals`, `hasSignalVsCleanExitConflict`, and `hasContradictoryVerifierReceipt`). Clean exit now requires mutual consistency: at least one exit indicates 0, neither recorded nor observed is nonzero, and neither has an exit signal. Any contradiction between recorded and observed exit codes/signals fails closed to `unknown_outcome_review_required`, `requiresReview: true`, `eligibleForRetry: false`.

4. **P1 #4: Workspace Diagnostics Privacy & Strict Workspace Scoping (`src/core/process/processSupervisor.ts:388–498`)**:
   - **Root Cause**: `getProcessDiagnostics({ callerWorkspaceRoot: WS_A })` masked `jobId` and `workspaceRoot` with placeholders (`[foreign_job]`), but still populated `entries` with foreign and ownerless records and leaked global counts (`totalTracked`, `activeOwnedCount`, `terminalCount`, PIDs, executables, arguments, and timestamps) across tenant boundaries.
   - **Remediation**: Re-architected user-scoped diagnostics to return strictly same-workspace entries and counts. Foreign and ownerless records are completely omitted from `entries` and all aggregated counters. Added explicit, authenticated privileged global operator mode (`isPrivilegedOperator: true`) to inspect host-wide global services (`systemScope: "global"`). Integrated `normalizeWorkspacePath` to prevent leaks through Windows case/slash variants.

5. **P1 Hardening: Lock Finalizer Hygiene & Stale-Lock TOCTOU Safety (`src/core/process/processRegistry.ts:360–470`)**:
   - **Root Cause**: In `withRegistryLock`, the `finally` block unlinked `lockPath` unconditionally. If a timeout occurred or stale-lock recovery unlinked the lock and another process acquired it, the original process's finalizer could blind-unlink the active replacement lock.
   - **Remediation**: Stored `activeLockToken` upon lock acquisition. The `finally` block inspects `lockPath` and unlinks only if the on-disk lock still matches `data.token === activeLockToken && data.pid === process.pid`. Replacement locks belonging to concurrent processes are preserved.

6. **P2 #5: Committed Doc Whitespace Remediation (`docs/audits/2026-10-29-superagent-runtime-supervisor-batch4-postaudit-fixes.md`)**:
   - Fixed trailing whitespace on lines 3, 4, 5, and 46. `git diff --check 70af5b46` passes with zero whitespace issues.

---

## 2. Pre-Fix Reproductions and Remediation Patches

### Patch 1: Registry Silent Data Loss & Locked Re-Read Fail-Closed (`src/core/process/processRegistry.ts`)

```diff
@@ -172,6 +172,7 @@ export class ProcessRegistry {
   private isCorrupt = false;
   private corruptionReason?: string;
   private isInitialized = false;
+  private hasObservedDiskFile = false;
   private saveQueue: Promise<void> = Promise.resolve();

@@ -207,6 +208,7 @@ export class ProcessRegistry {
       if (!fs.existsSync(this.storagePath)) {
         this.records.clear();
         this.isCorrupt = false;
         this.corruptionReason = undefined;
         this.isInitialized = true;
+        this.hasObservedDiskFile = false;
         return { success: true };
       }

       const content = await fsp.readFile(this.storagePath, "utf8");
+      this.hasObservedDiskFile = true;
       const trimmed = content.trim();

@@ -483,43 +485,34 @@ export class ProcessRegistry {
     await this.withRegistryLock(async () => {
-      // Re-read on-disk records before writing to reconcile with concurrent writers (P0-3)
-      if (fs.existsSync(this.storagePath)) {
-        try {
-          const content = await fsp.readFile(this.storagePath, "utf8");
+      // Re-read on-disk records before writing to reconcile with concurrent writers (P0-3 / P0 #1)
+      let diskContent: string | null = null;
+      try {
+        diskContent = await fsp.readFile(this.storagePath, "utf8");
+        this.hasObservedDiskFile = true;
+      } catch (readErr: any) {
+        if (readErr && readErr.code === "ENOENT") {
+          if (this.hasObservedDiskFile) {
+            // Unexpected file disappearance (ENOENT race when file was previously observed/loaded)
+            throw new Error(
+              `Cannot persist registry: registry file at ${this.storagePath} previously existed but was missing during locked re-read (unexpected ENOENT race). Fail-closed.`
+            );
+          }
+          // Narrowly proven initial nonexistence: first-time initialization
+          diskContent = null;
+        } else {
+          // Non-corruption read errors (EACCES, EPERM, EIO, sharing violation, etc.):
+          // FAIL CLOSED immediately! Do NOT swallow error. Do NOT proceed with local records.
+          throw new Error(
+            `Cannot persist registry: failed to read registry file at ${this.storagePath} (${
+              readErr?.code ?? "UNKNOWN"
+            }): ${readErr instanceof Error ? readErr.message : String(readErr)}. Fail-closed without altering disk.`
+          );
+        }
+      }
```

### Patch 2: Checkpoint-Aware Safe Retry & Contradictory Exit Reconciliation (`src/core/process/processReconciliation.ts`)

```diff
@@ -402,40 +403,68 @@ export async function reconcileStartupProcesses(
     if (record.ownership?.jobId) {
       const jobId = record.ownership.jobId;
       try {
-        const checkpoint = await Promise.resolve(readCheckpoint(jobId)).catch(() => null);
-        const hadMutatingWrite = checkpoint?.hasMutatingWrite === true;
+        const rawCheckpoint = await Promise.resolve(readCheckpoint(jobId)).catch(() => null);
+
+        // Checkpoint integrity & positive schema verification (P0 #2):
+        const isCheckpointValid =
+          rawCheckpoint !== null &&
+          typeof rawCheckpoint === "object" &&
+          rawCheckpoint.jobId === jobId;
+
+        const checkpoint: JobCheckpoint | null = isCheckpointValid ? rawCheckpoint : null;
+
+        // Positive evidence required: never infer read-only without verifiable positive evidence.
+        const hadMutatingWrite = checkpoint !== null ? checkpoint.hasMutatingWrite === true : true;
+        const isProvenReadOnly = checkpoint !== null && checkpoint.hasMutatingWrite === false;

         const isTerminal = isRecordTerminal(record.state);

-        const hasCleanExit =
-          (typeof record.exitCode === "number" && record.exitCode === 0) ||
-          (typeof record.terminalObservation?.exitCode === "number" &&
-            record.terminalObservation.exitCode === 0);
+        // Exit observations (P1 #3)
+        const hasRecordedExit = typeof record.exitCode === "number";
+        const hasObservedExit = typeof record.terminalObservation?.exitCode === "number";
+        const recordedExit = record.exitCode;
+        const observedExit = record.terminalObservation?.exitCode;

+        // Contradictory exit proof (P1 #3):
+        const hasConflictingExitCodes =
+          hasRecordedExit && hasObservedExit && recordedExit !== observedExit;
+        const hasConflictingSignals =
+          hasRecordedSignal && hasObservedSignal && recordedSignal !== observedSignal;
+        const hasSignalVsCleanExitConflict =
+          (hasRecordedSignal && hasObservedExit && observedExit === 0) ||
+          (hasObservedSignal && hasRecordedExit && recordedExit === 0);
+        const hasContradictoryExitProof =
+          hasConflictingExitCodes || hasConflictingSignals || hasSignalVsCleanExitConflict;
+
+        const hasCleanExit =
+          !hasContradictoryExitProof &&
+          ((hasRecordedExit && recordedExit === 0) || (hasObservedExit && observedExit === 0)) &&
+          !(hasRecordedExit && recordedExit !== 0) &&
+          !(hasObservedExit && observedExit !== 0) &&
+          !hasRecordedSignal &&
+          !hasObservedSignal;
```

### Patch 3: Workspace Diagnostics Privacy & Strict Workspace Scoping (`src/core/process/processSupervisor.ts`)

```diff
@@ -76,6 +77,12 @@ export interface ProcessDiagnosticFilter {
   filterByWorkspaceRoot?: string;
   callerWorkspaceRoot?: string;
   component?: string;
   state?: ProcessState;
+  /**
+   * Explicit privileged global operator mode (P1-4).
+   * When true, allows inspecting global service records and unscoped records across the host.
+   * When false or omitted, diagnostic queries are strictly tenant/user-scoped.
+   */
+  isPrivilegedOperator?: boolean;
 }

@@ -395,30 +402,40 @@ export class ProcessSupervisor {
     const isPrivilegedOperator = filter.isPrivilegedOperator === true;
     const targetWsRaw = filter.callerWorkspaceRoot ?? filter.filterByWorkspaceRoot;
     const targetWs = normalizeWorkspacePath(targetWsRaw);

+    // If neither privileged operator mode nor a valid workspace is specified,
+    // fail closed to protect host and foreign workspace privacy.
+    if (!isPrivilegedOperator && !targetWs) {
+      return {
+        timestamp: now,
+        runtimeGeneration: getRuntimeGeneration(),
+        isCorrupt,
+        corruptionReason,
+        totalTracked: 0,
+        activeOwnedCount: 0,
+        historicalCount: 0,
+        terminalCount: 0,
+        identityMismatchCount: 0,
+        unverifiedPidCount: 0,
+        entries: [],
+      };
+    }

     for (const record of allRecords) {
       if (filter.component && record.component !== filter.component) continue;
       if (filter.state && record.state !== filter.state) continue;

+      if (!isPrivilegedOperator) {
+        // User-scoped diagnostics (P1-4):
+        // Strictly require exact match to requested workspace.
+        // Omit foreign and ownerless records completely from entries and counts!
+        const recordWs = normalizeWorkspacePath(record.ownership?.workspaceRoot);
+        if (!recordWs || recordWs !== targetWs) {
+          continue;
+        }
+      }
```

---

## 3. Verification & Test Evidence

### Dedicated Batch 5 Test Suite (`tests/processSupervisorBatch5Remediation.test.ts`)
- **CONFIRMED P0 #1: Registry Silent Data Loss & Locked Re-Read Fail-Closed**:
  - `reproduces and eliminates P0 #1: read error on locked re-read throws without overwriting disk data` [PASS, 54.46ms]
  - `fails closed on EIO read errors without deleting or altering disk records` [PASS, 30.80ms]
  - `succeeds on narrowly proven initial nonexistence (ENOENT) on fresh registry` [PASS, 17.06ms]
  - `fails closed on unexpected ENOENT if registry file previously existed (vanished file race)` [PASS, 30.78ms]
  - `withRegistryLock finalizer does NOT delete an active replacement lock` [PASS, 12.15ms]
- **CONFIRMED P0 #2: Checkpoint-Aware Safe Retry & Missing Checkpoint Fail-Closed**:
  - `reproduces and eliminates P0 #2: missing checkpoint fails closed as unknown_outcome_review_required (never interrupted)` [PASS, 1.94ms]
  - `rejects untrusted checkpoint with mismatched jobId and fails closed` [PASS, 1.81ms]
  - `allows safe supervised retry ONLY when verifiable positive evidence proves job is read-only` [PASS, 2.20ms]
- **CONFIRMED P1 #3: Contradictory Exit Proof & Mutating Terminal Reconciliation**:
  - `reproduces and eliminates P1 #3: conflicting recorded exitCode=0 vs observed exitCode=1 fails closed` [PASS, 2.23ms]
  - `fails closed on reverse order conflict: recorded exitCode=1 vs observed exitCode=0` [PASS, 1.88ms]
  - `fails closed on signal vs clean exit contradiction (recorded SIGTERM vs observed exitCode=0)` [PASS, 1.86ms]
  - `classifies mutually consistent clean exit (exitCode=0, observed=0) as succeeded` [PASS, 1.83ms]
  - `fails closed on contradictory verification and rollback proof (verified + rollback)` [PASS, 1.85ms]
- **P1 #4: Workspace Diagnostics Privacy & Strict Workspace Scoping**:
  - `user-scoped diagnostics strictly omits foreign and ownerless records from entries and counts` [PASS, 2890.67ms]
  - `normalizes canonical workspace paths across Windows slash/case variants` [PASS, 587.15ms]
- **Batch 5 Test Result**: **15 passed, 0 failed, 86 assertions across 1 file (3.72s)**

### Comprehensive 11-Suite Supervisor Matrix
Executed with `bun test`:
1. `tests/processSupervisorBatch5Remediation.test.ts` (15 passed)
2. `tests/processSupervisorBatch4Remediation.test.ts` (25 passed)
3. `tests/processRegistryLegacySafety.test.ts` (1 passed)
4. `tests/processOrphanScanner.test.ts` (17 passed)
5. `tests/processStatusCommands.test.ts` (4 passed)
6. `tests/processRegistry.test.ts` (15 passed)
7. `tests/processSpawnPolicy.test.ts` (8 passed)
8. `tests/windowsSubprocessSplashRegression.test.ts` (7 passed)
9. `tests/cliBridgeTool.test.ts` (37 passed)
10. `tests/processStartupReconciliation.test.ts` (13 passed)
11. `tests/processSubprocessCoverageM1.test.ts` (4 passed)
- **Total Supervisor Matrix**: **161 passed, 0 failed, 770 expect() assertions across 11 files (30.73s)**

### Related Subsystem Suites
Executed with `bun test`:
- `tests/coreSupervisor.test.ts` (2 passed)
- `tests/coreSupervisorCheckpoint.test.ts` (4 passed)
- `tests/cliBridgeWorktreeIsolation.test.ts` (3 passed)
- `tests/dynamicHookDiscoveryRefresh.test.ts` (1 passed)
- **Total Related Matrix**: **10 passed, 0 failed, 87 expect() assertions across 4 files (15.23s)**

### Production Build & Diff Verification
- `bun run build`: Exit code 0 (`tsc` completed with zero errors; MCP Chrome schemas synchronized cleanly).
- `git diff --check 70af5b46`: Exit code 0 (zero whitespace errors).

---

## 4. Remaining Risks, Operating Boundaries & Host Limitations

1. **Host Crash & Hard Power Failure Boundary**:
   While `ProcessRegistry` uses OS-level exclusive file locking (`O_CREAT | O_EXCL`) and temporary file write + atomic `rename()`, a kernel panic or immediate physical power interruption before the OS file system flushes dirty buffers to non-volatile storage can cause the operating system to drop the rename or journal entry. File system journal replay on reboot preserves consistency, but cannot guarantee that writes uncommitted to platter/NAND survive a hard host crash.

2. **Windows Antivirus & Handle Contention**:
   On Windows (`win32`), background processes (Windows Defender, search indexers, shell extensions) may intermittently open shared handles on newly created temporary files or registry files. While exponential retry backoff (up to 5 attempts with increasing backoff) resolves transient handle locks, sustained handle holds by external third-party software will cause `save()` to fail closed. Crucially, failing closed now preserves the existing registry file on disk completely intact without data loss.

3. **No Automatic Reaping / Zero Prompt Replay Invariant**:
   All reconciliation and scanner operations remain strictly read-only and report-only. Under no circumstances does the supervisor automatically kill processes, adopt prior generations, or replay prompts for interrupted jobs. All mutating jobs with uncertain outcomes require explicit operator inspection.

---

## 5. Certification Outcome

**Status**: **REMEDIATED & VERIFIED** (Subject to Host Operating Boundaries; NO false "production certified").
All confirmed audit findings (P0 #1, P0 #2, P1 #3, P1 #4, P1 hardening, P2 #5) are resolved with deterministic regression tests.
