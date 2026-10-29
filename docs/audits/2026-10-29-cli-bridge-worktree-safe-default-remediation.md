# CLI Bridge worktree default and safe cleanup remediation

Date: 2026-10-29
Workspace: SuperAgent
Target branch: main

## Root cause

`startDelegateJob()` previously converted a `coder` or `tester` role's `worktreePolicy: "isolated"` into `opts.worktree = true` for every direct delegation, even when the caller never requested an isolated checkout.

The low-level `removeIsolatedWorktree()` helper also defaulted to `git worktree remove --force` and attempted filesystem recursive deletion if Git removal did not remove the directory.

## Remediation

1. Direct CLI Bridge `delegate.start` requires `worktree: true` to create a worktree. Role instructions/resource classes remain unchanged. An explicit `worktree: false` also remains in-place.
2. DAG nodes retain their isolated `coder` / `tester` role policy and speculative candidates still default to isolated execution.
3. Automatic cleanup is fail-closed: only a registered, non-main worktree that is free of staged, unstaged, untracked and ignored scratch files, and whose HEAD is reachable from `refs/heads/main`, may be removed automatically.
4. Default Git worktree removal is now non-forced. A failed Git removal never triggers recursive filesystem deletion. Branch deletion uses `git branch -d` unless force was explicitly requested.
5. A skipped or failed automatic cleanup records `worktreeCleanupWarning`, displayed via `delegate.get`.

## Verification

- `bun --bun x vitest run tests/cliBridgeDelegateJobs.test.ts tests/cliBridgeTool.test.ts tests/cliBridgeWorktreePolicy.test.ts tests/cliBridgeWorktreeIsolation.test.ts tests/cliBridgeDag.test.ts` — **86 tests passed, 5 files passed**.
- `bun run build` — passed (Bun 1.4.2, TypeScript, MCP schema synchronization).
- `git diff --check` — passed.
- The new regression executes an actual `startDelegateJob` with `roleProfile: "coder"` and confirms that the working directory stays in the main checkout without a worktree.
- A temporary Git repository regression proves that ignored files, untracked changes, dirty files, and unmerged commits block automatic cleanup, and a merged clean branch can be safely removed.

## Scope / operational notes

This fixes CLI Bridge delegation behavior, not every independent SuperAgent or Master Agent worktree orchestration entry point. Direct concurrent write delegations targeting the same checkout should still opt into `worktree: true`, or use DAG orchestration, to avoid write collisions. No existing worktree was automatically deleted. The running MCP process may need a controlled restart to load the rebuilt code; do not restart unrelated tunnels or child processes.
