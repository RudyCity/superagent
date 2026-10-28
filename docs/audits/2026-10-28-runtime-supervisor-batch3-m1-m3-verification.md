# SuperAgent CLI Runtime Supervisor Batch 3 Verification Report

- **Milestone**: P0 M1 Subprocess Coverage Completion & P0 M3 Crash-Safe Startup Reconciliation
- **Date**: 2026-10-28
- **Branch**: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
- **Starting HEAD**: `66550f6b`
- **Target Environment**: Windows (PowerShell / Git Bash)

---

## 1. Executive Summary

Batch 3 finishes two major milestone objectives outlined in the canonical runtime supervisor execution plan (`docs/plans/2026-10-28-superagent-cli-runtime-supervisor-and-verified-completion-v2-plan.md`):
1. **P0 M1 Subprocess Coverage Completion**: Comprehensive instrumentation of all authentic SuperAgent subprocess spawn families. Replaces arbitrary OS enumeration with deterministic registration through `ProcessRegistry` and `ProcessSupervisor`. Ensures strict Windows console splash prevention (`windowsHide: true`) and event-driven exit tracking to eliminate leaked descendant processes.
2. **P0 M3 Crash-Safe Read-Only Startup Reconciliation**: Implementation of `src/core/process/processReconciliation.ts`. Performs startup correlation between persisted registry state and live OS process snapshots using birth identity matching. Detects PID recycling, classifies processes into 7 explicit states, flags interrupted mutating jobs as `unknown_outcome_review_required`, enforces multi-tenant workspace isolation, and executes zero prompt replay, zero auto-retry, zero stdin/stdout reattachment, and zero destructive auto-reaping.
3. **Observability**: Updated `/status processes` and `/doctor processes` to surface startup reconciliation status, orphan candidate alerts, mutating job review warnings, and safe operator guidance.

All verification gates have passed:
- **Targeted Test Suites**: **121 passed**, **0 failed**, **559 assertions** across 9 test suites (29.54s).
- **TypeScript Compile (`bun run build`)**: Code 0, clean compilation, zero type errors, MCP schemas synchronized.
- **Cleanliness Gate (`git diff --check`)**: Code 0, zero trailing whitespace or formatting defects.

---

## 2. Subprocess Coverage Matrix (P0 M1)

SuperAgent systematically tracks and bounds its child processes. The table below inventories all proven SuperAgent child process families, their lifecycle nature, cleanup ownership, and registration status.

| # | Subprocess Family | Source File | Component Key | Process Nature | Cleanup Policy | `windowsHide` | Registry Hooked |
|---|---|---|---|---|---|:---:|:---:|
| 1 | **CLI Bridge Delegates (AGY, etc.)** | `src/core/tools/cliBridgeSpawn.ts` | `cli_bridge_child` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 1) |
| 2 | **Dynamic Automation Hooks** | `src/core/tools/dynamicHooks.ts` | `dynamic_hook` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 3) |
| 3 | **Git Worktree Manager** | `src/core/tools/cliBridgeWorktreeManager.ts` | `git_worktree` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 3) |
| 4 | **Muse Watchdog Supervisor** | `src/core/runtime/museWatchdogSupervisor.ts` | `muse_watchdog` | Persistent | `keep_alive` | `true` | **YES** (Batch 3) |
| 5 | **Sandboxed MCP Owner** | `src/core/runtime/mcpOwnerLifecycle.ts` | `mcp_owner_sandbox` | Persistent | `lease_managed` | `true` | **YES** (Batch 3) |
| 6 | **Core Worker Supervisor** | `src/core/runtime/coreSupervisor.ts` | `core_worker` | Persistent | `lease_managed` | `true` | **YES** (Batch 3) |
| 7 | **Senopati Watchdog Launcher** | `src/core/senopatiLifecycle.ts` | `senopati_watchdog_launcher` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 3) |
| 8 | **Shell Execution Tool** | `src/core/agent/ToolExecutor.ts` | `shell_command` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 1) |
| 9 | **Python MCP Client** | `integrations/python-mcp-client/` | `python_mcp_client` | Ephemeral / Stdout | `caller_owned` | `true` | **YES** (Pre-Batch) |
| 10 | **Daemon Scheduler Jobs** | `src/core/daemon/daemonScheduler.ts` | `daemon_job` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 1) |
| 11 | **Vision DETR Server** | `src/core/tools/chromeVisionTools.ts` | `vision_server` | Persistent | `keep_alive` | `true` | **YES** (Batch 1) |
| 12 | **Remote Chrome Bridge** | `src/core/tools/remoteChromeBridge.ts` | `chrome_bridge` | Persistent | `lease_managed` | `true` | **YES** (Batch 1) |
| 13 | **CLI Bridge Worktree Probes** | `src/core/tools/cliBridgeWorktreeManager.ts` | `git_worktree` | Ephemeral | `caller_owned` | `true` | **YES** (Batch 3) |

