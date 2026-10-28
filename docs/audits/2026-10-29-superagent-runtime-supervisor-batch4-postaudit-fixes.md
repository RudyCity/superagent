# SuperAgent Runtime Supervisor: Post-Batch4 Independent Audit Remediation Report

**Date**: 2026-10-29
**Branch**: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
**Base HEAD**: `70af5b461ad62de962679ed744b91c7a6e2aa61b`
**Scope**: Targeted Post-Batch4 Independent Audit Blocker Remediation

---

## 1. Executive Summary & Root Cause Analysis

Following the delivery of Batch 4 (`70af5b46`), an independent code review identified two critical blockers and one locking hygiene hazard:

1. **Destructive Windows Unlink Gap in Registry Persistence (`src/core/process/processRegistry.ts:529-535`)**:
   - **Root Cause**: When atomic rename failed after 5 retries on Windows, `persistSnapshot()` executed a fallback: `await fsp.unlink(this.storagePath)` followed by `await fsp.rename(tempFile, this.storagePath)`. If the subsequent rename failed (e.g. anti-virus scan, handle contention, power failure), the existing registry file on disk was permanently deleted. This created a destructive unlink gap, violating audit finding P0-3 and contradicting "Windows-safe atomic replacement".
   - **Remediation**: The destructive unlink fallback was completely excised. The runtime now relies exclusively on atomic rename (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`) with exponential backoff retries. If replacement cannot succeed after retries, the system fails closed: it throws a descriptive error and unlinks the temporary snapshot file, leaving the existing registry file on disk completely intact and unmutated.

2. **Uncertain Mutating Job Misclassification & Contradictory Verifier Receipts (`src/core/process/processReconciliation.ts:410-416`)**:
   - **Root Cause**:
     1. Optional chaining trap: `(record.terminalObservation?.exitCode !== null && record.terminalObservation?.exitCode !== 0)` evaluated to `true` when `terminalObservation` was `undefined` because `(undefined !== null && undefined !== 0)` is `true`. Any process without an observed terminal exit was falsely classified as having a nonzero exit.
     2. Premature failure classification: Mutating jobs with nonzero exits were marked as `isAuthoritativelyFailed` with `requiresReview: false`. A nonzero exit alone is not proof that no files were written or that side effects were rolled back; partial writes or corrupted states could have occurred before exit.
     3. Loose contradictory receipts: A loose `OR` (`checkpoint.verificationState === 'verified' || checkpoint.lastEvent === 'verified_succeeded'`) permitted contradictory checkpoints (e.g. `lastEvent === 'verified_succeeded'` while `verificationState === 'verifying'` or `'verification_failed'`) to be accepted as authoritatively verified.
   - **Remediation**:
     1. Implemented explicit number type guards (`typeof record.exitCode === 'number'` and `typeof record.terminalObservation?.exitCode === 'number'`).
     2. Enforced fail-closed mutating job outcome: Any mutating job (`hadMutatingWrite === true`) without self-consistent verified proof or verified clean rollback (`checkpoint.rollbackState === 'verified_clean'`) MUST classify as `unknown_outcome_review_required` with `requiresReview: true` and `eligibleForRetry: false`.
     3. Enforced self-consistent durable verifier evidence: Verified status requires positive verification indicators without contradictory in-progress or failure states. Non-mutating jobs fail cleanly without review.

3. **Registry Lock Safety, Orphan Lock Cleanup, and Stale Lock TOCTOU Race Prevention (`src/core/process/processRegistry.ts:353-430`)**:
   - **Root Cause**:
     1. In `withRegistryLock`: If `fsp.open(lockPath, "wx")` succeeded but `writeFile` or `sync` threw (e.g. disk quota, test failure), the acquired handle was not closed and an orphan lock file remained on disk, blocking subsequent saves until timeout.
     2. In stale-lock recovery: If a process detected a dead owner PID and decided to unlink `lockPath`, a concurrent process could acquire a replacement lock before the unlink executed. Blindly calling `fsp.unlink(lockPath)` created a TOCTOU race that deleted the active replacement lock.
   - **Remediation**:
     1. Added nested error handling in `withRegistryLock`: Any failure during `writeFile` or `sync` immediately closes the acquired handle, unlinks the newly created lock file, and rethrows.
     2. Added TOCTOU guard in stale-lock recovery: Stale metadata (`token`, `pid`, `createdAt`) is recorded during inspection, and `lockPath` is re-read immediately prior to unlink. If the token or owner changed, unlinking is skipped to protect active replacement locks.
     3. Maintained strict fail-closed posture: Malformed or unreadable locks are never unlinked blindly; only signal 0 (`process.kill(pid, 0)`) is used for non-destructive liveness probes.

---

## 2. Pre-Fix Reproductions and Remediation Patches

### Patch 1: Removal of Destructive Unlink Fallback (`src/core/process/processRegistry.ts`)

```diff
@@ -528,7 +528,11 @@ export class ProcessRegistry {
         }

-        if (!renamed && process.platform === "win32") {
-          // Fallback replacement on Windows inside exclusive lock
-          try {
-            await fsp.unlink(this.storagePath);
-          } catch {}
-          await fsp.rename(tempFile, this.storagePath);
-        }
+        if (!renamed) {
+          throw new Error(
+            `Failed to atomically replace process registry at ${this.storagePath} after retries: ${
+              lastRenameErr instanceof Error ? lastRenameErr.message : String(lastRenameErr)
+            }. Fail-closed with original registry intact.`
+          );
+        }
```

### Patch 2: Lock Write Cleanup & Stale TOCTOU Protection (`src/core/process/processRegistry.ts`)

```diff
@@ -359,6 +359,23 @@ export class ProcessRegistry {
     while (Date.now() - startTime < timeoutMs) {
+      let acquiredHandle: fsp.FileHandle | null = null;
       try {
-        lockHandle = await fsp.open(lockPath, "wx", 0o600);
-        await lockHandle.writeFile(...);
-        await lockHandle.sync();
-        break;
+        acquiredHandle = await fsp.open(lockPath, "wx", 0o600);
+        try {
+          await acquiredHandle.writeFile(
+            JSON.stringify({
+              pid: process.pid,
+              createdAt: Date.now(),
+              token: crypto.randomBytes(4).toString("hex"),
+            })
+          );
+          await acquiredHandle.sync();
+        } catch (writeErr) {
+          // If writeFile or sync fails, close FD and unlink orphan lock immediately
+          try { await acquiredHandle.close(); } catch {}
+          try { await fsp.unlink(lockPath); } catch {}
+          throw writeErr;
+        }
+        lockHandle = acquiredHandle;
+        break;
       } catch (err: any) {
...
+          if (isStale && staleToken && stalePid !== null) {
+            // TOCTOU guard: Re-read lock file immediately before unlinking
+            try {
+              const verifyRaw = await fsp.readFile(lockPath, "utf8");
+              const verifyData = JSON.parse(verifyRaw);
+              if (
+                verifyData.token === staleToken &&
+                verifyData.pid === stalePid &&
+                verifyData.createdAt === staleCreatedAt
+              ) {
+                await fsp.unlink(lockPath);
+              }
+            } catch {}
+            continue;
+          }
```

### Patch 3: Fail-Closed Process Reconciliation (`src/core/process/processReconciliation.ts`)

```diff
@@ -395,22 +395,49 @@ export async function reconcileStartupProcesses(...) {
+        const isTerminal = isRecordTerminal(record.state);
+
+        const hasCleanExit =
+          (typeof record.exitCode === "number" && record.exitCode === 0) ||
+          (typeof record.terminalObservation?.exitCode === "number" &&
+            record.terminalObservation.exitCode === 0);
+
+        const hasNonzeroExit =
+          (typeof record.exitCode === "number" && record.exitCode !== 0) ||
+          (typeof record.terminalObservation?.exitCode === "number" &&
+            record.terminalObservation.exitCode !== 0);
+
+        const verificationState = checkpoint?.verificationState;
+        const lastEvent = checkpoint?.lastEvent;
+
+        const hasVerifiedState =
+          verificationState === "verified" || verificationState === "artifacts_verified";
+        const hasVerifiedEvent = lastEvent === "verified_succeeded";
+
+        const hasFailedState =
+          verificationState === "verification_failed" || verificationState === "failed";
+        const hasFailedEvent =
+          lastEvent === "verified_failed" || lastEvent === "verification_failed";
+
+        const isVerifyingInProgress =
+          verificationState === "verifying" ||
+          (typeof lastEvent === "string" && lastEvent.startsWith("verifier_"));
+
+        // Contradictory receipts check
+        const hasContradictoryVerifierReceipt =
+          (hasVerifiedState && (hasFailedEvent || isVerifyingInProgress)) ||
+          (hasVerifiedEvent && (hasFailedState || isVerifyingInProgress));
+
+        // Durable, self-consistent verifier proof
+        const hasConsistentVerifiedProof =
+          (hasVerifiedState || hasVerifiedEvent) &&
+          !hasFailedState &&
+          !hasFailedEvent &&
+          !isVerifyingInProgress &&
+          !hasContradictoryVerifierReceipt;
+
+        const isAuthoritativelyVerified =
+          isTerminal && hasCleanExit && hasConsistentVerifiedProof;
```

---

## 3. Test Verification Suite Evidence

### A. Extended Remediation Test Suite (`tests/processSupervisorBatch4Remediation.test.ts`)
```powershell
bun test tests/processSupervisorBatch4Remediation.test.ts
```
**Outcome**:
- **25 passed**, **0 failed**, **124 assertions** (Duration: 2.06s).
- Proven: Simulated Windows `EPERM` rename failure after retries preserves original registry on disk intact and cleans up `.tmp.proc_reg.*`.
- Proven: Lock write/sync error closes acquired file handle and unlinks orphan `.lock` file.
- Proven: Stale-lock recovery re-verifies token and does NOT delete concurrent active replacement locks (TOCTOU guard).
- Proven: Missing/undefined `terminalObservation` does not falsely trigger nonzero failure classification.
- Proven: Mutating job with nonzero exit code fails closed as `unknown_outcome_review_required` with `requiresReview: true` and `eligibleForRetry: false`.
- Proven: Contradictory receipts (`lastEvent: verified_succeeded` with `verificationState: verifying` or `verification_failed`) are rejected and marked for operator review.
- Proven: Terminal clean exit (exit code 0) with consistent verifier proof is classified as `succeeded`.
- Proven: Non-mutating job failures and mutating jobs with verified clean rollback are classified as `failed` with `requiresReview: false`.

### B. Core 9 Targeted Supervisor Test Suites
```powershell
bun test tests/processRegistryLegacySafety.test.ts `
         tests/processOrphanScanner.test.ts `
         tests/processStatusCommands.test.ts `
         tests/processRegistry.test.ts `
         tests/processSpawnPolicy.test.ts `
         tests/windowsSubprocessSplashRegression.test.ts `
         tests/cliBridgeTool.test.ts `
         tests/processStartupReconciliation.test.ts `
         tests/processSubprocessCoverageM1.test.ts
```
**Outcome**:
- **121 passed**, **0 failed**, **559 assertions** (Duration: 26.04s).

### C. Additional Related Suites
```powershell
bun test tests/coreSupervisor.test.ts `
         tests/coreSupervisorCheckpoint.test.ts `
         tests/cliBridgeWorktreeIsolation.test.ts `
         tests/dynamicHookDiscoveryRefresh.test.ts
```
**Outcome**:
- **10 passed**, **0 failed**, **87 assertions** (Duration: 14.42s).

### D. Static Analysis & Build Gates
- `bun run build`: Exit Code 0 (clean TypeScript check `tsc` and MCP schema sync).
- `git diff --check`: Exit Code 0 (zero whitespace/CRLF errors, zero conflict markers).

---

## 4. Honest Remaining Risks & Operating Environment Scope

1. **Transient Windows Locking by External Agents (AV / Indexers)**:
   - While `processRegistry.save()` now retries with backoff and fails closed without unlinking the existing file, aggressive third-party processes (such as Windows Defender or search indexers) locking registry files can cause `save()` calls to reject after retry exhaustion. The system protects existing data against loss, but calling workflows should be prepared to handle transient `save()` rejections.
2. **Host-Level Hard Crash & Hardware Cutoff Evidence**:
   - The test suites comprehensively verify multi-process concurrency, atomic file swapping, simulated file errors (`EPERM`, lock write failures), and process death (`ESRCH`). However, real Windows OS kernel panic, blue screen, or host power-loss scenarios cannot be fully simulated inside a user-space test process without dedicated VM test harnesses.
   - Production certification for mission-critical deployments must be accompanied by genuine OS-level host crash/reboot soak drill evidence as mandated by project governance.
