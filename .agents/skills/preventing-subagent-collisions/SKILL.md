---
name: Preventing Subagent Collisions
description: Prevent task duplication, file conflicts, and coordination failures when multiple subagents work in parallel on the same Superagent project. Uses the existing manage_plan and manage_tasks system as a shared coordination hub.
when_to_use: when spawning multiple subagents in parallel in the same project, when subagents might claim the same task or edit overlapping files, when coordinating parallel work using invoke_subagent or invoke_superagent, when task.md needs to be shared across agents
version: 3.0.0
languages: [typescript, shell]
---

# Preventing Subagent Collisions

## Overview

Superagent's `manage_plan` and `manage_tasks` tools already provide a shared task system via `_task.md`. The problem: when multiple subagents run in parallel and both read `[ ]` tasks, they claim the same task simultaneously.

**Core principle:** The parent agent pre-assigns tasks to specific subagents BEFORE spawning. Each subagent owns a named slice — never picks tasks on its own. No claiming race. No collision.

---

## The Coordination Model

Superagent's existing files serve as the coordination layer:

| File | Purpose | Owner |
|------|---------|-------|
| `_implementation_plan.md` | Single source of truth: all tasks, file scopes, agent assignments | Parent (via `manage_plan`) |
| `_task.md` | Active task checklist — status per task | Parent updates; subagents read |
| `_task_history.md` | Archive of completed tasks | Automatic |

Subagents do NOT use `manage_plan` or modify `_task.md` directly. They receive a pre-assigned task in their prompt and report back when done. The parent updates `_task.md` status via `manage_tasks`.

---

## Pre-Spawn: Parent Assigns Tasks in the Plan

Before calling `invoke_subagent` or `invoke_superagent`, the parent must build the plan with **explicit agent assignments** in each task:

```markdown
# Feature X Implementation Plan

## Proposed Changes

- [ ] [agent: researcher] Research existing auth patterns in codebase — src/auth/**
- [ ] [agent: coder-a] Implement JWT middleware — src/auth/jwt.ts, src/auth/middleware.ts
- [ ] [agent: coder-b] Implement billing service — src/billing/**, tests/unit/billing/**
- [ ] [agent: reviewer] Review and test all changes — tests/**, docs/**

## Shared Files (Read-Only for Agents)
The following files can only be READ — not written — by parallel agents:
- src/types/index.ts
- src/config/constants.ts
- package.json

If an agent needs to modify a shared file, it must STOP and report to the parent.

## Verification Plan

### Automated Tests
`npm test`

### Manual Verification
Verify all tasks complete with no conflicts in git log.
```

Create this via `manage_plan`:
```json
{ "action": "create", "planContent": "..." }
```

---

## Agent Prompt Template

Every subagent prompt MUST include:

```
You are the [role] agent for this session.

## Your Assigned Task
[Exact task description from the plan]

## Your File Scope
You may ONLY read and write these files:
- [file list from plan]

## Shared Files (Read-Only)
These files exist but you must NOT modify them:
- src/types/index.ts
- package.json
If you need to change one, STOP and report to the parent.

## When You Are Done
Report back with:
1. Summary of changes made
2. Files touched
3. Test results
4. Any blocked items

Do NOT call manage_plan or manage_tasks — the parent handles task status updates.
```

---

## Parent Workflow: Before → Spawn → After

### Phase 1 — Sequential Pre-Work (Before Spawning)
Run these ONCE before spawning any agents:

```bash
# Install dependencies once
npm install

# Run pending DB migrations
npm run migrate

# Pull latest changes
git pull --rebase origin main
```

Then create the plan with pre-assigned tasks via `manage_plan`.

### Phase 2 — Parallel Spawn
Issue all `invoke_subagent` calls in one turn (parallel, not sequential).

Use `fileScope` parameter to enforce file boundaries structurally — the tool
auto-injects a `## FILE SCOPE (Enforced)` block into the subagent's system prompt:

```
invoke_subagent(typeName: "researcher", role: "researcher", prompt: "...researcher task...",
  fileScope: ["src/**", "tests/**"])
invoke_subagent(typeName: "coder", role: "coder-a", prompt: "...billing task...",
  fileScope: ["src/billing/**", "tests/unit/billing/**"])
invoke_subagent(typeName: "coder", role: "coder-b", prompt: "...auth task...",
  fileScope: ["src/auth/**", "tests/unit/auth/**"])
```