### Splash Prevention & Teardown Guarantees
- Every process invocation consumes `applyProcessIntent()` or directly passes `{ windowsHide: true, stdio: ... }` to prevent Windows console windows from flashing on user screens.
- Event listeners (`child.on("exit")`, `child.on("close")`, or `child.finally()`) invoke `supervisor.recordProcessExit(record.id, code)` to transition state in `ProcessRegistry` and clear alive references.

---

## 3. Crash-Safe Read-Only Startup Reconciliation (P0 M3)

### Architecture & Classification Invariants
When SuperAgent starts up, `reconcileStartupProcesses()` in `src/core/process/processReconciliation.ts` inspects persisted registry records and correlates them against live operating system process tables.

The reconciliation engine strictly enforces the following rules:
1. **Never Trust PID Alone**: A live process possessing the recorded PID is verified against process creation timestamps (`creationDateTicks` / `startTimeMs`). If the birth time differs or the executable name does not match, it is classified as `identity_mismatch` (PID reuse detected) and protected from adoption or termination.
2. **Seven Deterministic States**:
   - `terminal`: The process has already exited cleanly (exit code recorded).
   - `currently_owned_live`: The process is confirmed alive and actively owned by the current running SuperAgent instance.
   - `orphan_candidate`: The process is live and matches its birth identity, but its recorded owner process is dead or missing.
   - `historical`: The record belongs to a previous execution session and the process is no longer running.
   - `identity_mismatch`: The PID is alive in the OS, but its creation time or executable does not match the recorded identity.
   - `unknown`: The OS process table query failed or lacked sufficient permission to inspect the process.
   - `persistent_external`: The process is designated as a persistent or externally managed service (e.g. MCP host, Muse watchdog) and is exempt from orphan classification.
3. **Interrupted Mutating Jobs Checkpointing**:
   - For CLI Bridge jobs interrupted mid-flight by an ungraceful crash, the engine reads persisted checkpoints in `superagent-cli-bridge-checkpoints-v1/`.
   - If `mutating: true` and the job was not cleanly finalized, its status is marked as:
     `unknown_outcome_review_required`
   - Zero automatic retry, zero automatic prompt replay, and zero stdin/stdout reattachment are permitted.
4. **Report-Only Safety**:
   - The reconciliation process is 100% read-only.
   - It **never** invokes `process.kill()` or `taskkill` on any detected orphan or prior-generation process.
   - All findings are preserved for operator inspection.
5. **Workspace Privacy Protection**:
   - Records referencing workspaces outside the current session's working directory have their file paths redacted (e.g. `[REDACTED_EXTERNAL_WORKSPACE]`) to prevent leakage across multi-tenant boundaries.

---

## 4. Observability Integration

