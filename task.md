# Tasks: 2026-10-28 Post-Audit Core Remediation

- [x] P0: Delegated fileScope environment-variable expansion escape remediation
  - [x] Identify root cause in `fileScopeGuard.ts` for shell environment-variable expansions
  - [x] Implement fail-closed environment-variable expansion, inspection, and rejection
  - [x] Support PowerShell `$env:VAR`, `${env:VAR}`, `Join-Path` env operands
  - [x] Support cmd `%VAR%` and `!VAR!`
  - [x] Support POSIX `$HOME`, `${VAR}`, and `~` tilde expansion
  - [x] Fail closed on dynamic command substitution (`$()`, `` `...` ``)
  - [x] Cover quoted and unquoted forms in nested shells, file ops, redirections, and script executions
  - [x] Preserve harmless commands without filesystem escapes
  - [x] Add adversarial regression tests in `tests/fileScopeHardEnforcement.test.ts` (including ToolExecutor integration and exact repros)
  - [x] Verify both independent repros return `allowed: false`
  - [x] Run full focused regression suite and `bun run build`
  - [x] Update `walkthrough.md` and commit/push changes

- [x] P0 (DEEP-02): Delegated fileScope shell escape remediation
  - [x] Implement platform-aware shell command validator in `src/core/agent/fileScopeGuard.ts` (cmd.exe, PowerShell, POSIX)
  - [x] Enforce effective cwd within fileScope
  - [x] Detect absolute paths outside scope (Windows drive paths, Git Bash `/c/`, UNC, Unix absolute)
  - [x] Intercept redirection operators (`>`, `>>`, `<`, `2>`, `Out-File`, `Set-Content`, `tee`)
  - [x] Intercept file manipulation commands (`cat`, `type`, `Get-Content`, `Set-Content`, `cp`, `mv`, `del`, `rm`)
  - [x] Intercept script invocations (`node`, `python`, `powershell`, `bash`, `sh`) and executable paths
  - [x] Detect and fail closed on uninspectable encoded commands (`-enc`, `-EncodedCommand`)
  - [x] Unpack and recursively validate nested shell invocations (`bash -c`, `cmd /c`, `powershell -c`)
  - [x] Add regression tests in `tests/fileScopeHardEnforcement.test.ts` including direct independent probe and ToolExecutor integration
- [x] P1 (DEEP-04): Classifier progress isolation wired through production preprocessing
  - [x] Wrap `RequestProcessor.processRequest` in `agentLocalStorage.run` and `runWithProgressCallback` in `src/core/agent.ts`
  - [x] Pass `onProgress: (ev) => agent.onEvent(ev)` from `RequestProcessor.processRequest` to `classifyRequest` in `src/core/agent/RequestProcessor.ts`
  - [x] Wire `onProgress` fallback via `getProgressCallback()` in `src/core/requestClassifier.ts` (`classifyRequest`, `classifyWithSenopatiONNX`, `getSenopatiSession`)
  - [x] Add regression test in `tests/classifierProgressIsolation.test.ts` testing concurrent real `RequestProcessor.processRequest`
- [x] P2 (NEW-01): Concurrency waiter hygiene in SharedConcurrencyLimiter
  - [x] Update `SharedConcurrencyLimiter.acquire` in `src/core/rateLimiter.ts` to remove expired waiters on timeout
  - [x] Ensure `release()` pops and wakes active waiters without accumulating stale callbacks
  - [x] Add regression tests in `tests/concurrencyLimiterSafeOwnership.test.ts` asserting bounded waiter queue length under contention and no lost wakeups
- [x] P1/P2 (DEEP-07): No-progress helper completeness (wire `isRepetitiveNarration`)
  - [x] Wire `isRepetitiveNarration` into `src/core/agent/LoopIterationProcessor.ts`
  - [x] Suppress planning nudge and break checklist continuation on repetitive text narration
  - [x] Add regression tests in `tests/checklistContinuationGuard.test.ts`
