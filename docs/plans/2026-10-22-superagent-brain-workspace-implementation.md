# SuperAgent Brain Workspace — implementation (2026-10-22)

## Purpose
Per-session scratch and artifacts live under `~/.superagent-r/brain/`, separate from every Git repository. This feature supplements—not replaces—history SQLite and RMemory.

## Current layout
```text
~/.superagent-r/
  brain/
    <principal-sha256-prefix>/
      <session-id>/
        manifest.json
        scratch/
          scripts/
          experiments/
          temporary/
        artifacts/
        evidence/
```

A principal namespace is based on the authenticated OAuth subject, static-bearer credential hash, or the local stdio owner. Project changes never mutate this path.

## Interfaces
- MCP: `superagent_brain` with `action=create|list|inspect|files|read|write|cleanup`. Writes require dangerous MCP permission / OAuth write scope. Supply `sessionId` on subsequent calls. The MCP tool cannot execute shell commands or publish outside its brain namespace.
- CLI: `/brain create [sessionId]`, `/brain list`, `/brain inspect [sessionId]`, `/brain files [sessionId]`, `/brain clean <sessionId>`; alias `/scratch`.
- Files: relative paths only under `scratch/`, `artifacts/`, or `evidence/`. Text files are limited to 256 KiB and a session quota of 10 MiB. Default is no overwrite.
- Cleanup: must provide exact session ID. Only removes scratch, preserving manifest, artifacts, evidence.

## Boundaries and unfinished work
- No automatic brain selection for normal project tools yet; existing project authorization remains unchanged.
- The tool uses a generated brain session ID when none is provided; callers must retain the returned ID. Full chat-to-brain binding for all channels is not implemented yet.
- No unrestricted shell runner, project publication, filesystem-wide artifact promotion, visual T-Line browser, retention scheduler, or project-wide automatic artifact search yet.
- A directory and path guard is not a process/container sandbox. Never run untrusted commands solely because their cwd is scratch.
- Existing history, workspace summaries and RMemory data are not migrated or deleted.
- Target next: typed task context (principal/session/project/task), automatic scratch allocation, integrated CLI bridge output promotion with explicit destination approval, durable artifact metadata, retention preview, T-Line controls.

## Acceptance
`bun run build`
`bun --bun x vitest run tests/brainWorkspace.test.ts tests/mcpServer.test.ts`