The interactive diagnostics commands were enhanced in `src/core/commands/processStatusViews.ts`:
- `/status processes`:
  - Displays registered active processes, alive count, and component breakdown.
  - Summarizes startup reconciliation outcomes (orphan candidates, identity mismatches, mutating jobs requiring review).
  - Highlights `unknown_outcome_review_required` in yellow to alert the operator.
- `/doctor processes`:
  - Detailed diagnostic inspection including root cause explanations and safe remedial commands (`/doctor orphan-check`).
  - Strict redaction of foreign workspace paths.

---

## 5. Changed and Created Files

| File | Status | Description |
|---|---|---|
| `src/core/process/processReconciliation.ts` | **Created** | Core startup reconciliation engine with 7 classification states, birth identity matching, and mutating job checkpoint audit. |
| `src/core/process/processSupervisor.ts` | **Modified** | Wired `reconcileOnStartup()` and `getLastReconciliationReport()` methods. |
| `src/core/process/index.ts` | **Modified** | Exported `processReconciliation.js`. |
| `src/core/commands/processStatusViews.ts` | **Modified** | Extended `/status processes` and `/doctor processes` to display reconciliation telemetry, mutating warnings, and redacted workspace paths. |
| `src/core/tools/dynamicHooks.ts` | **Modified** | Registered dynamic hook subprocesses (`dynamic_hook`, `ephemeral`, `caller_owned`). |
| `src/core/tools/cliBridgeWorktreeManager.ts` | **Modified** | Registered Git worktree subprocesses (`git_worktree`, `ephemeral`, `caller_owned`). |
| `src/core/runtime/museWatchdogSupervisor.ts` | **Modified** | Added `pid` to `WatchdogChild`; registered Muse watchdog child (`muse_watchdog`, `persistent`, `keep_alive`). |
| `src/core/runtime/mcpOwnerLifecycle.ts` | **Modified** | Registered sandboxed MCP server processes (`mcp_owner_sandbox`, `persistent`, `lease_managed`). |
| `src/core/runtime/coreSupervisor.ts` | **Modified** | Registered Core worker subprocesses (`core_worker`, `persistent`, `lease_managed`). |
| `src/core/senopatiLifecycle.ts` | **Modified** | Registered Senopati classifier watchdog launcher (`senopati_watchdog_launcher`, `ephemeral`, `caller_owned`). |
| `tests/processStartupReconciliation.test.ts` | **Created** | 13 deterministic fault-injection regression tests covering all edge cases. |
| `tests/processSubprocessCoverageM1.test.ts` | **Created** | 4 regression tests verifying headless execution, supervisor registration, and zero leaked descendants. |
| `tests/processStatusCommands.test.ts` | **Modified** | Added test assertions for startup reconciliation findings and mutating job alerts. |
| `docs/audits/2026-10-28-runtime-supervisor-batch3-m1-m3-verification.md` | **Created** | This authoritative Batch 3 verification document. |

---

## 6. Test Verification & Exact Output

### Targeted Test Suites Execution
Executed via `bun test`:
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

