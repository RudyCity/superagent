---
name: Superagent MCP Instance Tracking
description: Guide for inspecting, reading, and managing Superagent instances, feature worktrees, current tasks, plan files, and execution logs via Model Context Protocol (MCP).
when_to_use: when interacting with Superagent via MCP tools or resources to inspect running instances, read task checklists, check implementation plans, view live logs, or manage worktrees.
version: 1.0.0
---

# Superagent MCP Instance Tracking

## Overview

Superagent provides a complete 3-pillar (Tools, Resources, Prompts) Model Context Protocol (MCP) server that enables external clients (such as Antigravity, Claude Code, t-line desktop client, or custom automation scripts) to inspect, monitor, and interact with the 3-tier multi-agent hierarchy (Master Agent -> Superagent -> Subagent).

Each feature-level Superagent operates within an isolated Git feature worktree (located under .worktrees/<branch> or registered in ~/.superagent-r/worktree-registry.json). Each instance maintains its own implementation plan document and task checklist.

This skill outlines how MCP clients can discover instances, resolve worktrees, read active plan and task files, view live execution logs, and monitor completion reports.

---

## 1. Instance Discovery

Before reading an instance's specific plan or task checklist, an MCP client can discover active instances and their worktree locations using either tools or resources.

### MCP Tools for Discovery

1. superagent_list_active
   - Lists all currently running Superagents, Subagents, and background processes.
   - Output includes: instance ID, agent role, git branch, current status, and assigned task prompt.
   - Example call:
     ```json
     {
       "includeCompleted": true
     }
     ```

2. superagent_manage_worktrees
   - Action "list" returns all registered Git feature worktrees.
   - Output includes: instance ID, role, branch name, status, and absolute worktreePath on disk.
   - Example call:
     ```json
     {
       "action": "list"
     }
     ```

### MCP Resources for Discovery

1. superagent://status/live
   - Returns a real-time JSON payload containing:
     - masterAgent: running state and token analytics
     - superagents: active instances array (ID, role, branch, status, task)
     - subagents: ephemeral child agents
     - backgroundTasks: running processes and PIDs

2. superagent://workspace/info
   - Returns a JSON payload containing the root workspace path, active Git branch, and list of registered feature worktrees with paths.

---

## 2. Reading Plan and Task Files per Instance

Each Superagent worktree stores:
- Plan file: _plan.md, plan.md, or implementation_plan.md
- Task checklist: _task.md, task.md, or tasks.md

Checklist items are formatted using Markdown task syntax:
- [ ] Pending task
- [/] Task in progress
- [x] Completed task

### Tool: superagent_get_plan_and_tasks

This tool automatically detects and parses the plan file and checklist items.

#### Option A: Direct Resolution via superagentId (Recommended)
Pass the instance ID directly. The MCP server automatically resolves the instance's worktree path from the active instance registry:
```json
{
  "superagentId": "abc1234"
}
```

#### Option B: Resolution via workspace Path
Pass the absolute or relative path to the instance's worktree:
```json
{
  "workspace": "D:/projects/my-app/.worktrees/feature-auth"
}
```
If neither parameter is passed, the tool defaults to reading plan and task files from the root workspace.

#### Tool Output Structure
The output returns:
- Implementation Plan content (first 1500 characters of the plan document)
- Task Checklist with parsed statuses:
  ```text
  === Implementation Plan ===
  # Feature Implementation Plan
  ...

  === Task Checklist ===
    - [x] Set up database schema
    - [/] Implement API endpoints
    - [ ] Write integration tests
  ```

---

## 3. Modifying Task Checklists via MCP

### Tool: superagent_update_tasks

Allows clients to update, check off, or add tasks to the checklist in the root workspace or an isolated Superagent instance worktree:
- action: "mark_completed" with taskText: "<task text>"
- action: "mark_in_progress" with taskText: "<task text>"
- action: "add_task" with taskText: "<task description>"
- action: "get_status" to inspect task status
- superagentId: optional Superagent instance ID to target its isolated worktree checklist
- workspace: optional worktree directory path to target

Example updating an instance's checklist:
```json
{
  "superagentId": "abc1234",
  "action": "mark_completed",
  "taskText": "Set up database schema"
}
```

---

## 4. Reading Status, Execution Logs, and Reports

### Tool: superagent_get_status
Retrieves detailed instance progress, status, prompt, and completion report:
```json
{
  "superagentIds": ["abc1234"]
}
```

### Tool: superagent_get_logs
Streams or retrieves recent execution logs (including thinking logs and command output) for a given instance ID:
```json
{
  "id": "abc1234",
  "limit": 100
}
```

### Tool: superagent_manage
Provides lifecycle management actions:
- action: "status": Summarizes instance states.
- action: "logs": Retrieves all recorded logs for specified superagentIds.
- action: "report": Fetches the final completion summary and deliverables.
- action: "violations": Checks if the instance violated worktree isolation or tier constraints.
- action: "kill": Terminates a running instance.
- action: "retry_failed": Restarts a failed Superagent from its existing worktree.

---

## 5. Reading Arbitrary Files inside Instance Worktrees

### Tool: superagent_read_file
To inspect files other than standard plan or task files (such as generated code, diffs, or custom artifacts) within an instance's isolated worktree, pass the worktree path in the cwd parameter:
```json
{
  "filePath": "src/services/auth.ts",
  "cwd": "D:/projects/my-app/.worktrees/feature-auth",
  "startLine": 1,
  "endLine": 100
}
```

---

## 6. End-to-End Client Workflow Recipes

### Recipe 1: Monitoring a Spawned Superagent
1. Spawn the Superagent using superagent_invoke:
   ```json
   {
     "role": "auth-developer",
     "task": "Implement OAuth2 login with Google and GitHub",
     "branch": "feature-oauth"
   }
   ```
2. Note the returned superagentId or inspect active instances via superagent_list_active.
3. Periodically inspect progress by calling superagent_get_plan_and_tasks:
   ```json
   {
     "superagentId": "<id>"
   }
   ```
4. Check real-time command output or thinking by calling superagent_get_logs:
   ```json
   {
     "id": "<id>",
     "limit": 50
   }
   ```
5. Once completed, inspect the final report with superagent_manage (action: "report"), and merge changes into the main workspace via superagent_merge.

### Recipe 2: Intervening or Sending Feedback to a Superagent
If a running or paused Superagent requires updated guidance:
1. Call superagent_send_message:
   ```json
   {
     "superagentId": "<id>",
     "message": "Please also add unit tests for the token refresh logic.",
     "wait": true
   }
   ```
2. If the Superagent was paused, call superagent_resume:
   ```json
   {
     "superagentId": "<id>",
     "message": "Resume work and verify with bun test."
   }
   ```
