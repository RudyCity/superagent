# SuperAgent Runtime Supervisor — Integration Pre-Merge Audit

Date: 2026-10-28
Status: **BLOCKED / NOT YET READY FOR MAIN**
Integration worktree: `D:\backup from pc asus\Documents Development\superagent-runtime-integration-20261028`
Integration branch: `agent/runtime-supervisor-integration-20261028`
Base `main` examined: `5259ba6656c9d0b54ee98cb0cf10f94eab9dfc85`
Feature: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028` at `70af5b46` (Batch 2–4).

## Integration steps and safety
- Created a brand-new **external** Git worktree from the then-current main. Original main worktree was dirty (more than 50 unrelated entries, predominantly scratch files); it was NEVER reset, restored, cleaned, checked out, staged or merged.
- Performed `git merge --no-ff --no-commit agent/runtime-supervisor-m1-coverage-m2-reaper-20261028` in the isolated integration worktree.
- Git auto-merged `src/core/tools/cliBridgeSession.ts` cleanly, with **zero unmerged files, zero textual conflicts**. `git diff --cached --check` PASS.
- Existing source feature branch remained intact; auto-reaping remains disabled; no push and no main update.
- Integration worktree initially lacked dependencies. Established a local junction to the already-installed `node_modules` in the feature worktree; did not install any packages or change lockfile.
- After dependencies were accessible, `bun run build` PASS (TypeScript and MCP schemas).

## Independent integration tests and confirmed gating problems

### Gate A — Default timeout is exceeded by two new runtime/session interactions
Command: `bun test` with 19 combined supervisor, CLI Bridge, Core, MCP-memory and journal suite files, default 5000ms timeout.
Outcome: **164 passed, 2 failed** (166 total). Failures:
- `tests/cliBridgeSessionLifecycle.test.ts`: 50 rapid completed session cycles timed out after 5000ms.
- `tests/mcpMemoryLifecycle.test.ts`: 50 rapid completed session lifecycles timed out after 5000ms.
Reproduced running each test file separately on integrated branch: the same 5000ms timeout failures.

Under `bun test --timeout 30000`, both files pass, but individual cycle tests need approximately **6486ms** and **6228ms**. These are not functional assertion failures; they represent a material session-churn latency regression under the existing timeout gate.
Independent `main` baseline at `5259ba66` with default timeout passes both, with cycle-test durations about **2399ms** and **2362ms**.

A short-lived performance probe removed the registry lock-file `sync()` call only in the integration worktree. The tests still timed out under 5000ms. **This experimental modification was reverted exactly back to the staged merge version**. Do not weaken crash safety to pass a timing test.

### Gate B — Intermittent multi-process concurrent registry writer failure under full-suite load
Command: same 19-suite run but with `--timeout 15000`.
Outcome: **165 passed, 1 failed** (166 total).
Failed: `tests/processSupervisorBatch4Remediation.test.ts` P0-3 'runs 2 separate OS child processes saving concurrently with zero lost updates'. At `tests/processSupervisorBatch4Remediation.test.ts:346-348`, one worker child exited with code **1** instead of **0**.
In that test, child stdout/stderr are `stdio: "ignore"`, so there was no diagnostic to distinguish lock contention, Windows rename collisions, or worker import/runtime failure. Importantly, test body in isolation passed in prior Batch 4 report; failure here requires reproduction under realistic combined-suite load and explicit captured child stderr. **Do not call P0-3 certified.**

## Gate recommendations (hard release blockers)
1. Fix the session creation/ownership registration latency while preserving durable process ownership, audit trail, workspace isolation and process start/exit safety. Keep the existing 5-second churn tests as the normal release gate (do not merely relax timeouts to mask a regression). Benchmark on the same host, sequential and combined.
2. Enhance P0-3 two-worker test to capture stderr and explicit exit status; reproduce under repeated concurrent loops and loaded environment. Resolve any registry lock or Windows atomic replacement race, and add deterministic failure reproduction tests.
3. Execute 19-suite combined test with default timeouts three consecutive passes; run additional CDP, MCP and session tests impacted by main's two new commits; `bun run build`, `git diff --check`, no leaked child process verification.
4. Before considering merge, refresh `main` HEAD and dirty worktree changes. Integrate separately if main advanced. Never force or overwrite parallel work.
5. Real Windows host crash/restart soak is still not a proven full production gate.

## Safe current conclusion
The merge is **textually clean and buildable**, but **NOT TEST-CERTIFIED**. Keep the integration changes in the isolated branch only; do NOT merge or push to main yet.