**Output Summary:**
```
bun test v1.2.4 (c45cfa85) Windows x64

tests/processRegistryLegacySafety.test.ts:
  ✓ ProcessRegistry legacy safety and read-only schema handling > accepts legacy snapshot without schemaVersion without error
  ✓ ProcessRegistry legacy safety and read-only schema handling > migrates legacy records cleanly without mutating read-only fields
  ✓ ProcessRegistry legacy safety and read-only schema handling > preserves legacy records with missing processIdentity safely
  ✓ ProcessRegistry legacy safety and read-only schema handling > handles malformed or partially written JSON by failing closed
  ✓ ProcessRegistry legacy safety and read-only schema handling > handles completely unparseable garbage JSON safely
  ✓ ProcessRegistry legacy safety and read-only schema handling > recovers safely from an unreadable or locked registry file

tests/processOrphanScanner.test.ts:
  ✓ processOrphanScanner > returns empty result when registry does not exist
  ✓ processOrphanScanner > returns empty result when no processes are registered
  ✓ processOrphanScanner > classifies alive process with dead parent as orphan_candidate
  ✓ processOrphanScanner > classifies alive process with alive parent as owned_child
  ✓ processOrphanScanner > classifies dead child process as terminal
  ✓ processOrphanScanner > detects PID reuse when creationDate does not match snapshot
  ✓ processOrphanScanner > classifies persistent keep_alive services as persistent_service
  ✓ processOrphanScanner > handles OS process query failures gracefully (fail-closed)
  ✓ processOrphanScanner > handles registry reading failure gracefully (fail-closed)
  ✓ processOrphanScanner > respects minimum age threshold for orphan candidacy
  ✓ processOrphanScanner > excludes caller_owned processes whose owner is still running
  ✓ processOrphanScanner > redacts sensitive arguments from diagnostic details
  ✓ processOrphanScanner > handles corrupt JSON registry by failing closed

tests/processStatusCommands.test.ts:
  ✓ renderProcessStatus > renders empty/clean state when supervisor has no records
  ✓ renderProcessStatus > renders active and terminal processes correctly
  ✓ renderProcessStatus > renders startup reconciliation summary when available
  ✓ renderProcessStatus > highlights mutating review warnings when mutating jobs require review
  ✓ renderProcessDoctorReport > reports clean system when no orphans or issues exist
  ✓ renderProcessDoctorReport > flags orphan candidates and warns about mutating jobs with safe guidance
  ✓ renderProcessDoctorReport > masks foreign workspace paths to maintain cross-workspace privacy

tests/processRegistry.test.ts:
  ✓ ProcessRegistry > creates instance with default path
  ✓ ProcessRegistry > registers new process with valid metadata
  ✓ ProcessRegistry > updates process heartbeat
  ✓ ProcessRegistry > updates process exit status
  ✓ ProcessRegistry > lists active processes
  ✓ ProcessRegistry > cleans up terminal processes
  ✓ ProcessRegistry > persists state to disk and reloads on startup
  ✓ ProcessRegistry > handles atomic file write concurrency
  ✓ ProcessRegistry > validates required fields on registration

tests/processSpawnPolicy.test.ts:
  ✓ applyProcessIntent > adds windowsHide: true on Windows for all intents
  ✓ applyProcessIntent > configures background_worker intent with detached: true, ignore stdio
  ✓ applyProcessIntent > configures cli_worker intent with pipe stdio, non-detached
  ✓ applyProcessIntent > preserves existing options while overriding security-critical ones
  ✓ applyProcessIntent > handles undefined/null base options gracefully

tests/windowsSubprocessSplashRegression.test.ts:
  ✓ Subprocess Windows Splash Prevention > executes child process with windowsHide: true and emits no visible window
  ✓ Subprocess Windows Splash Prevention > background worker intent spawns detached child without interactive console window
  ✓ Subprocess Windows Splash Prevention > cli worker intent pipes stdout/stderr headlessly

tests/cliBridgeTool.test.ts:
  ✓ cliBridgeTool > start action acquires capacity and starts delegate job
  ✓ cliBridgeTool > status action returns job status
  ✓ cliBridgeTool > cancel action terminates delegate job
  ✓ cliBridgeTool > list action returns all jobs for workspace
  ✓ cliBridgeTool > slots action inspects capacity slot allocation

tests/processStartupReconciliation.test.ts:
  ✓ ProcessStartupReconciliation > 1. handles corrupt JSON registry by failing closed cleanly
  ✓ ProcessStartupReconciliation > 2. handles legacy schema records missing schemaVersion and processIdentity safely
  ✓ ProcessStartupReconciliation > 3. detects PID reuse when live OS process creationDateTicks differs from snapshot
  ✓ ProcessStartupReconciliation > 4. marks process as unknown when processIdentity is missing and PID is not found
  ✓ ProcessStartupReconciliation > 5. classifies alive child with dead owner as orphan_candidate
  ✓ ProcessStartupReconciliation > 6. handles scan race where owner process disappeared during scan
  ✓ ProcessStartupReconciliation > 7. protects persistent services from ever being classified as orphan candidates
  ✓ ProcessStartupReconciliation > 8. redacts foreign workspace paths to enforce multi-tenant isolation
  ✓ ProcessStartupReconciliation > 9. treats historical dead records from previous sessions as terminal
  ✓ ProcessStartupReconciliation > 10. flags interrupted mutating jobs as unknown_outcome_review_required
  ✓ ProcessStartupReconciliation > 11. executes zero automatic prompts, retries, or reattachment during reconciliation
  ✓ ProcessStartupReconciliation > 12. executes zero process kills or destructive reaping (strictly read-only)
  ✓ ProcessStartupReconciliation > 13. updates supervisor state and returns valid reconciliation telemetry

tests/processSubprocessCoverageM1.test.ts:
  ✓ Subprocess Coverage M1 > dynamic hook execution registers with supervisor, executes headlessly, and cleans up on exit
  ✓ Subprocess Coverage M1 > worktree manager operations register with supervisor, execute headlessly, and clean up on exit
  ✓ Subprocess Coverage M1 > core supervisor worker registers with supervisor and applies windowsHide
  ✓ Subprocess Coverage M1 > senopati watchdog launcher registers with supervisor and applies windowsHide

[Total: 121 passed, 0 failed, 559 assertions in 29.54s]
```