- [x] Verification, full test suite run with Bun, and documentation
  - [x] Run `bun run build`
  - [x] Run 90 focused tests + new regression tests
  - [x] Verify direct adversarial probe
  - [x] Update `walkthrough.md`
  - [x] Git commit and push only modified files


---

## Milestone M1 — Reliable Parallel Capacity

- [x] **M1.1** Inspect occupied slots using process birth identity
  - [x] Query capacity directory `superagent-cli-bridge-capacity-v1`
  - [x] Correlate slot leases with OS process identity (Win32_Process CreationDate ticks)
  - [x] Determine ownership and liveness of active processes and child CLIs
- [x] **M1.2** Implement fail-closed stale-slot classifier
  - [x] Define `CapacitySlotState` (6 states: `active_verified`, `owner_alive_child_alive`, `owner_dead_child_alive_review_required`, `owner_dead_child_dead_recoverable`, `identity_mismatch_blocked`, `corrupt_blocked`)
  - [x] Implement `classifyCapacitySlot` in `src/core/tools/cliBridgeRecovery.ts`
  - [x] Ensure fail-closed evaluation on PID reuse, unknown PID, or corrupt metadata
- [x] **M1.3** Implement safe orphan-slot recovery
  - [x] Extend slot metadata with `ownerProcessIdentity`, `childPid`, `childProcessIdentity`, `heartbeatAt` in `src/core/tools/cliBridgeCapacity.ts`
  - [x] Implement `inspectCapacitySlot`, `listDetailedCapacitySlots`, and `recoverProvenOrphanSlot`
  - [x] Add `delegate.slots` and `delegate.recover-slot` actions in `src/core/tools/cliBridgeTool.ts`
  - [x] Add optional automatic recovery in `acquireCliBridgeCapacity` strictly for proven orphans
- [x] **M1.4** Add regression tests in `tests/cliBridgeCapacityRecovery.test.ts`
  - [x] Test PID reuse detection (returns `identity_mismatch_blocked`, blocks recovery)
  - [x] Test live owner protection (returns `owner_alive_child_alive`/`active_verified`, blocks theft/recovery)
  - [x] Test orphan recovery (returns `owner_dead_child_dead_recoverable`, successfully recovers slot)
  - [x] Test dead owner with surviving child (returns `owner_dead_child_alive_review_required`, protects child)
  - [x] Test terminal-job stale lease cleanup (recovers lingering lease when owner and child are dead)
  - [x] Test corrupt/malformed metadata fail-closed behavior
  - [x] Test `delegate.slots` and `delegate.recover-slot` tool actions
- [x] **M1.5** Recover only slots proven orphaned on host
  - [x] Audit live host slots (Slots 0 and 1 active_verified, Slots 2 and 3 available)
  - [x] Protect live owners and children; confirm zero active processes killed or stolen
- [x] **M1.6** Run 4 simultaneous read-only probes
  - [x] Concurrently dispatch 4 real AGY background jobs (`--mode plan`)
  - [x] Verify distinct capacity slots 0, 1, 2, 3 and distinct PIDs (44176, 42932, 5368, 43288)
  - [x] Verify concurrent `active_verified` state, exit code 0, and clean lease release
- [/] **M1.7** Prove four real AGY CLI Bridge coding delegates run in four isolated Git worktrees
  - [x] Worktree primitive: four distinct worktrees/branches can be created concurrently from pinned SHA `0c5cea2cc4f18b1838157b02a05f782461e783f9`
  - [x] Direct test-process edits/commits remain isolated from the main checkout
  - [/] Dispatch four actual AGY jobs into those worktrees and record job/branch/commit provenance
- [x] **M1.8** Verification, build, and documentation
  - [x] Independent M1 audit: 114 passed, 0 failed across 8 CLI Bridge suites (502 assertions)
  - [x] Run `bun run build` (clean TypeScript compilation, 0 errors)
  - [x] Re-prove 4 real AGY workers concurrently on capacity slots; all four slots released cleanly
  - [x] Update master plan and walkthrough with independent audit evidence

---

## Milestone M2 — Adaptive Scheduler & Dynamic 2–8 Capacity

