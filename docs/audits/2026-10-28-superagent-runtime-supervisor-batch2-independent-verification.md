# SuperAgent Runtime Supervisor — Batch 2 Independent Verification Audit
Date: 2026-10-28

## Scope and provenance
- Base branch: `main`, HEAD `fcd8a358`.
- Implementation branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`.
- Isolated worktree located outside the main worktree to prevent nested worktrees.
- Baseline source of truth: `docs/plans/2026-10-28-superagent-cli-runtime-supervisor-and-verified-completion-v2-plan.md` and `docs/audits/2026-10-28-superagent-runtime-supervisor-post-batch1-remaining-gaps-audit.md`.
- AGY execution `clj_1793176508834_9a1041b2` ended `timed_out`. Its claims were NOT treated as verification evidence; code was manually reviewed and independently repaired/tested.
- This branch was not pushed or merged. The dirty main worktree and unrelated worktrees were left unchanged.

## Implemented in this batch

### M1 registration and lifecycle hardening (partial coverage)
- Explicit `ProcessLifecycle` and safer persisted legacy lifecycle handling (`unknown`, not auto-cleanup eligible).
- CLI Bridge one-shot delegate and persistent session tracking: register, PID/start observation, exit event.
- Managed persistent OpenAI and Cloudflare tunnel tracking (`keep_alive`), with Cloudflare early-exit event reconciliation and no false terminal on stop request.
- MCP exec-command and `/terminal bg` subprocess registration.
- Session cleanup policy is `lease_managed`; **scanner classification is read-only**, not a cleanup request.
- All new child launches preserve existing Windows headless spawn policy.

### M2 read-only ownership-aware orphan scanner
- New `src/core/process/processOrphanScanner.ts`.
- Candidate requires a scoped registry record, current SuperAgent runtime, verified live PID+creation identity, explicit verified terminal job/session owner, stale heartbeat past grace, cleanup-eligible policy, and a second identity/owner/lease check.
- Unknown, missing identity, PID reuse, historical runtime records, foreign workspaces, or persistent/external processes remain non-candidates.
- The scanner **does not terminate, signal, adopt, or attach** to processes.
- Historical AGY/Antigravity/cmd.exe sidecars are never automatically adopted or reaped.
- Owner status is not inferred from parent PID absence alone.

### Read-only diagnostics
- Added `/status processes` and `/doctor processes` on the established slash-command routing.
- Reports are restricted to the caller's exact workspace. No foreign PID, record, arguments, job, session or workspace counts are returned.
- Shows managed counts, classification, heartbeat age, safe action recommendation, component, and bounded entries.
- Unknown ownership remains explicitly unknown.

## Independent verification gates
- `bun test tests/processRegistryLegacySafety.test.ts tests/processOrphanScanner.test.ts tests/processStatusCommands.test.ts tests/processRegistry.test.ts tests/processSpawnPolicy.test.ts tests/windowsSubprocessSplashRegression.test.ts tests/cliBridgeTool.test.ts`
  - **103 passed; 0 failed; 466 assertions** (7 test files, verified independently after AGY timed out).
- `bun run build`: PASS.
- `git diff --check`: PASS (line-ending normalization warnings only).
- No Windows console-splash regression or leaked test descendants observed in covered test suite.

## Not certified / remaining gaps
- Full M1 coverage is **not certified**: Muse tunnel, remaining MCP provider/helper subprocesses, Git/worktree subprocess families, dynamic hook subprocesses, and background services must be inventoried and explicitly registered with proof of actual SuperAgent ownership.
- M3 automatic startup reconciliation of all persisted owner jobs/sessions and crash-ambiguous mutating outcomes is **not certified**. Existing registry load and read-only inspection are available; this batch does not automatically replay, retry, or mark unknown outcomes verified.
- Destructive owned-only auto-reap remains **disabled/not implemented**. No cleanup permission is granted from scan output.
- End-to-end real Windows tunnel startup/stop and orphan recovery stress tests across runtime restarts are still required in addition to the targeted suites.
- The main worktree was intentionally not merged due to extensive parallel uncommitted changes.
- Resource-aware scheduling enhancements are not in this batch; existing `cliBridgeResourceSampler` and `cliBridgeScheduler` are retained.

## Release gate
This batch is **verified for covered read-only scanner, regression tests, and current instrumentation only**. Global Supervisor M1–M3 hardening remains **PARTIALLY IMPLEMENTED / NOT YET CERTIFIED**.
