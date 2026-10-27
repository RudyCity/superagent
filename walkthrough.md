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
