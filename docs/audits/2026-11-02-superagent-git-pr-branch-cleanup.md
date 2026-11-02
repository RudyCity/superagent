# SuperAgent Git PR and Branch Hygiene Audit — 2026-11-02

## Workspace and safety constraints

- Repository: `RudyCity/superagent`, current branch `main`.
- No new persistent worktree created as part of branch cleanup. Existing unrelated untracked `artifacts/` was preserved untouched.
- No PR was merged, no unrelated commit was reset, and two independent remote branches remain untouched.

## Pull requests

| PR | Result | Reason |
|---|---|---|
| [#1](https://github.com/RudyCity/superagent/pull/1) | Already closed, unmerged | Earlier superseded feature review |
| [#2](https://github.com/RudyCity/superagent/pull/2) | Closed on 2026-11-02, unmerged | Browser takeover M1–M3 already on main with later hardening, including `9ec1de69` |

GitHub search returned **zero open PRs** following closure.

## Branch cleanup

- Deleted 12 local `cli-bridge/live-worker-*` branches dated 2026-10-31 after verifying that each carried only one synthetic `provenance_[1-4].txt` commit.
- Removed both stale remote branches:
  - `feature/linux-cdp-headless-m0-m1-20261028`
  - `feature/linux-cdp-m1-m3-only-20261029`
- During full regression, an existing live E2E suite unexpectedly recreated four `cli-bridge/live-worker-*` branches; these were also checked, archived and deleted.
- All 18 cleaned branch-tip SHA references are preserved locally under `refs/archive/2026-11-02-pre-cleanup/` (16 local worker refs plus two former remote feature refs).
- After cleanup, `git branch -a` lists one local branch (`main`) and three remote tracking branches: `origin/main`, `origin/python-mcp-client`, `origin/runtime/reboot-safe-certification-20261027`.

Two remote branches were intentionally preserved:
1. `python-mcp-client`: an independent orphan Git history containing a standalone Python MCP client package.
2. `runtime/reboot-safe-certification-20261027`: seven independent Windows startup/cold-reboot certification commits. Do not delete without feature reconciliation.

## Root cause and regression protection

The default full Vitest run loaded `tests/cliBridgeLiveMultiAgentE2E.test.ts`, which launched real AGY worktree jobs rooted in `process.cwd()`, creating branch names `cli-bridge/live-worker-*`. Its `afterEach` cleanup supplied `deleteBranch: true` **without the branch name**, allowing the worktree to be removed while leaving the Git branch.

Changes:
- `cliBridgeLiveMultiAgentE2E.test.ts`: gate the live AGY/worktree suite on explicit `SUPERAGENT_ALLOW_WORKTREE_TESTS=1` and pass the exact generated branch name to teardown.
- `cliBridgeWorktreeIsolation.test.ts`: apply the same opt-in guard, because its tests create worktrees in the developer's active Git checkout.
- Other tests that create worktrees only in temporary isolated test repositories were not disabled.

Verification:
- `bun run build` — PASS.
- `bun --bun x vitest run tests/cliBridgeLiveMultiAgentE2E.test.ts tests/cliBridgeWorktreeIsolation.test.ts tests/cliBridgeWorktreePolicy.test.ts tests/browserTakeoverTargetLease.test.ts --maxWorkers=2` — **6 passed, 10 intentionally skipped**. No new project branch was created.
- Branch count/worktree status verified with `git branch -a`, `git worktree list --porcelain` and `git status -sb`.

## Next release gates

The original full regression run was stopped after revealing the unsafe worktree-creation side effect. Its partial log must **not** be interpreted as a completed pass/fail matrix. Run remaining M4-A regression in non-mutating batches with live worktree E2E opt-in disabled. Continue M4-B crash/recovery and M4-C live Linux Chrome/Xvfb/noVNC certification afterwards.

**Release verdict: Git hygiene complete; production certification remains NO-GO.**
