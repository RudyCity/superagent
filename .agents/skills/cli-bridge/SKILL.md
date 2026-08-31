---
name: CLI Bridge
description: Delegate tasks and collaborate with external AI CLI assistants (Codex, Claude Code, AGY, or custom binaries) via one-shot execution or persistent multi-turn sessions.
when_to_use: when delegating tasks to external AI CLI assistants, running Codex, Claude Code, or AGY from Superagent, orchestrating multi-CLI workflows, or managing interactive CLI subprocess sessions
version: 1.0.0
languages: all
dependencies: cli_bridge tool
---

# CLI Bridge

## Overview

The `cli_bridge` tool enables Superagent to offload tasks to external AI CLI assistants (such as OpenAI Codex, Claude Code, Antigravity/AGY, or any custom executable) in two complementary execution modes:

1. **One-Shot Delegation (`delegate`)**: Fire-and-forget execution. Spawns the CLI with the prompt, waits for exit, and returns the output.
2. **Interactive Subprocess Sessions (`session.*`)**: Spawns the CLI as a long-lived subprocess with stdio streaming, event buffering, automatic prompt detection, and multi-turn message exchange.

---

## Quick Action Reference

| Action | Purpose | Key Parameters |
|---|---|---|
| `list` | Discover installed CLI binaries on system PATH | None |
| `profile.list` | List built-in and user-configured CLI profiles | None |
| `delegate` | Execute a one-shot prompt against a CLI tool | `cli`, `prompt`, `cwd`, `timeoutMs`, `systemPrompt`, `skills` |
| `session.create` | Start an interactive subprocess session | `cli`, `sessionId`, `initialMessage`, `systemPrompt`, `skills`, `autoDetect`, `idleTimeoutMs`, `maxBufferLines` |
| `session.send` | Send a new prompt to an existing session | `sessionId`, `prompt`, `timeoutMs` |
| `session.respond` | Answer an interactive prompt (yes/no, choices) | `sessionId`, `answer` |
| `session.tail` | Read recent live events or extend session idle TTL | `sessionId`, `since`, `limit`, `setIdleTimeoutMs` |
| `session.get` | Retrieve session status and recent stdout/stderr | `sessionId` |
| `session.list` | List all active and detached sessions | None |
| `session.export` | Export session history and output log as markdown | `sessionId` |
| `session.config` | Read or modify session configuration parameters | `sessionId`, `config` |
| `session.resume` | Resume session using profile-specific resume flags | `cli`, `sessionId`, `resumeId` |
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

Returns detected binaries, version info, and path availability for `codex`, `claude`, `agy`, etc.

### 2. One-Shot Task Delegation
For standalone queries or atomic script generation tasks:

```json
{
  "action": "delegate",
  "cli": "agy",
  "prompt": "Write a Python script to convert CSV files to Parquet format with snappy compression.",
  "systemPrompt": "You are a data engineering assistant. Output clean Python code only."
}
```

### 3. Multi-Turn Interactive Session Lifecycle
When iterating on complex codebases across multiple turns:

#### Step 1: Create Session
```json
{
  "action": "session.create",
  "cli": "claude",
  "sessionId": "refactor-auth-service",
  "initialMessage": "Analyze src/auth/jwt.ts and list potential token expiration bugs.",
  "autoDetect": true,
  "idleTimeoutMs": 1800000
}
```

#### Step 2: Follow-up Message
```json
{
  "action": "session.send",
  "sessionId": "refactor-auth-service",
  "prompt": "Proceed with refactoring the refresh token rotation logic based on your recommendations."
}
```

#### Step 3: Stream / Tail Logs
```json
{
  "action": "session.tail",
  "sessionId": "refactor-auth-service",
  "since": 0,
  "limit": 50
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

## Interactive Prompts and Detection

The CLI Bridge automatically monitors subprocess stdout for interactive prompts (e.g. `(y/n)`, `[Enter to continue]`, choice menus, or password prompts).

- When a prompt is detected, `session.send` returns `isPrompt: true` with prompt details.
- Respond directly using `action: "session.respond"`:

```json
{
  "action": "session.respond",
  "sessionId": "refactor-auth-service",
  "answer": "y"
}
```

---

## Skill and Context Auto-Detection

When `autoDetect: true` (default), the session automatically detects and injects project instruction files from the workspace in priority order:
1. `AGENTS.md`
2. `AGENTS.local.md`
3. `CLAUDE.md`
4. `AGY.md`
5. `CODEX.md`

Profiles and global skills are stored in:
- Profiles: `~/.superagent-r/cli-bridge/profiles.json`
- Skill Registry: `~/.superagent-r/cli-bridge/skills.json`

---

## Common Mistakes & Best Practices

1. **Always Kill Completed Sessions**: Always call `session.kill` when finished with a multi-turn task to release subprocess PIDs and memory buffers.
2. **Handle Interactive Prompts**: If an external CLI stops emitting output, check `session.get` or `session.tail` for `isPrompt` status and use `session.respond`.
3. **Use One-Shot for Atomic Work**: Prefer `action: "delegate"` over `session.create` for simple questions or self-contained tasks.
4. **Buffer Management**: For high-volume subprocess output, configure `maxBufferLines` on `session.create` (default 2000 lines).
