---
name: Master Agent Orchestration
description: Guide for the Master Agent to orchestrate, monitor, and merge tasks across the 3-tier multi-agent architecture
when_to_use: when operating as the Master Agent (depth 0), spawning feature-level Superagents, managing worktrees, or merging branches in multi-agent mode
version: 1.0.0
languages: [typescript, shell]
---

# Master Agent Orchestration

## Overview
The **Master Agent (depth 0)** acts as the central orchestrator and coordinator. It does not modify code directly. Instead, it creates isolated worktrees, delegates feature-level development tasks to **Superagents (depth 1)**, monitors their progress, and merges the results back into the main branch.

```
                  Master Agent (depth 0)
                 /          |         \
         Superagent      Superagent   Superagent (depth 1)
        /          \         |          /        \
   Subagent      Subagent Subagent  Subagent   Subagent (depth 2)
```

---

## The Orchestration Tools

| Tool Name | Purpose | Key Parameters | Typical Usage Pattern |
|:---|:---|:---|:---|
| `invoke_superagent` | Spawns a Superagent on a new git branch & isolated worktree. | `role`, `task`, `branch`, `wait` (optional) | `invoke_superagent({ role: "ui-dev", task: "Build login screen", branch: "feat/login", wait: false })` |
| `await_superagents` | Waits for all running Superagents to finish their tasks. | `timeoutSeconds` (optional) | `await_superagents({ timeoutSeconds: 600 })` |
| `merge_superagents` | Merges completed Superagent branches with conflict resolution. | `cleanupWorktrees` (optional) | `merge_superagents({ cleanupWorktrees: true })` |
| `manage_superagents` | Lists instances, views logs/reports, or terminates agents. | `action` (`list`/`logs`/`report`/`kill`/`kill_all`), `superagentIds` | `manage_superagents({ action: "list" })` |
| `git_worktree` | Manages git worktree configurations manually. | `action`, `branch`, `path` | `git_worktree({ action: "list" })` |

---

## Core Workflow

### 1. Planning and Delegation
* Split complex requests into independent, parallelizable feature tasks.
* Assign each feature task a descriptive **role**, a **task prompt**, and a unique **branch name** (e.g. `feat/database-logger`).
* Spawn them concurrently using `invoke_superagent` with `wait: false`.

### 2. Monitoring Progress
* Use `manage_superagents` with `action: "list"` to check the status of all spawned instances.
* If a Superagent is taking long or you suspect issues, fetch active output logs using `manage_superagents` with `action: "logs"` and the target ID.
* Use `await_superagents` to pause execution until all delegated tasks finish.

### 3. Merging and Cleanup
* Once `await_superagents` reports success, review the task reports.
* Run `merge_superagents` to merge all feature branches back into the main branch. The Master Agent automatically uses LLM-assisted conflict resolution if merge conflicts arise.
* By default, this will also clean up the `.worktrees/` directory for those branches.

---

## Planning & Task Management for Master Agent

As a Master Agent, you are restricted from directly modifying codebase files and must delegate all feature implementations. Therefore, your implementation plans and task checklists must focus strictly on orchestration.

### 📝 Plan & Task Checklist Requirements
* **Orchestration Focus**: Plans must specify the roles, git branch names, and feature tasks for each Superagent to be spawned (e.g. `feat/auth-ui`), rather than listing direct line-level edits to codebase files.
* **Format & Tooling**: Use the `manage_plan` tool with `action: "create"` to write your implementation plan and automatically synchronize checklist tasks to `task.md` / `_task.md`.
* **Validation Templates**: The plan must strictly match one of the three template structures (Full, Quick, or Refactor) defined in the `@superagent-planning` skill.

### ⚙️ Auto-Injection Safeguards
The `manage_plan` tool contains automatic safeguards for Master Agent plans:
1. **Delegation Note Injection**: If the plan lacks delegation/worktree references, the tool automatically appends a delegation note.
2. **Orchestration Tasks Injection**: If the task checklist in the plan lacks orchestration tasks, the tool automatically injects three mandatory tasks:
   - `Spawn Superagents for parallel task execution`
   - `Monitor Superagent progress and await completion`
   - `Merge Superagent branches into main codebase`

---

## Critical Architecture Rules & Constraints

### ⚠️ Preventing Circular Dependencies
* **Rule**: `toolsets.ts` and `prompts.ts` are imported by multiple tool files. Any tool file that needs to import from these files **MUST** use dynamic `import()` inside the `execute()` function body, never static top-level imports.
* **Example**:
  ```typescript
  // ❌ BAD: Top-level static import
  import { superagentToolset } from "./toolsets.js";

  // ✅ GOOD: Dynamic import inside execute
  async execute(args, cwd) {
    const { superagentToolset } = await import("./toolsets.js");
  }
  ```

### ⚙️ Windows PowerShell Separation
* **Rule**: When executing shell commands on Windows, statement separators must be `;` instead of `&&`. Always verify the platform first or default to compatible formats.

### 🛡️ Workspace Isolation
* **Rule**: Store global configs (`.env`), persistent logs (`superagent.log`), and session state inside the global home folder (`~/.superagent-r/`) rather than the target repository directory.

---

## Common Mistakes

### ❌ Spawning Superagents in Series (Blocking)
* **Mistake**: Setting `wait: true` or invoking one Superagent and immediately calling `await_superagents` before invoking the next.
* **Fix**: Fire all `invoke_superagent` calls with `wait: false` first, and then call `await_superagents` once.

### ❌ Direct File Modification by Master Agent
* **Mistake**: Master Agent using write/edit tools directly on source files in the main branch.
* **Fix**: Master Agent should only use read tools to analyze or inspect results. All code generation and bug fixes must happen inside a delegated Superagent or Subagent.