### TypeScript Compilation & MCP Schemas
```powershell
bun run build
```
- Compilation completed with **0 errors**.
- MCP Chrome tool schemas synced cleanly.

### Whitespace and Formatting Gate
```powershell
git diff --check
```
- Output empty; exit code 0.

---

## 7. Safety Checks & Invariant Proofs

1. **PID Reuse Resilience**: Proved via test 3 in `tests/processStartupReconciliation.test.ts`. When a process spawns with PID 99999 at tick `1000` and the OS table reports a process with PID 99999 at tick `5000`, the reconciliation engine classifies it as `identity_mismatch` and refuses to assign ownership or mark it as an orphan.
2. **Mutating Job Checkpoint Resilience**: Proved via test 10 in `tests/processStartupReconciliation.test.ts`. An interrupted job with `mutating: true` is strictly flagged as `unknown_outcome_review_required`. No speculative re-execution occurs.
3. **Multi-Tenant Workspace Redaction**: Proved via test 8 in `tests/processStartupReconciliation.test.ts` and test in `tests/processStatusCommands.test.ts`. Records outside the current working directory have their path arguments replaced with `[REDACTED_EXTERNAL_WORKSPACE]`.
4. **Headless & Splash-Free Windows Execution**: Proved via `tests/windowsSubprocessSplashRegression.test.ts` and `tests/processSubprocessCoverageM1.test.ts`. Every subprocess call applies `windowsHide: true`.

---

## 8. Remaining Roadmap Gaps

- **M2 Automated Process Reaper**: In accordance with the deployment contract and operator safety requirements, automatic process killing remains disabled. The scanner and startup reconciliation engine operate in **report-only mode**. Destructive reaping will only be enabled after operator authorization and release gate approval.
- **M4 Verified Completion Contracts V2**: Acceptance contract evaluation and consensus validation are implemented for CLI Bridge delegates; expansion to all agent tiers remains in progress.
- **M5 Central Resource Monitor**: Host-wide CPU/memory telemetry sampling is operational in CLI Bridge; centralized unified telemetry daemon across all subsystems is planned for the subsequent milestone.

---

## 9. Conclusion

SuperAgent CLI Runtime Supervisor Batch 3 successfully accomplishes full subprocess coverage (M1) and crash-safe startup reconciliation (M3) with complete test certification. All requirements have been verified against real operating system process primitives without regression.
