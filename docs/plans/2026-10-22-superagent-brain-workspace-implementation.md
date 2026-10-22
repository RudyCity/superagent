# SuperAgent Brain Workspace — implemented increments (2026-10-22)

## Intent
A session-local working area under `~/.superagent-r/brain/`, analogous to Antigravity's Brain + Scratch. Research, generated scripts, experiments and temporary artifacts need not be written into the current Git repository. Brain supplements existing SQLite history and RMemory; it does not replace either.

## Current storage
```text
~/.superagent-r/brain/
  <principal-hash>/
    <session-id>/
      manifest.json
      scratch/
        scripts/
        experiments/
        temporary/
      artifacts/
      evidence/
```
Principals are separated by authenticated OAuth identity, static bearer credential hash, or local CLI owner. Path traversal, filesystem links, hidden/dot paths and overwrites are guarded.

## CLI
`/brain` and `/scratch` are aliases:
- `/brain create` and `/brain inspect` operate on the current agent history session.
- `/brain files`, `/brain list`, `/brain clean <sessionId>`.
- `/brain delegate.start agy <prompt>` (also claude or codex), `/brain jobs`, `/brain get <jobId>`, `/brain tail <jobId>`, `/brain cancel <jobId>`.
- The delegated CLI uses the current session Brain scratch as cwd. The CLI has its normal OS-level capabilities; cwd is **not** a process sandbox.

## MCP
- `superagent_brain` supports `current|create|list|inspect|files|read|write|cleanup` plus `delegate.start|delegate.jobs|delegate.get|delegate.tail|delegate.cancel`.
- A missing `sessionId` selects an ID scoped to the MCP server/transport instance. It remains stable for that instance. For cross-connection resume, preserve the returned `sessionId` and supply it explicitly.
- `delegate.start` uses CLI Bridge in background mode; output jobs and locks are scoped to the Brain scratch path. AGY defaults to `accept-edits`, not `full-auto`.
- `superagent_brain_publish` requires `projectId`, `sessionId`, an `artifacts/` source path and a project-relative destination path. Standard MCP project routing + the **write** capability authorize the destination. Only registered local projects are supported, and publishing cannot overwrite an existing file.
- Both tools are classified dangerous in MCP: callers need the enabled dangerous-tool policy and, in OAuth mode, `mcp:tools:write`. Project grants and other protected-file policies are not bypassed.

## Agent lifecycle and /goal
- Owner-facing single/master agent sessions automatically create or rebind their Brain on history load, resume, save, and clear. This does not change the agent's working directory or its Git project.
- ContextBuilder includes a concise session scratch path and prefers non-project drafts there.
- `/goal` writes the goal scratchpad to `scratch/scratchpad.md` inside its Brain, not `<project>/scratch`. ContextBuilder reads the same session file.
- Subagents do not silently acquire the owner's Brain identity.

## Limits and security
- File write/read tool: text only, 256 KiB each; aggregate session files up to 10 MiB for these API writes. CLI-delegated files are subject to CLI Bridge's distinct output/artifact verification policy, not these API write quotas.
- `cleanup` deletes only scratch and requires the exact session ID; artifacts and evidence survive.
- Publish reads files at most 256 KiB and refuses existing paths. Direct shell processes are **not** isolated by a container: an authorized CLI may possess wider OS privileges. Use CLI permission modes or a real sandbox before executing untrusted instructions.
- `superagent_brain` is not automatically exposed until an MCP server is restarted/reconnected against the new build.
- Per-connection MCP auto Brain is not guaranteed to equal a provider's ChatGPT conversation ID. Persistence across reconnects uses explicit session IDs.

## Validation
```sh
bun run build
bun --bun x vitest run tests/brainWorkspace.test.ts tests/brainMcp.test.ts tests/brainHistoryLifecycle.test.ts tests/mcpProjectAccessPolicy.test.ts tests/mcpServer.test.ts
```

## Further enhancements
T-Line desktop visualization of Brain files and delegation jobs; richer binary artifact storage/import/export; limited retention preview and cleanup with explicit approval; audit trail for publish; live AGY/Claude integration smoke tests and restart/reconnect verification. None is claimed complete here.