> If `fileScope` is omitted, the parent MUST include file scope explicitly in the `prompt` prose.
> Using `fileScope` is strongly preferred — it cannot be forgotten.

Monitor with:
```
manage_subagents(action: "list")
manage_subagents(action: "report", conversationIds: [...])
```

Update task status as each agent reports in:
```json
{ "action": "update", "index": 2, "status": "/" }   // in-progress
{ "action": "update", "index": 2, "status": "x" }   // done
```

### Phase 3 — Sequential Post-Work (After All Agents Done)
Run these ONCE after all agents have finished:

- Merge branches (if using worktrees)
- Bump version in `package.json`
- Update `CHANGELOG.md`
- Run full test suite: `npm test`
- Deploy or publish

---

## Task Status in `_task.md`

Superagent's `manage_tasks` uses three statuses — use them consistently:

| Status | Meaning | Who Sets It |
|--------|---------|------------|
| `[ ]` space | Pending / not started | Parent at plan creation |
| `[/]` slash | In-progress | Parent when agent is spawned for this task |
| `[x]` x | Completed | Parent when agent reports done |

The parent (not the subagent) always controls `_task.md`. This prevents race conditions from concurrent writes.

---

## Shared Files Protocol

Files declared read-only in the plan must NEVER be modified by a parallel agent. If an agent encounters a situation where it must modify a shared file:

1. Agent stops and reports: `"Blocked: need to modify src/types/index.ts (shared file). Awaiting parent instruction."`
2. Parent decides:
   - Serialize the change (do it before or after parallel phase), or
   - Assign it to one specific agent and update the plan

Never silently edit a shared file. That is how the collision happens.

---

## Serialization Gates

| Operation | Phase | Why |
|-----------|-------|-----|
| `npm install` / `pnpm install` | BEFORE spawning | Concurrent writes break node_modules |
| DB schema migrations | BEFORE spawning | Sequential ordering required |
| `git pull` / `git fetch` | BEFORE spawning | Avoid index conflicts |
| `merge_superagents` / git merge | AFTER all done | No mid-run merges |
| `package.json` version bump | AFTER merge | One writer at a time |
| `CHANGELOG.md` update | AFTER merge | Concurrent writes cause conflicts |
| Deploy / publish | AFTER merge | Non-idempotent operation |

---

## Quick Reference

```
Problem                          Solution
─────────────────────────────────────────────────────────────
Two agents pick same task      → Parent pre-assigns tasks in plan before spawning
Agent edits wrong file         → File scope declared per task in plan
Shared file conflict           → Declared read-only in plan; agent reports if blocked
Parent loses track of progress → manage_subagents(action: "list") + manage_tasks(action: "list")
Agent finishes — what now?     → Agent reports back; parent calls manage_tasks update + x
npm install conflicts          → Run BEFORE spawning, not inside each agent
```

---

## Common Mistakes

**❌ Letting subagents pick their own tasks from task.md**
Two agents read the same `[ ]` task and both start working on it.
Fix: Assign tasks explicitly in the agent prompt. Agents never self-assign.

**❌ Subagents calling manage_tasks or manage_plan**
Concurrent writes to `_task.md` corrupt the file.
Fix: Only the parent agent calls `manage_plan` and `manage_tasks`. Subagents only read and report.

**❌ Spawning agents sequentially with wait: true**
Loses all parallelism benefit. Each agent waits for the previous one.
Fix: Issue all `invoke_subagent` calls with `wait: false` in one turn. Then call `manage_subagents` to monitor.

**❌ Running npm install inside each subagent**
Concurrent writes corrupt `node_modules` and `package-lock.json`.
Fix: Run install once in Phase 1 before any spawning.

**❌ Merging branches mid-run**
A mid-run merge introduces commits agents didn't see, causing conflicts.
Fix: Merge only after all agents finish (Phase 3).

**❌ Not marking tasks in-progress when spawning**
Parent cannot tell which tasks are assigned vs still available.
Fix: Set status to `[/]` via `manage_tasks` immediately when spawning an agent for that task.

---

## Integration

**Pairs with:**
- `master-agent-orchestration` — this skill covers the coordination detail for Phase 2 parallel work
- `superagent-planning` — use manage_plan to create the assignment-annotated plan
- `using-git-worktrees` — each agent's branch; combine with this skill for file-level safety
- `dispatching-parallel-agents` — use when to dispatch; use THIS skill to coordinate once dispatched
- `finishing-a-development-branch` — Phase 3 cleanup and merge