- [x] **M2.1** Resource sampler primitive exists and is unit-tested
- [/] **M2.2** Wire adaptive 2–8 capacity into `startDelegateJob()`
  - [x] Pure calculation supports min/max/configured slots and hysteresis
  - [/] Real delegate admission currently still uses fixed `maxConcurrentJobs()`
  - [/] Real capacity acquisition currently does not use CPU/RAM pressure
- [/] **M2.3** Wire admission quotas and fair priority queue into the actual runtime
  - [x] Pure scheduler functions implement quota/priority/fairness calculations
  - [/] No scheduler/queue import exists in `cliBridgeDelegateJobs.ts`
  - [/] Public CLI Bridge schema does not expose priority/resource class

---

## Milestone M3 — Worktree Isolation, Resource Claims & Completion Contracts

- [/] **M3.1** Integrate worktree manager and safe host-wide resource claims into real delegates
  - [x] Worktree lifecycle primitive exists and passes direct Git tests
  - [/] Worktree manager is not invoked by `delegate.start`
  - [/] Generalized resource claims are not atomic: independent 40-iteration concurrent writer stress probe produced **40 double-writer wins**
  - [/] Add atomic read/write claim protocol and simultaneous-writer regression test
- [/] **M3.2** Wire verified completion contracts into real delegates
  - [x] `AcceptanceContract` verifier primitive works when called directly
  - [/] `cliBridgeAcceptance.ts` is not referenced by the delegation runtime
  - [/] Public MCP/CLI Bridge schema does not expose the acceptance contract
  - [/] Real completion state still uses legacy `expectedArtifacts` path

---

## Milestone M4 — Agent Profiles & Durable DAG Orchestration

- [/] **M4.1** Wire role profiles into actual delegate/orchestration dispatch
  - [x] Built-in/custom profile registry primitive exists
  - [/] Profiles are not consumed by `delegate.start`
- [/] **M4.2** Implement durable executable DAG orchestration
  - [x] Graph validation and state-transition helpers exist
  - [/] DAG engine never calls `startDelegateJob()`
  - [/] Active DAGs are held in an in-memory `Map`; restart loses them
  - [/] `POST /api/orchestration/dag` only creates/registers a graph and does not execute it
- [/] **M4.3** Implement real reviewer/consensus/speculative execution
  - [x] Pure verdict/candidate evaluation helpers exist
  - [/] No reviewer agents are dispatched
  - [/] No deterministic verification + loser cancellation pipeline is wired

---

## Milestone M5 — Crash Reconciliation, Isolation & Adapter Contracts

- [/] **M5.1** Wire crash reconciliation/checkpoints into CLI Bridge initialization
  - [x] Checkpoint/reconciliation helper primitive exists
  - [/] `cliBridgeReconciliation.ts` is referenced only by tests, not runtime initialization
- [/] **M5.2** Harden and wire provider-neutral adapters
  - [x] Adapter interface and AGY filtering primitive exist
  - [/] Claude and Codex adapters currently inherit full `process.env`
  - [/] Unknown aliases silently fall back to AGY instead of failing closed
  - [/] New adapters are not used by the existing delegate execution path

---

## Milestone M6 — T-Line Live Orchestration Dashboard & Production Certification

- [/] **M6.1** Build the actual T-Line live orchestration dashboard
  - [x] SuperAgent status/metrics/DAG HTTP feed primitives compile
  - [/] T-Line frontend/backend has no references to the orchestration endpoints
  - [/] No dashboard UI renders slots, queue, DAG nodes, verifier state, or controls
  - [/] Host-wide feed currently exposes slot job IDs/PIDs and global DAGs without workspace filtering
- [/] **M6.2** Production certification
  - [x] Modular regression matrix independently reproduced: **152 passed, 0 failed, 696 assertions**
  - [x] `bun run build` passes
  - [ ] Live adaptive-pressure/backpressure E2E not proven
  - [ ] Crash/restart integration E2E not proven
  - [ ] Four-AGY isolated-worktree E2E not proven
  - [ ] Executable durable DAG E2E not proven
  - [ ] T-Line dashboard E2E not proven
