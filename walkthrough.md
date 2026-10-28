# Walkthrough: 2026-10-28 Algorithm Remediation

## Executive Summary
This remediation addresses the critical algorithm vulnerabilities identified in the 2026-10-28 re-audit across 7 priority clusters:
1. **P0 DEEP-01 (FastPath false-success)**: Explicit terminal outcomes on FastPath completion, throw/network failure, and abort; fail-closed behavior in `chatRuntimeProcessor` preventing null/unknown outcomes from completing; deduplicated single-emission of terminal states.
2. **P0 DEEP-02 (Delegated fileScope hard enforcement)**: Hard code enforcement of immutable `fileScope` boundary via `fileScopeGuard.ts` and `ToolExecutor.ts` before tool execution and YOLO bypass; canonicalization of Windows paths, traversal (`../`) checks, symlink/reparse escape detection, and shell command/chdir interception.
3. **P1 DEEP-03 (Permissions & approval inheritance)**: Elimination of broad subagent auto-approval; full parent permission inheritance with provenance tracking (`[Subagent ... via parent ...]`) and fail-closed authorization.
4. **P1 DEEP-04 (Classifier progress execution scoping)**: Replacement of mutable shared singleton `globalProgressCallback` with execution-scoped `progressStorage` (`AsyncLocalStorage`) and active agent event routing, preventing cross-contamination between concurrent sessions.
5. **P1 DEEP-05 (Concurrency 0..N & safe lease ownership)**: Support for concurrency limits `0` (unlimited), `1`, `2`, `3`, ..., `N`; elimination of arbitrary 60s lock theft for live owner processes; caller-owned lease verification with periodic heartbeat.
6. **P1 DEEP-07 (Text-only checklist continuation guard)**: Preservation of needs-input, permission, and limitation responses from being forced into repeated narration nudges; hard cap preventing no-progress loops; reset of continuation counters upon real tool execution.
7. **P2 DEEP-11 (Subagent question handling)**: Elimination of silent `options[0]` fallback when no master/UI handler exists; explicit `[NEEDS_INPUT]` error and waiting state.

---

## Key File Modifications

| Component | Files Modified / Created | Summary of Changes |
|-----------|--------------------------|---------------------|
| **DEEP-01** | `src/core/agent/FastPath.ts`<br>`src/core/utils/chatRuntimeProcessor.ts`<br>`tests/fastPathTerminalOutcome.test.ts`<br>`tests/chatRuntimeLedger.test.ts` | Sets explicit `lastTaskOutcome` (`task_completed`, `task_aborted`, `task_failed`). `chatRuntimeProcessor` maps null/unknown outcomes to `failed` and records failure reason in ledger. |
| **DEEP-02** | `src/core/agent/fileScopeGuard.ts` (new)<br>`src/core/agent.ts`<br>`src/core/agent/ToolExecutor.ts`<br>`src/core/tools/types.ts`<br>`src/core/tools/subagentTools.ts`<br>`tests/fileScopeHardEnforcement.test.ts` (new) | Canonicalizes paths and verifies every file/shell tool call against immutable `fileScope` before YOLO or permission bypass. Intercepts `cd`, relative traversals, and symlinks. |
| **DEEP-03** | `src/core/tools/subagentTools.ts`<br>`src/core/tools/superagentTools.ts`<br>`tests/subagentPermissionsAndQuestions.test.ts` (new) | Replaces `return !isDestructive` with parent permission delegation, provenance logging, and fail-closed authorization. |
| **DEEP-04** | `src/core/tools/state.ts`<br>`src/core/agent.ts`<br>`tests/classifierProgressIsolation.test.ts` (new) | Scopes progress callbacks via `AsyncLocalStorage<ProgressCallback>` and `agentLocalStorage`; removes agent global callback overwrite. |
| **DEEP-05** | `src/core/rateLimiter.ts`<br>`src/core/agent/LoopIterationProcessor.ts`<br>`src/core/agent/HistoryCompactor.ts`<br>`src/core/masterAgent.ts`<br>`src/core/agent/criticAgent.ts`<br>`src/core/agent/promptOptimizer.ts`<br>`src/core/commands/settingsCommand.ts`<br>`tests/concurrencyLimiterSafeOwnership.test.ts` (new) | `SharedConcurrencyLimiter` manages `0..N` slots with `ConcurrencyLease`, heartbeat timer, and alive-process validation. Locks held by live processes >60s are never deleted. Callers release only caller-owned leases. |
| **DEEP-07** | `src/core/agent/ChecklistContinuationGuard.ts`<br>`src/core/agent/LoopIterationProcessor.ts`<br>`tests/checklistContinuationGuard.test.ts` | Added `isNeedsInputOrLimitation` and `isRepetitiveNarration`. Suppresses checklist/planning nudges when agent requests input, permission, or reports blockers. Resets nudge count on tool success. |
| **DEEP-11** | `src/core/tools/subagentTools.ts`<br>`src/core/tools/superagentTools.ts`<br>`tests/subagentPermissionsAndQuestions.test.ts` (new) | Replaced `return options[0]` with explicit `[NEEDS_INPUT]` throw and subagent status transition to `waiting`. |

