# SuperAgent Runtime Supervisor Batch 2–3: Independent Pre-Merge Deep Audit

Date: 2026-10-28
Result: **NOT READY TO MERGE / NOT PRODUCTION CERTIFIED**
Scope: committed `66550f6b` and `23bfa091` on `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`, compared with `main` at `6923ea85`. Independent, no changes to source implementation or main. AGY completion was artifact-verified, but certification here is based on independent inspection and tests.

## Verification performed
- Reviewed ProcessRegistry, ProcessSupervisor, ProcessOrphanScanner, ProcessReconciliation, process command status, owner job checkpoints, new subprocess registration in Muse watchdog, Core Supervisor, MCP sandbox owner, Senopati launcher, dynamic hooks and Git worktree management, plus relevant tests.
- Previous independent execution of **9 targeted suites: 121 pass, 0 fail, 560 assertions**; `bun run build` PASS and `git diff HEAD^ HEAD --check` PASS.
- Additional independent related suites: `bun test tests/coreSupervisor.test.ts tests/coreSupervisorCheckpoint.test.ts tests/cliBridgeWorktreeIsolation.test.ts tests/dynamicHookDiscoveryRefresh.test.ts` produced **10 pass, 0 fail, 87 assertions**. This is not a full-repository E2E or live Windows crash/restart certification.
- Current git graph is one main-only commit and two supervisor-only commits since `fcd8a358`; `git merge-tree $(git merge-base main HEAD) main HEAD` displayed no textual conflict markers. This is **not** permission to merge: main has **75 dirty entries** and uncommitted edits to `src/core/tools/cliBridgeSession.ts`, which overlaps Batch 2.
- Confirmed automatic termination/reaping is not implemented; all findings are report-only. No main, push, merge, reset, or restore operations executed.

## Blocking findings

### P0-1 — M3 startup reconciliation is not connected to actual boot

**Code:** `src/core/process/processSupervisor.ts:140-158` implements an explicit `reconcileOnStartup()` but `initialize()` merely loads the registry. Repository search of `src` finds no runtime call to `reconcileOnStartup()`; `reconcileStartupProcesses()` is called from `src/core/commands/processStatusViews.ts:22-26` on demand. Unit test `tests/processStartupReconciliation.test.ts:319-332` manually invokes the method rather than testing CLI bootstrap.

**Impact:** The Batch 3 promise of automatic startup reconciliation is not exercised at startup; a crash/restart without invoking the diagnostics does not produce the new process reconciliation findings. The CLI Bridge has separate job reconciliation in `cliBridgeDelegateJobs.ts`, but this does not wire up M3 process-level startup reconciliation.

**Required fix:** Wire an exactly-once, fail-closed, non-destructive startup reconcile trigger in the owning runtime boot path after registry initialization, with captured warnings and explicit workspace scope. Add an executable boot-path integration test proving a persisted interrupted job is observed after restart without a manual `/status` call.

### P0-2 — Workspace-scoped M3 leaks ownerless records, job identifiers and review counts

**Code:** `src/core/process/processReconciliation.ts:221-229` only skips a record if BOTH caller workspace and record workspace are populated and differ. Missing `record.ownership.workspaceRoot` passes the requested scope. `src/core/process/processReconciliation.ts:438-458` then includes the record ID, PID, job ID and job assessment. `src/core/commands/processStatusViews.ts:39-46` incorporates the resulting review counts into scoped status/doctor output. The older M2 scanner correctly uses exact workspace equality in `src/core/process/processOrphanScanner.ts:114`.

**Independent live repro:** Create a registry record with `ownership: {jobId:'private_job_123'}`, no workspaceRoot, process `exited`; request `callerWorkspaceRoot:'D:/unrelated-workspace'`. Result:
`{"totalRecords":1,"review":1,"entries":[{"recordId":"audit_finished_foreign","jobId":"private_job_123","classification":"terminal","review":"unknown_outcome_review_required"}]}`
This used a memory-only ProcessRegistry with injected checkpoint reader; no production files were changed.

**Required fix:** For workspace-specific requests, include only `record.ownership?.workspaceRoot === callerWorkspaceRoot`; unknown workspace must be excluded from tenant-scoped counts, entries, owner probes, and checkpoint reads. Expose unscoped/global inspection only through a separately authorized operator path. Add ownerless/legacy privacy regression tests for both API and slash commands.

### P0-3 — Shared persisted process registry loses records with multiple writers

**Code:** `src/core/process/processRegistry.ts:144-146, 167-179, 278-331` uses one global registry file, snapshots an instance-local Map, and serializes saves only within that single instance's `saveQueue`. There is no cross-process transaction or lock. On Windows rename fallback, `unlink(storagePath)` precedes rename, leaving a replacement gap.

**Independent live repro:** Two ProcessRegistry instances load the same previously missing temporary file; A registers `owner_A` and saves; B registers `owner_B` based on its prior snapshot and saves. Reload result: `{"savedFirst":"owner_A","savedSecond":"owner_B","survivingIds":["owner_B"]}`. Temporary test directory was deleted afterward.

**Impact:** Multiple SuperAgent CLI/MCP/Core runtimes can lose ownership evidence across process boundaries. This breaks the durability premise for trustworthy orphan/restart classification. No destructive action is currently authorized, which limits immediate risk.

**Required fix:** Choose a single-writer supervisor/IPC model, or implement cross-process locking/CAS with merge-by-record-ID and explicit corruption handling. Do not infer ownership from lost records. Add two-process concurrent writer and kill-during-persist tests, especially Windows replacement-failure fault injection.

## Additional required remediation

