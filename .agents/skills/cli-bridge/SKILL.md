---
name: CLI Bridge
description: Delegate tasks and collaborate with external AI CLI assistants (Codex, Claude Code, AGY, or custom binaries) via one-shot execution or persistent multi-turn sessions.
when_to_use: when delegating tasks to external AI CLI assistants, running Codex, Claude Code, or AGY from Superagent, orchestrating multi-CLI workflows, or managing interactive CLI subprocess sessions
version: 1.2.0
languages: all
dependencies: cli_bridge tool
---

# CLI Bridge

## Overview

The `cli_bridge` tool enables Superagent to offload tasks to external AI CLI assistants (such as Antigravity/AGY, Claude Code, OpenAI Codex, or any custom executable) in two execution modes:

1. **Synchronous Task Delegation (`action: "delegate"`)**:
   - Runs one external CLI invocation, waits for completion, and returns the output in the same MCP call.
   - **Best for**: Quick questions, small changes, and short checks. The default timeout is 5 minutes.

2. **Long-Running / Parallel Delegation Jobs (`action: "delegate.start"`)**:
   - Starts an autonomous one-shot CLI job in the background and immediately returns a `jobId`. The job keeps running after the initial MCP call returns.
   - Poll with `delegate.get`, read log output with `delegate.tail`, list all jobs with `delegate.jobs`, or stop one with `delegate.cancel`.
   - Background timeout defaults to 30 minutes and accepts 1 second through 2 hours. Default concurrency is 4 jobs, configurable with `SUPERAGENT_CLI_BRIDGE_MAX_JOBS` (maximum 12).
   - **Best for**: Builds, test suites, large refactors, multi-step implementation tasks, and parallel independent subtasks.

3. **Interactive Subprocess Sessions (`action: "session.*"`)**:
   - Spawns the CLI as a long-lived subprocess with stdio streaming, event buffering, automatic prompt detection, and multi-turn message exchange.
   - **Best for**: Interactive human-in-the-loop dialogs, step-by-step interactive sessions, or when responding to TUI choice menus via `session.respond`.

---

## Quick Action Reference

| Action | Purpose | Key Parameters |
|---|---|---|
| `list` | Discover installed CLI binaries on system PATH | None |
| `profile.list` | List built-in and user-configured CLI profiles | None |
| `delegate` | Run a short synchronous task and return the final output | `cli`, `prompt`, `cwd`, `permissionMode`, `skills`, `timeoutMs`, `system`, `args` |
| `delegate.start` | Start a long-running background job and return its `jobId` | `cli`, `prompt`, `cwd`, `permissionMode`, `skills`, `timeoutMs`, `system`, `args` |
| `delegate.jobs` | List retained background jobs and their states | None |
| `delegate.get` | Inspect a job's state, duration, and recent output | `jobId` |
| `delegate.tail` | Read the recent lines from the job's full log | `jobId`, `tailLimit` |
| `delegate.cancel` | Request cancellation and process-tree termination | `jobId` |
| `session.create` | Start an interactive subprocess session | `cli`, `sessionId`, `message` / `initialMessage`, `skills`, `autoDetect`, `cwd`, `idleTimeoutMs`, `maxBufferLines` |
| `session.send` | Send a new prompt to an existing session | `sessionId`, `prompt` / `message`, `timeoutMs` |
| `session.respond` | Answer an interactive prompt (yes/no, choices) | `sessionId`, `answer` |
| `session.tail` | Read recent live events or extend session idle TTL | `sessionId`, `since`, `tailLimit`, `setIdleTimeoutMs` |
| `session.get` | Retrieve session status and recent stdout/stderr | `sessionId` |
| `session.list` | List all active and detached sessions | None |
| `session.export` | Export session history and output log as markdown | `sessionId` |
| `session.config` | Read or modify session configuration parameters | `sessionId` |
| `session.resume` | Resume session using profile-specific resume flags | `cli`, `sessionId`, `conversationId` |
| `session.detach` | Detach session from active management | `sessionId` |
| `session.kill` | Terminate session subprocess and free resources | `sessionId` |

---

## Core Usage Patterns

### 1. Discover Available CLIs
Before delegating, check which CLI assistants are installed:

```json
{
  "action": "list"
}
```

Returns detected binaries, version info, and path availability for `agy`, `claude`, `codex`, etc.

---

### 2. Autonomous Task Delegation (`delegate`) [PRIMARY PATTERN]

Use `action: "delegate"` for short standalone tasks. For builds, test suites, long-running coding work, or jobs that need to run in parallel, use `action: "delegate.start"` so the MCP call returns promptly and the work remains pollable.

Example starting a long task:
```json
{
  "action": "delegate.start",
  "cli": "agy",
  "prompt": "Implement the requested change, run focused tests and a build, and report exact files changed and verification results.",
  "cwd": "D:\\project",
  "timeoutMs": 3600000
}
```

The response contains a `jobId`. Poll it using `delegate.get` and fetch output with `delegate.tail`; continue polling until the job reaches a terminal status (`succeeded`, `failed`, `timed_out`, `cancelled`, or `interrupted`). Do not start another copy merely because the first call returned: that return means the job was accepted, not that the work finished.