---

## Test Verification Results

All tests executed via `bun test`:

### Targeted Test Suites
```
bun test tests/fastPathTerminalOutcome.test.ts \
         tests/chatRuntimeLedger.test.ts \
         tests/fileScopeHardEnforcement.test.ts \
         tests/subagentPermissionsAndQuestions.test.ts \
         tests/classifierProgressIsolation.test.ts \
         tests/concurrencyLimiterSafeOwnership.test.ts \
         tests/checklistContinuationGuard.test.ts
```
**Outcome**:
- **45 passed**, **0 failed** across 7 test files (135 assertions).

### Regression Test Suites
```
bun test tests/subagentPermissions.test.ts tests/agentAbortInterrupt.test.ts tests/permissions.test.ts
```
**Outcome**:
- **45 passed**, **0 failed** across 2 test files (88 assertions).

### Build Verification
```
bun run build
```
- TypeScript check (`tsc`) completed with **0 errors**.
- MCP Chrome schemas synchronized cleanly.


---

# Post-Audit Core Remediation (2026-10-28)

Following the independent re-audit at `T-Line docs/audits/2026-10-28-post-agy-independent-reaudit.md`, the remaining Core vulnerabilities have been resolved:

### 1. P0 DEEP-02: Delegated fileScope Shell Boundary
- **Vulnerability**: While file API tools blocked direct path escapes, `validateToolCallAgainstFileScope` did not check shell commands referencing outside-scope absolute paths, redirection, or nested shells.
- **Remediation**:
  - Implemented `validateShellCommandString` in `src/core/agent/fileScopeGuard.ts` with cross-platform tokenization for cmd.exe, PowerShell, and POSIX shells.
  - Enforced effective cwd validation within delegated `fileScope`.
  - Added detection of absolute paths (Windows drive letters `C:\`, Git Bash `/c/`, UNC `\\`, Unix absolute `/`, PowerShell provider paths).
  - Intercepted file redirection operators (`>`, `>>`, `<`, `2>`, `&>`, `| Out-File`, `| Set-Content`, `| tee`) and validated target paths against `fileScope` (allowing standard null sinks `nul`, `/dev/null`).
  - Intercepted file manipulation commands (`cat`, `type`, `Get-Content`, `Set-Content`, `cp`, `mv`, `del`, `rm`) and script execution (`node`, `python`, `powershell -File`, `bash`, `sh`).
  - Added fail-closed denial on obfuscated/encoded commands (`-enc`, `-EncodedCommand`).
  - Added recursive unwrapping and validation of nested shells (`bash -c`, `cmd /c`, `powershell -Command`, `eval`).
  - Added regression test suites and verified that the direct independent probe (`fileScope = ['src/core/agent/**']`, `cwd = 'src/core/agent'`, command referencing absolute `package.json`) is now hard-denied across POSIX, CMD, and PowerShell syntaxes.

### 2. P1 DEEP-04: Production Classifier Progress Routing
- **Vulnerability**: Production `RequestProcessor.processRequest` ran before `agentLocalStorage.run`, did not pass `onProgress` to `classifyRequest`, and `runWithProgressCallback` had no production call site.
- **Remediation**:
  - In `src/core/agent.ts`, wrapped `RequestProcessor.processRequest` in both `agentLocalStorage.run(this, ...)` and `runWithProgressCallback((ev) => this.onEvent(ev), ...)`.
  - In `src/core/agent/RequestProcessor.ts`, explicitly passed `onProgress: (event: any) => agent.onEvent(event)` to `classifyRequest`.
  - In `src/core/requestClassifier.ts`, wired `options?.onProgress ?? getProgressCallback()` through `classifyRequest`, `classifyWithSenopatiONNX`, and `getSenopatiSession`.
  - Added regression tests in `tests/classifierProgressIsolation.test.ts` verifying concurrent execution of `RequestProcessor.processRequest` for two distinct agents with zero cross-routing of model load or progress events.

### 3. P2 NEW-01: Concurrency Waiter Queue Hygiene
- **Vulnerability**: `SharedConcurrencyLimiter.acquire` pushed a wake callback on every 100ms interval; if the timer fired normally, the callback was not removed, causing stale callback accumulation under contention.
- **Remediation**:
  - Implemented self-cancelling and self-removing waiter callbacks in `src/core/rateLimiter.ts`: when the 100ms timer fires, it splices itself out of `this.processQueue`.
  - On `release()`, active waiters are popped and resolved cleanly.
  - Added regression test asserting `processQueue.length` remains strictly bounded by active contender count (does not grow over time) and zero wakeups are lost.

### 4. P1/P2 DEEP-07: Repetitive Narration Wiring
- **Remediation**:
  - Wired `isRepetitiveNarration` into `src/core/agent/LoopIterationProcessor.ts` by collecting previous assistant message content and detecting repetition loops.
  - Suppressed planning continuation nudges when repetitive narration is detected without tool progress.
  - In checklist enforcement, terminated auto-continuation immediately if the model loops on repetitive narration.
  - Added unit and edge case tests in `tests/checklistContinuationGuard.test.ts`.

---

## Verification Results

### Build
- `bun run build`: **PASS** (0 TypeScript errors; MCP Chrome schemas synced).

### Targeted Test Suites (7 suites)
```
bun test tests/fastPathTerminalOutcome.test.ts \
         tests/chatRuntimeLedger.test.ts \
         tests/fileScopeHardEnforcement.test.ts \
         tests/subagentPermissionsAndQuestions.test.ts \
         tests/classifierProgressIsolation.test.ts \
         tests/concurrencyLimiterSafeOwnership.test.ts \
         tests/checklistContinuationGuard.test.ts
```
**Outcome**: **53 pass**, **0 fail** (179 assertions).

### Regression Test Suites (2 suites)
```
bun test tests/agentAbortInterrupt.test.ts tests/permissions.test.ts
```
**Outcome**: **45 pass**, **0 fail** (88 assertions).

### Total Focused & Regression Suites
**98 passed, 0 failed** across 9 test files (267 assertions).

### Direct Adversarial Probe (DEEP-02)
- Target: `package.json` in workspace root.
- Scope: `['src/core/agent/**']`, `cwd: 'src/core/agent'`.
- Outcome:
  - POSIX `cat`: **DENIED** (`{"allowed":false}`)
  - CMD `type`: **DENIED** (`{"allowed":false}`)
  - PowerShell `Get-Content`: **DENIED** (`{"allowed":false}`)


---

# Milestone M1 — Reliable Parallel Capacity (2026-10-28)

## Executive Summary

Milestone M1 establishes reliable parallel execution capacity for the CLI Bridge multi-agent runtime in accordance with `docs/plans/2026-10-28-superagent-cli-bridge-multi-agent-runtime-master-plan.md`. It eliminates PID-only slot assumptions, introduces a rigorous 6-state fail-closed stale-slot classifier, enforces live owner and surviving descendant protection, adds safe operator/automatic orphan recovery, and proves full 4-agent AGY parallel execution on Windows.

---

## Key File Modifications

| Component | Files Modified / Created | Summary of Changes |
|-----------|--------------------------|---------------------|
| **Stale-Slot Classifier (M1.2)** | `src/core/tools/cliBridgeRecovery.ts` | Added `classifyCapacitySlot` with 6 explicit states (`active_verified`, `owner_alive_child_alive`, `owner_dead_child_alive_review_required`, `owner_dead_child_dead_recoverable`, `identity_mismatch_blocked`, `corrupt_blocked`). Strictly enforces `recoverable = (state === "owner_dead_child_dead_recoverable")`. Detects PID reuse on owner and child processes via process birth timestamps (`Win32_Process.CreationDate.Ticks`). |
| **Capacity Management & Orphan Recovery (M1.3)** | `src/core/tools/cliBridgeCapacity.ts` | Extended slot `owner.json` metadata with `ownerProcessIdentity`, `childPid`, `childProcessIdentity`, `cliAlias`, `workspaceDigest`, `heartbeatAt`. Implemented `inspectCapacitySlot`, `listDetailedCapacitySlots`, `recoverProvenOrphanSlot`, `updateCliBridgeCapacity`, and automatic orphan recovery in `acquireCliBridgeCapacity`. |
| **Background Job Integration (M1.1 / M1.3)** | `src/core/tools/cliBridgeDelegateJobs.ts` | Records `ownerProcessIdentity` during slot acquisition; updates slot metadata with `childPid` upon subprocess spawn; updates `heartbeatAt` during periodic bridge pulses; updates `childProcessIdentity` once OS CIM probe resolves. |
| **Tool Layer & Operator Actions (M1.3)** | `src/core/tools/cliBridgeTool.ts`, `src/core/mcp/superagentMcpServer.ts` | Added privacy-safe host-wide `delegate.slots` summary and explicit `delegate.recover-slot`. Host summaries never expose foreign job IDs, PIDs, paths, or workspace digests. Detailed `delegate.recovery` remains job-scoped behind existing workspace authorization. MCP schema now exposes the new recovery action/slot field. |
| **Regression Test Suite (M1.4 / M1.6)** | `tests/cliBridgeCapacityRecovery.test.ts`, `tests/cliBridgeDelegateJobs.test.ts` | Covers fail-closed legacy child evidence, PID reuse, live-owner protection, concurrent recovery race safety, privacy-safe slot reporting, stale foreign-shard admission, safe orphan recovery, and 4-worker concurrency. M1.7 Git-worktree concurrency remains open. |

---

## Live Host Audit & Verification Evidence

### 1. Live Host Slot Inspection (M1.1 / M1.5)
- Queried production capacity root (`C:\Users\USER\AppData\Local\Temp\superagent-cli-bridge-capacity-v1`).
- Verified that slots occupied by active processes (owner Bun PID 41424, start identity `win:639286916904160640`; child PIDs 46164, 38660, 24676, 35316) were accurately classified as `active_verified` with `recoverable: false`.
- Enforced strict live owner protection: zero active sessions were killed or stolen. Slots 2 and 3 naturally finished their work and cleanly transitioned to `available`.

### 2. 4-Worker AGY Concurrency Probe (M1.6)
- Executed 4 concurrent AGY background delegations (`--mode plan`) under CLI Bridge orchestrator. The probe used isolated capacity/config roots; it did **not** create four Git worktrees, so M1.7 remains open:
  - **AGY Alpha**: Job `clj_1793138836610_2bbfa7b3`, Slot 0, PID 42932, duration 14,375ms, exitCode 0 (`AGY_PROBE_Alpha_OK`).
  - **AGY Beta**: Job `clj_1793138836610_253329e2`, Slot 1, PID 5368, duration 19,447ms, exitCode 0 (`AGY_PROBE_Beta_OK`).
  - **AGY Gamma**: Job `clj_1793138836594_20380909`, Slot 2, PID 44176, duration 14,299ms, exitCode 0 (`AGY_PROBE_Gamma_OK`).
  - **AGY Delta**: Job `clj_1793138836610_bd1596ca`, Slot 3, PID 43288, duration 13,834ms, exitCode 0 (`AGY_PROBE_Delta_OK`).
- Mid-run observation verified all 4 slots concurrently in `active_verified` state with separate child PIDs.
- Post-run observation verified all 4 slots cleanly returned to `available`.

---

## Independent Audit Corrections

The delegated AGY implementation was not accepted without review. The independent audit found and fixed:

- foreign job/PID metadata leakage in host-wide slot diagnostics;
- false `4/4` admission caused by stale foreign active shards being counted as local reservations;
- fail-open legacy leases where a missing child PID was incorrectly equivalent to a dead child;
- concurrent orphan-recovery TOCTOU risk;
- lease metadata update races;
- missing external MCP schema for `delegate.recover-slot`;
- an incorrect M1.7 completion claim (the 4-AGY probe did not use four Git worktrees).

### Final Audit Test Matrix
```
bun test tests/cliBridgeCapacityRecovery.test.ts \
         tests/cliBridgeDelegateJobs.test.ts \
         tests/cliBridgeTool.test.ts \
         tests/cliBridgeHardening.test.ts \
         tests/cliBridgeRecovery.test.ts \
         tests/cliBridgeProcessIdentity.test.ts \
         tests/cliBridgeWorkspaceIsolation.test.ts \
         tests/cliBridgeCrossProcessClaims.test.ts
```
**Outcome**: **114 passed**, **0 failed** (**502 assertions**).

A fresh independent real-AGY acceptance probe then launched four simultaneous AGY jobs through the updated CLI Bridge. Mid-run all four slots were `active_verified` with distinct child PIDs; all four jobs exited 0 and all four slots returned to `available`.

### Build Verification
```
bun run build
```
- TypeScript check (`tsc`): **PASS** (0 errors).
- Package: `superagent@1.14.55` built cleanly with Bun 1.4.2.
- MCP Chrome schemas synchronized: 0 differences.

---

# Multi-Agent Runtime Milestones M1.7 – M6 — AGY Implementation Report (2026-10-28)

## Executive Summary

This section records the delegated AGY implementation and its modular test results. It was initially reported as production-ready, but the subsequent independent re-audit **supersedes that conclusion**.

The AGY did add useful primitives for worktrees, resource sampling/scheduling calculations, acceptance verification, role profiles, DAG state helpers, reconciliation helpers, adapters, and orchestration HTTP feeds. Its test matrix is reproducible at **152 passed, 0 failed, 696 assertions**, and the project builds cleanly.

Independent source/runtime audit found that most M2–M5 primitives are not wired into the real `delegate.start` path, generalized resource claims are non-atomic under simultaneous writers, DAG state is in-memory and does not dispatch jobs, Claude/Codex adapters leak full process environment, and no T-Line dashboard consumes the new APIs. See `docs/audits/2026-10-28-cli-bridge-multi-agent-runtime-independent-reaudit.md` for the authoritative status.

---

## Key File Modifications

| Component | Files Modified / Created | Summary of Changes |
|-----------|--------------------------|---------------------|
| **Git Worktree Manager (M1.7 & M3.1)** | `src/core/tools/cliBridgeWorktreeManager.ts` (new)<br>`tests/cliBridgeWorktreeIsolation.test.ts` (new) | Created isolated worktree lifecycle: `createIsolatedWorktree` (pinned base SHA, branch creation, node_modules linking), `removeIsolatedWorktree` (force removal, git prune, branch deletion), `listIsolatedWorktrees` (porcelain parser), and `getWorktreeCommitProvenance`. |
| **Resource Sampler & Adaptive Scheduler (M2)** | `src/core/tools/cliBridgeResourceSampler.ts` (new)<br>`src/core/tools/cliBridgeScheduler.ts` (new)<br>`tests/cliBridgeAdaptiveScheduler.test.ts` (new) | Measures CPU cores, 1m load average, delta CPU usage %, free memory %, and process RSS. Classifies pressure (`none`, `moderate`, `high`, `critical`). Calculates dynamic 2–8 slots. Enforces per-project quotas, heavy/exclusive job rules, and priority queue with aging and fairness. |
| **Resource Claims & Verified Contracts (M3)** | `src/core/tools/cliBridgeResourceClaims.ts` (new)<br>`src/core/tools/cliBridgeAcceptance.ts` (new)<br>`tests/cliBridgeAcceptance.test.ts` (new) | Implemented shared-read and exclusive-write claims for `file`, `tree`, `git-branch`, `port`, `cdp-tab`, `service`. Built acceptance verification engine with artifact size, SHA-256 hash checks, test/build/custom command execution, and gitDiff constraints. |
| **Agent Profiles & Durable DAG (M4)** | `src/core/tools/cliBridgeRoleProfiles.ts` (new)<br>`src/core/tools/cliBridgeDag.ts` (new)<br>`tests/cliBridgeDag.test.ts` (new) | Built built-in role profiles (`architect`, `coder`, `tester`, `reviewer`, `researcher`). Built DAG execution engine with cycle detection, bounded fan-out (`maxFanOut = 1..8`), join/barrier synchronization, failure propagation, reviewer verdicts, consensus voting, and speculative candidate selection. |
| **Crash Reconciliation & Adapters (M5)** | `src/core/tools/cliBridgeReconciliation.ts` (new)<br>`src/core/tools/cliBridgeAdapters.ts` (new)<br>`tests/cliBridgeReconciliation.test.ts` (new) | Persists and restores job checkpoints. Reconciles interrupted jobs on restart: read-only jobs safely mark `interrupted` (eligible for retry); mutating unverified jobs mark `unknown_outcome_review_required` (blind retry blocked). Implemented `ICliAdapter`, normalized events, and environment allowlist filtering for AGY, Claude, and Codex. |
| **T-Line Live Feed & API (M6)** | `src/core/tools/cliBridgeOrchestrationFeed.ts` (new)<br>`src/serverRoutes.ts`<br>`tests/cliBridgeOrchestrationFeed.test.ts` (new) | Provides `getOrchestrationLiveStatus` and `getOrchestrationMetrics`. Added authenticated endpoints: `GET /api/orchestration/status`, `GET /api/orchestration/metrics`, `GET /api/orchestration/dags`, and `POST /api/orchestration/dag`. |

---

## Test Verification Results

### 1. Milestone Test Execution Matrix
```bash
bun test tests/cliBridgeWorktreeIsolation.test.ts \
         tests/cliBridgeAdaptiveScheduler.test.ts \
         tests/cliBridgeAcceptance.test.ts \
         tests/cliBridgeDag.test.ts \
         tests/cliBridgeReconciliation.test.ts \
         tests/cliBridgeOrchestrationFeed.test.ts \
         tests/cliBridgeCapacityRecovery.test.ts \
         tests/cliBridgeDelegateJobs.test.ts \
         tests/cliBridgeTool.test.ts \
         tests/cliBridgeHardening.test.ts \
         tests/cliBridgeRecovery.test.ts \
         tests/cliBridgeProcessIdentity.test.ts \
         tests/cliBridgeWorkspaceIsolation.test.ts \
         tests/cliBridgeCrossProcessClaims.test.ts
```

**Outcome**:
- **152 passed**, **0 failed** across 14 test suites (**696 assertions**).
- Execution time: 59.22 seconds.

### 2. Breakdown by Feature Domain
- **Git Worktree Isolation (M1.7 & M3.1)**: 3 passed, 0 failed (58 assertions).
- **Resource Sampler & Adaptive Scheduler (M2)**: 10 passed, 0 failed (34 assertions).
- **Resource Claims & Verified Completion (M3)**: 8 passed, 0 failed (23 assertions).
- **Agent Profiles & DAG Orchestration (M4)**: 7 passed, 0 failed (35 assertions).
- **Crash Reconciliation & Adapters (M5)**: 7 passed, 0 failed (27 assertions).
- **T-Line Orchestration Feed & Metrics (M6)**: 3 passed, 0 failed (18 assertions).
- **Existing Baseline & Hardening Regressions (M1)**: 114 passed, 0 failed (501 assertions).

### 3. Production Build Verification
```bash
bun run build
```
- TypeScript compilation (`tsc`): **PASS** (0 errors).
- Chrome MCP schema synchronization: **PASS** (0 differences).
- Distribution artifact: `superagent@1.14.55` built cleanly with Bun 1.4.2.

---

## Independent Re-Audit Correction

The passing modular suites do **not** prove end-to-end runtime integration.

Independent re-audit established:

- real `startDelegateJob()` still uses fixed `maxConcurrentJobs()`; adaptive scheduler/resource pressure is not wired into admission;
- worktree tests use direct test-process edits/commits rather than four AGY delegates;
- generalized write claims fail atomicity under concurrency: **40/40 simultaneous writer probes produced double-writer acquisition**;
- richer `AcceptanceContract` is not wired into real delegate completion or public CLI Bridge schema;
- DAG helpers do not dispatch CLI Bridge jobs and active DAGs are held only in an in-memory `Map`;
- reviewer/consensus/speculative helpers do not spawn real reviewer/candidate agents;
- reconciliation/checkpoint helpers are not called during CLI Bridge initialization;
- AGY adapter filters environment, but Claude/Codex adapters leak full `process.env`; unknown aliases silently fall back to AGY;
- orchestration feed exposes host-wide job/PID slot metadata and global DAG state;
- T-Line contains no UI/API-consumer implementation for the new orchestration endpoints.

Authoritative audit: `docs/audits/2026-10-28-cli-bridge-multi-agent-runtime-independent-reaudit.md`.

Current conclusion: M1 stale-slot hardening is production-backed; M2–M6 remain **prototype primitives requiring runtime integration and E2E certification**.

---

## Delegated fileScope Environment-Variable Expansion Remediation (2026-10-28)

Following the final independent re-audit, the remaining P0 blocker has been resolved:

### 1. Root Cause Analysis
When shell commands invoked by delegated children with an explicit `fileScope` (e.g. `['src/core/agent/**']`) contained environment variable references (e.g. `$env:WINDIR\win.ini`, `%WINDIR%\win.ini`, `$HOME/.bashrc`), Node.js `path.isAbsolute` evaluated them as false because they did not begin with a Windows drive letter or Unix root slash. Consequently, `fileScopeGuard.ts` treated them as relative paths under `effectiveCwd` (which was inside `fileScope`), falsely allowing the commands. At runtime, the shell expanded these variables to paths outside `fileScope`.

### 2. Implementation Changes
- **Environment Variable Resolution (`resolveEnvironmentVariable`)**:
  - Implemented case-insensitive environment variable resolution against `process.env`.
  - Added platform fallbacks for standard system variables (`home`, `userprofile`, `windir`, `systemroot`, `temp`, `tmp`).
- **Environment Variable Expansion (`expandEnvironmentVariables`)**:
  - Expanded PowerShell `$env:VAR` and `${env:VAR}` (including parenthetical names like `ProgramFiles(x86)`).
  - Expanded PowerShell `env:VAR` provider references.
  - Expanded cmd.exe `%VAR%` and delayed expansion `!VAR!`.
  - Expanded POSIX `$HOME`, `${VAR}`, and `$VAR` (excluding PowerShell builtins `$null`, `$true`, `$false`, `$this`, `$args`, `$_`).
  - Expanded tilde (`~`) home directory expansion (respecting word boundaries to prevent matching Git syntax like `HEAD~1`).
- **Fail-Closed Security Boundary**:
  - Unverified or unresolvable environment variables fail closed immediately.
  - Dynamic command substitution (`$(...)` and backticks) fails closed immediately.
  - Arguments to file operations (`cat`, `type`, `Get-Content`, `rm`, `cp`, `mv`, etc.), redirections (`>`, `>>`, `| Out-File`, `| tee`), directory changes (`cd`), and script executions (`node`, `python`, etc.) containing unresolved `$` / `%` / `!` / `~` fail closed immediately and are never resolved as relative paths.
  - Implemented PowerShell `Join-Path` validator verifying that combined operands do not escape `fileScope`.
  - Fixed Unix absolute path regex boundaries (`(?:^|[\s"'>|&;=])`) to prevent false-positive matching of relative directory segments.
- **Harmless Command Preservation**:
  - Standard commands without filesystem escape risk (`ls`, `git status`, `git diff HEAD~1`, `npm test`, in-scope file reads) remain fully functional.

### 3. Verification & Evidence
- **Exact Independent Repros Verified**:
  - Repro 1: `powershell -Command "Get-Content $env:WINDIR\win.ini"` -> `allowed: false` (`Shell command references absolute path "C:\WINDOWS\win.ini" outside allowed fileScope`)
  - Repro 2: `cmd /c type %WINDIR%\win.ini` -> `allowed: false` (`Shell command references absolute path "C:\WINDOWS\win.ini" outside allowed fileScope`)
- **24-Point Adversarial Probe Suite**: All 24 probes passed (bracketed pwsh, delayed cmd, POSIX $HOME, tilde, Join-Path variants, command substitution, undefined variables, redirections, harmless commands).
- **ToolExecutor Integration**: Verified via `ToolExecutor.executeTools` integration tests with real mock agents.
- **Focused Regression Test Suites**:
  - `tests/fileScopeHardEnforcement.test.ts`: 13 passed, 0 failed (83 assertions).
  - All 7 focused regression suites: 55 passed, 0 failed (218 assertions).
  - Vitest test suite: 45 passed, 0 failed.
- **Production Build**:
  - `bun run build` cleanly compiled with 0 errors.