### P1-1 — False `unknown_outcome_review_required` for completed jobs

**Code:** `src/core/process/processReconciliation.ts:386-430` flags any record whose classification is not `currently_owned_live` if a checkpoint has `hasMutatingWrite === true` or `verificationState === 'verifying'`, without first evaluating a verified terminal job outcome. A completed `exited`, `exitCode=0`, `verificationState='verified'`, `lastEvent='verified_succeeded'` record with `hasMutatingWrite=true` was reported as `unknown_outcome_review_required` in the P0-2 live reproduction. This risks incorrect operator-review alerts even if work completed successfully.

**Required fix:** Correlate authoritative terminal job receipts and verification state before declaring outcome unknown. Exit code alone is not proof of successful external side effects; likewise mutating history alone is not proof of an interrupted write. Add proved-success, proved-failure, interrupted-verifier, no-checkpoint, and historical cases.

### P1-2 — M1 owner records lack `workspaceRoot` and so disappear from workspace diagnostics

**Code:** New `registerProcess` calls omit workspaceRoot in `src/core/runtime/coreSupervisor.ts:240-247`, `src/core/runtime/mcpOwnerLifecycle.ts:159-166`, `src/core/runtime/museWatchdogSupervisor.ts:109-116`, and `src/core/senopatiLifecycle.ts:128-135`; the existing Batch 2 OpenAI/Cloudflare tunnel registrations also omit it. `/status processes` gets M2 scanner entries only where workspaceRoot exactly matches caller. The registration records can exist while remaining invisible in the workspace diagnostics. Explicit global service identity must not be fabricated as tenant ownership.

**Required fix:** Define an explicit scoped owner contract: real workspaceRoot where provable; separate system-owned/global classification for deliberate shared services; explicit admin-only diagnostics for globals. Do not pretend `process.cwd()` is always the authorized tenant workspace. Add observability tests covering actual service launches.

### P1-3 — Process spawn/exit registration is race-prone

**Code:** `src/core/process/processSupervisor.ts:234-251` unconditionally writes `state:'running'` for `recordProcessSpawn`, even if a previously observed exit already marked the record terminal. Identity resolution is also asynchronous (lines 259-267), and many callers fire-and-forget spawn and exit observations. A late spawn update can resurrect a terminal record in the registry, especially for very short-lived Git/dynamic hook jobs.

**Independent live repro:** Process was observed exited after recordProcessExit. A late recordProcessSpawn observation changed its state to running. Observed values: beforeLateSpawn=exited, afterLateSpawn=running. Test registry existed only in an automatically deleted temporary directory.

**Required fix:** Make state transitions monotonic with an immutable exit terminal once recorded; bind PID and birth identity without resetting terminal. Add deterministic out-of-order spawn/exit/identity tests. Ensure error and early-exit paths are recorded after exact PID identity correlation.

### P1-4 — Existing generic diagnostics API has weaker privacy guard

**Code:** `src/core/process/processSupervisor.ts:385-393` only applies `filterByWorkspaceRoot` when the record already has `ownership.workspaceRoot`; missing-root records pass. It also renders global counts and metadata in `getProcessDiagnostics`. Currently slash commands use the stricter M2 scanner; the exported API can still mislead or leak when used by other callers.

**Required fix:** Require exact workspace match for any workspace-scoped caller, redact separately by trust level, and add a legacy missing-owner test.

### P2-1 — Read-only reconciliation has an optional persistence side effect
`processReconciliation.ts:418-429` permits checkpoint writing via `persistInterruptedMutations:true`. The status command uses the default non-writing mode, but the function is not categorically read-only under all options. Split pure inspection from explicit operator-authorized persistence, or make documentation and policy exact.

### P2-2 — Checkpoint ID/path boundary needs explicit validation
`src/core/tools/cliBridgeReconciliation.ts:35-51` resolves checkpoint path from jobId without explicit canonical ID validation in those functions. Persisted registry ownership fields are not validated to the same standard as record IDs. Harden canonical IDs and ensure the resolved checkpoint path remains under the intended directory. Assess separately from the confirmed tenant privacy bug.

## Mergerisk and recommendations
1. **STOP** merge/push of `66550f6b` and `23bfa091` to main until P0 fixes and focused P1 behavioral tests pass. Report-only scanners may remain in the isolated branch, but do not enable auto-reaping.
2. Correct P0-2 privacy and P0-3 multiwriter loss before adding broader owner instrumentation; both affect trustworthy evidence. Then wire M3 boot, fix terminal-job false positives and monotonic lifecycle, and establish global-vs-workspace service ownership.
3. Add fail-closed cross-process and real Windows crash/restart tests, full targeted suite, `bun run build`, diff-check and read-only logs/secret redaction checks.
4. Re-audit `main` immediately before integration; 75 dirty items include `src/core/tools/cliBridgeSession.ts`, overlapping these commits. The clean three-way merge-tree result does not guarantee worktree-safe merge while main is dirty. Isolate or finish parallel changes; never broad reset, force-checkout, auto-stage unrelated work, or push without a new explicit request.
5. The Batch 3 AGY report asserts complete M1/M3, but tested milestones and actual runtime wiring differ; certification remains **NOT YET CERTIFIED**.

## Evidence and limits
- Source checks were read-only. Two dynamic reproductions used a memory-only registry and an automatically deleted temporary registry file respectively.
- Targeted suites are not proof of every production subprocess family, real Windows kill/restart behavior, MCP/Telegram/Muse live tunnel ownership, or concurrent registry durability.
- No automatic orphan kill/auto-reap observed or authorized. Main and unrelated worktrees have not been modified.