For parallel work, start one job per independent subtask and use separate Git worktrees / working directories for tasks that edit files. Multiple jobs in the same directory share the same files and can overwrite or conflict with one another. The default cap is 4 active jobs; set `SUPERAGENT_CLI_BRIDGE_MAX_JOBS` to a value from 1 to 12 to tune it.

Example: Delegating code analysis & rewrite with multiple reference directories attached:

```json
{
  "action": "delegate",
  "cli": "agy",
  "prompt": "Read G:\\project\\qwen\\_ref\\llama_cpp_ref\\models\\qwen35.cpp and rewrite the inference engine in G:\\project\\rudy-lang\\src\\gguf.c to match the Qwen3.5 GDN architecture.",
  "cwd": "G:\\project\\qwen",
  "skills": [
    "G:\\project\\qwen\\_ref\\llama_cpp_ref\\models",
    "G:\\project\\qwen\\_ref",
    "G:\\project\\rudy-lang\\src"
  ],
  "timeoutMs": 600000
}
```

Why `delegate` is preferred for coding tasks:
- The process receives the full prompt and begins execution immediately without waiting for stdin EOF.
- Real-time streaming output is captured and displayed in the terminal UI.
- Supports configurable permission policies via `permissionMode`.

#### Permission Policies & Headless Delegation (`permissionMode`)

When delegating background jobs (`delegate.start`) or running non-interactive commands with external CLIs like AGY, configure `permissionMode`:

- **`accept-edits` (Default)**: Allows direct file editing within the workspace. However, arbitrary shell commands will request user review, which cannot be prompted in headless background mode; this causes unapproved commands to terminate with `status: permission_blocked` (`denied_actions`).
- **`full-auto`**: Explicitly passes `--dangerously-skip-permissions` to the external CLI. **Use this for autonomous background tasks** (such as builds, test suites, or full repository audits) that require executing shell commands without being blocked.
- **`auto`**: Standard autonomous execution where supported by the underlying CLI account.
- **`plan`**: Read-only planning mode without executing mutations.

Example with `full-auto`:
```json
{
  "action": "delegate.start",
  "cli": "agy",
  "prompt": "Audit and run tests across all MCP modules",
  "permissionMode": "full-auto",
  "cwd": "D:\\project"
}
```

---

### 3. Multi-Turn Interactive Sessions (`session.*`)

Use `session.create` when you specifically require persistent multi-turn conversations with step-by-step confirmation.

#### Step 1: Create Session with Initial Prompt
```json
{
  "action": "session.create",
  "cli": "claude",
  "sessionId": "refactor-auth-service",
  "initialMessage": "Analyze src/auth/jwt.ts and list potential token expiration bugs.",
  "skills": ["src/auth"],
  "idleTimeoutMs": 1800000
}
```

#### Step 2: Send Follow-up
```json
{
  "action": "session.send",
  "sessionId": "refactor-auth-service",
  "prompt": "Proceed with refactoring the refresh token rotation logic."
}
```

#### Step 3: Respond to Interactive Prompts
If the CLI asks for confirmation:
```json
{
  "action": "session.respond",
  "sessionId": "refactor-auth-service",
  "answer": "y"
}
```

#### Step 4: Clean Up Session
Always kill sessions when done to free system resources:
```json
{
  "action": "session.kill",
  "sessionId": "refactor-auth-service"
}
```

---

### 4. Artifact Path Injection & Task Synchronization (v1.5.40)

By default (`injectArtifacts: true`), CLI Bridge automatically resolves active project artifacts and injects their absolute paths and update instructions into the prompt sent to the external CLI:
- Task Checklist: `_task.md` or `task.md`
- Implementation Plan: `_plan.md`, `plan.md`, or `_implementation_plan.md`
- Walkthrough Document: `_walkthrough.md` or `walkthrough.md`

This enables the external CLI to:
1. Inspect the implementation plan before making modifications.
2. Update checklist tasks in real-time (`- [ ]` to `- [/]` for in-progress, `- [x]` for completed).
3. Document verification command outputs in the walkthrough document.

Example delegating with custom artifact path:
```json
{
  "action": "delegate",
  "cli": "agy",
  "prompt": "Implement the auth token rotation feature according to the plan.",
  "injectArtifacts": true,
  "taskPath": "tasks/auth_tasks.md"
}
```

To disable automatic artifact context injection for simple queries:
```json
{
  "action": "delegate",
  "cli": "claude",
  "prompt": "Quick explanation of this regex pattern.",
  "injectArtifacts": false
}
```


---

## Critical Rules & Invariants

1. **Choose the right execution mode**: Use `delegate` for short tasks and `delegate.start` for long-running coding, builds, and test execution. Poll background jobs to a terminal state before reporting success.
2. **Attach Reference Directories via `skills`**: Pass an array of directory paths in `skills: [...]` to attach context (automatically converted to `--add-dir` for AGY/Claude Code).
3. **Always Clean Up Multi-Turn Sessions**: When using `session.create`, always call `session.kill` once work is complete to release subprocesses and memory.
4. **Appropriate Timeouts**: Set `timeoutMs` (e.g. 300000 to 600000 ms) for long-running compilation or multi-file edits.
