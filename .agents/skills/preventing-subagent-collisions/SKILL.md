---
name: Preventing Subagent Collisions
description: Prevent task duplication, file conflicts, and coordination failures when multiple subagents work in parallel on the same Superagent project. Covers both Superagent→Subagent coordination and Master Agent→Superagent worktree coordination. Uses manage_plan and manage_tasks as the coordination hub.
when_to_use: when spawning multiple subagents in parallel in the same project, when subagents might claim the same task or edit overlapping files, when coordinating parallel work using invoke_subagent or invoke_superagent, when multiple Superagents run in isolated git worktrees, when task.md needs to be shared across agents
version: 4.0.0
languages: [typescript, shell]
---

# Preventing Subagent Collisions

## Overview

Two separate collision scenarios exist in the 3-tier architecture. Both must be handled:

| Scenario | Tier | Risk |
|----------|------|------|
| **A — Subagent collision** | Superagent → Subagents | Two subagents claim same task or edit same file within one worktree |
| **B — Worktree collision** | Master Agent → Superagents | Two Superagents in different worktrees both edit shared files (package.json, CHANGELOG.md, AGENTS.md), causing merge conflicts |

**Core principle (both scenarios):** The parent pre-assigns tasks AND file scopes before spawning. Shared files are never touched in parallel — always serialized.

---

## Scenario A — Subagent Collision (Superagent tier)

### The Coordination Model

| File | Purpose | Owner |
|------|---------|-------|
| `_implementation_plan.md` | All tasks, file scopes, agent assignments | Parent (via `manage_plan`) |
| `_task.md` | Active task checklist — status per task | Parent updates; subagents read only |
| `_task_history.md` | Archive of completed tasks | Automatic |

Subagents do NOT call `manage_plan` or modify `_task.md`. They receive a pre-assigned task in their prompt and report back when done. Parent updates status via `manage_tasks`.

### Plan Template with Agent Assignments

```markdown
# Feature X Implementation Plan

## Proposed Changes

- [ ] [agent: researcher] Research existing auth patterns — src/auth/**
- [ ] [agent: coder-a] Implement JWT middleware — src/auth/jwt.ts, src/auth/middleware.ts
- [ ] [agent: coder-b] Implement billing service — src/billing/**, tests/unit/billing/**
- [ ] [agent: reviewer] Review and test all changes — tests/**, docs/**

## Shared Files (Read-Only for Parallel Agents)
- src/types/index.ts
- src/config/constants.ts
- package.json

If an agent needs to modify a shared file: STOP and report to parent.

## Verification Plan
### Automated Tests
`bun test`
### Manual Verification
Verify no conflicts in git log.
```

### Spawn with fileScope

Use `fileScope` parameter — auto-injects `## FILE SCOPE (Enforced)` into subagent system prompt structurally:

```
invoke_subagent(typeName: "coder", role: "coder-a", prompt: "...",
  fileScope: ["src/billing/**", "tests/unit/billing/**"])
invoke_subagent(typeName: "coder", role: "coder-b", prompt: "...",
  fileScope: ["src/auth/**", "tests/unit/auth/**"])
```

> `fileScope` is strongly preferred over prose — it cannot be forgotten by the parent.

Monitor and update status:
```
manage_subagents(action: "list")
manage_subagents(action: "report", conversationIds: [...])
manage_tasks(action: "update", index: 2, status: "/")   // spawned
manage_tasks(action: "update", index: 2, status: "x")   // done
```

---

## Scenario B — Worktree Collision (Master Agent tier)

This is the most common source of silent merge conflicts. Multiple Superagents in isolated git worktrees each try to modify shared repo-level files — the worktree itself is clean, but merge fails.

### Files That Must NEVER Be Modified Inside a Worktree

These files are shared across all worktrees and must only be written by the Master Agent AFTER all branches are merged:

| File | Why |
|------|-----|
| `package.json` | Version bump → merge conflict if two worktrees both bump |
| `CHANGELOG.md` | Both agents prepend an entry → conflict at top of file |
| `AGENTS.md` | Shared project rules → concurrent edits collide |
| `README.md` | Same section updated by two agents → conflict |
| `.env.example` | Config templates → format conflicts |
| Any root-level config | Single source of truth — serialize writes |

### Superagent Worktree Constraint

A Superagent inside a worktree MUST:

- ✅ Implement its feature (code files, tests, docs for that feature)
- ✅ Include in final report: what changed + what version/changelog entry SHOULD say
- ❌ NOT bump `package.json` version
- ❌ NOT write to `CHANGELOG.md`
- ❌ NOT modify `AGENTS.md` or `README.md`
- ❌ NOT run `git push` or `git tag`

