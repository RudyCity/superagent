---
name: CLI Bridge
description: Delegate tasks and collaborate with external AI CLI assistants (Codex, Claude Code, AGY, or custom binaries) via one-shot execution or persistent multi-turn sessions.
when_to_use: when delegating tasks to external AI CLI assistants, running Codex, Claude Code, or AGY from Superagent, orchestrating multi-CLI workflows, or managing interactive CLI subprocess sessions
version: 1.1.0
languages: all
dependencies: cli_bridge tool
---

# CLI Bridge

## Overview

The `cli_bridge` tool enables Superagent to offload tasks to external AI CLI assistants (such as Antigravity/AGY, Claude Code, OpenAI Codex, or any custom executable) in two execution modes:

1. **One-Shot Task Delegation (`action: "delegate"`) [RECOMMENDED]**:
   - Executes the external CLI in print mode (`-p` / `--print`), passes the prompt, sends EOF on stdin, auto-handles `--dangerously-skip-permissions`, streams output in real-time, waits for execution to complete, and returns the full output.
   - **Best for**: Autonomous coding, file reading/editing, code analysis, bug fixing, test running, building, and script generation.

2. **Interactive Subprocess Sessions (`action: "session.*"`)**:
   - Spawns the CLI as a long-lived subprocess with stdio streaming, event buffering, automatic prompt detection, and multi-turn message exchange.
   - **Best for**: Interactive human-in-the-loop dialogs, step-by-step interactive sessions, or when responding to TUI choice menus via `session.respond`.

---

## Quick Action Reference

| Action | Purpose | Key Parameters |
|---|---|---|
| `list` | Discover installed CLI binaries on system PATH | None |
| `profile.list` | List built-in and user-configured CLI profiles | None |
| `delegate` | Execute a one-shot prompt against a CLI tool (auto-skips permissions, streams real-time output) | `cli`, `prompt`, `cwd`, `skills`, `timeoutMs`, `system`, `args` |
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

Use `action: "delegate"` for all standalone coding, research, refactoring, and test execution tasks.

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
- Headless execution automatically passes `--dangerously-skip-permissions`, preventing tool execution blocks.
- The process receives the full prompt and begins execution immediately without waiting for stdin EOF.
- Real-time streaming output is captured and displayed in the terminal UI.

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
```json
{
  "action": "session.kill",
  "sessionId": "refactor-auth-service"
}
```

---

## Critical Rules & Invariants

1. **Always Prefer `delegate` for Autonomous Coding**: When delegating codebase modifications, builds, test execution, or file generation, ALWAYS use `action: "delegate"`.
2. **Attach Reference Directories via `skills`**: Pass an array of directory paths in `skills: [...]` to attach context (automatically converted to `--add-dir` for AGY/Claude Code).
3. **Always Clean Up Multi-Turn Sessions**: When using `session.create`, always call `session.kill` once work is complete to release subprocesses and memory.
4. **Appropriate Timeouts**: Set `timeoutMs` (e.g. 300000 to 600000 ms) for long-running compilation or multi-file edits.