If a Superagent discovers it must modify one of these files: **STOP. Report to Master Agent with the proposed change.** Master Agent serializes it after merge.

### Master Agent Post-Merge Sequence (Strictly Sequential)

After `merge_superagents` completes for all branches:

```
1. Collect changelog entries from all Superagent reports
2. bun run build   → verify clean build on merged main
3. bun test        → verify all tests pass
4. Bump version in package.json (ONE time, after all merges)
5. Prepend all changelog entries to CHANGELOG.md (ONE write)
6. Update AGENTS.md if needed (ONE write)
7. Commit: "chore: release vX.X.X"
8. git_worktree prune — clean up merged worktrees
```

Never interleave these steps with remaining merges. One branch at a time, then post-work once.

### Master Agent Plan Annotation for Worktrees

```markdown
## Proposed Changes

- [ ] [agent: auth-superagent, branch: feat/auth] Implement JWT auth — src/auth/**
- [ ] [agent: billing-superagent, branch: feat/billing] Implement billing — src/billing/**

## Worktree Shared Files (Post-Merge Only — Master Agent Handles)
These files must NOT be modified by any Superagent worktree:
- package.json (version bump)
- CHANGELOG.md (entry to be collected from agent reports)
- AGENTS.md

## Verification Plan
### Automated Tests
`bun test`
### Manual Verification
Run `bun run build` on merged main. Verify no conflicts.
```

---

## Serialization Gates

| Operation | When | Who |
|-----------|------|-----|
| `bun install` / deps install | BEFORE spawning | Parent once |
| DB schema migrations | BEFORE spawning | Parent once |
| `git pull --rebase` | BEFORE spawning | Parent once |
| `merge_superagents` / git merge | AFTER all done | Master Agent |
| `package.json` version bump | AFTER all merges | Master Agent only |
| `CHANGELOG.md` update | AFTER all merges | Master Agent only |
| `AGENTS.md` / `README.md` edits | AFTER all merges | Master Agent only |
| Deploy / publish | AFTER version commit | Master Agent |

---

## Task Status in `_task.md`

| Status | Meaning | Who Sets It |
|--------|---------|-------------|
| `[ ]` | Pending | Parent at plan creation |
| `[/]` | In-progress | Parent when agent spawned |
| `[x]` | Completed | Parent when agent reports done |

---

## Quick Reference

```
Problem                              Solution
──────────────────────────────────────────────────────────────────
Two subagents pick same task       → Pre-assign in plan + prompt before spawning
Subagent edits wrong file          → Use fileScope param in invoke_subagent
Shared file conflict (subagent)    → Declare read-only in plan; agent stops + reports
Worktree merge conflict            → Never touch package.json/CHANGELOG in worktrees
Parent loses track of progress     → manage_subagents(action: "list") + manage_tasks list
Superagent bumped version          → Revert in worktree; Master Agent does it post-merge
npm install conflicts              → Run BEFORE spawning
```

---

## Common Mistakes

**❌ Superagent bumps package.json version inside worktree**
Two Superagents both bump version → merge conflict in package.json every time.
Fix: Superagents report what the version change SHOULD be. Master Agent does ONE bump post-merge.

**❌ Superagent writes to CHANGELOG.md inside worktree**
Two agents both prepend an entry → conflict at top of file.
Fix: Superagent includes changelog entry text in its final report. Master Agent collects and writes once.

**❌ Letting subagents self-assign from _task.md**
Two agents read the same `[ ]` task and both start working on it.
Fix: Assign tasks explicitly in prompt. Agents never self-assign.

**❌ Subagents calling manage_tasks or manage_plan**
Concurrent writes to `_task.md` corrupt the file.
Fix: Only parent calls `manage_plan` and `manage_tasks`.

**❌ Spawning agents sequentially with wait: true**
Loses all parallelism benefit.
Fix: Issue all `invoke_subagent` calls in one turn (`wait: false`), then monitor with `manage_subagents`.

**❌ Merging branches mid-run**
Mid-run merge introduces commits parallel agents didn't see → conflicts.
Fix: Merge only after ALL agents finish.

**❌ Not using fileScope param**
Parent forgets to include scope in prose → subagent touches wrong files.
Fix: Always pass `fileScope: [...]` to `invoke_subagent`. It is auto-injected structurally.

---

## Integration

**Pairs with:**
- `master-agent-orchestration` — orchestration workflow for Master Agent tier
- `superagent-planning` — use `manage_plan` to create assignment-annotated plans
- `using-git-worktrees` — worktree lifecycle management
- `dispatching-parallel-agents` — when to dispatch; use THIS skill for coordination
- `finishing-a-development-branch` — Phase 3 cleanup and merge
