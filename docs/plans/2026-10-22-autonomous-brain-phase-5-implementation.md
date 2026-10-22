# Phase 5 — Autonomous Brain, Multi-Agent Tasks, Continuity and Dashboard
Date: 2026-10-22

## Implementation

SuperAgent Brain now has one canonical owner-scoped task runtime in `src/core/brain/brainTasks.ts`, with generated T-Line implementation from `bun scripts/sync-brain-runtime.ts`.

### P0 — Live runtime acceptance
- The standard two-repository release check passes with 37 SuperAgent Brain/MCP tests, 12 T-Line backend tests, 5 T-Line UI tests and successful Bun builds.
- A remote service check observed active OAuth-protected tunnels, including the SuperAgent workspace. This is status metadata, **not** authentication through the deployed public tunnel.
- The previous Claude acceptance job ID could not be found in the currently authorized workspace. CLI Bridge health found 0 active jobs. This does not prove the earlier Claude execution succeeded; do not resurrect or clean other sessions.
- A real AGY delegated Brain proof passed during the earlier phase. This phase also verified the new one-step `task.autostart` end-to-end through the MCP dispatch adapter and a REAL AGY CLI on the host (not a mocked task):
  - Session `live_task_4457a0ba406a`
  - Task `task_323293407c748dfc0b8a`
  - Job `clj_1792656800835_27ea9c4e`
  - AGY produced the expected `proof.txt` in its isolated agent scratch; verified-artifact state was confirmed; `task.resume` recovered the persisted task/job reference.
  - Repeat with `bun scripts/brain-live-task-acceptance.ts`. This may consume LLM credits and should not run automatically in CI.
- No shared active MCP tunnel was restarted, and no installed T-Line desktop process was modified.

### P1 — Automatic Brain lifecycle and collaboration
- HistoryManager already initializes Brain on normal owner chat session load/save. No new repo-local scratch folder is created.
- **CLI** `/brain delegate.start <agy|claude|codex> <prompt>` now automatically creates a task, claims it for the delegated CLI and runs it from isolated `scratch/agents/<cli>/<task-id>/`. It returns the task ID and retains the background delegation ID for recovery.
- **MCP** `superagent_brain` action `task.autostart` starts the same owner-scoped workflow in one call. For existing tasks use `task.delegate.start` after an explicit claim.
- Each Brain task tracks members (logical agent IDs), exclusive assignment, lifecycle state, bounded append-only checkpoints, optional handoffs and verified background job references.
- `task.handoff` copies a finalized artifact (max 20 MiB) to the receiving agent's task inbox, verifying its SHA-256. It never exposes raw project files or modifies the source artifact.
- `task.transfer` explicitly assigns the task to another listed agent. Simultaneous ownership is refused; session-wide locking protects task mutations.
- **Isolation:** all task IDs, checkpoints, claims and artifact copies are within the authenticated Brain owner namespace. Task agent IDs are **not OAuth principals** and do not grant separate cross-tenant or OS-level access. No arbitrary read/write sharing between OAuth identities has been introduced.

### P2 — Continuity
- `task.resume` returns the latest versioned checkpoint, owner, collaborators, handoff references and delegated job IDs. Task metadata persists across CLI/MCP/T-Line process reconnects.
- Existing `session.resume` still returns verified artifact metadata and pending scratch. RMemory remains separate and explicit; a task checkpoint does not become a global memory without permission.
- Checkpoint contents are untrusted collaborator text, not system instructions.
- Actual background CLI liveness comes from CLI Bridge, not from the persisted task snapshot. A reference to a job does not prove it is running or finished.

### P2 — T-Line dashboard
In **SuperAgent → Brain Explorer → Multi-agent tasks**, create a task, select members, claim work, save checkpoint, select a collaborator, copy a finalized artifact into their inbox, transfer task ownership or complete the task. Session switching does not change the project workspace.

T-Line endpoints, all scoped to the existing authenticated desktop operator and the canonical local-cli principal:
```text
GET  /api/superagent/brain/sessions/:sessionId/tasks
POST /api/superagent/brain/sessions/:sessionId/tasks
GET  /api/superagent/brain/sessions/:sessionId/tasks/:taskId
GET  /api/superagent/brain/sessions/:sessionId/tasks/:taskId/resume
POST /api/superagent/brain/sessions/:sessionId/tasks/:taskId/claim
POST /api/superagent/brain/sessions/:sessionId/tasks/:taskId/checkpoint
POST /api/superagent/brain/sessions/:sessionId/tasks/:taskId/handoff
POST /api/superagent/brain/sessions/:sessionId/tasks/:taskId/transfer
POST /api/superagent/brain/sessions/:sessionId/tasks/:taskId/status
```

### MCP examples
```json
{"action":"task.autostart","cli":"agy","prompt":"Research a CSV and produce a verified report"}
{"action":"task.list","sessionId":"my-session"}
{"action":"task.create","sessionId":"my-session","title":"Review report","agentIds":["main","agy","claude"]}
{"action":"task.claim","sessionId":"my-session","taskId":"task_...","agentId":"agy"}
{"action":"task.checkpoint","sessionId":"my-session","taskId":"task_...","agentId":"agy","note":"Analysis finished","nextStep":"Review with Claude"}
{"action":"task.handoff","sessionId":"my-session","taskId":"task_...","agentId":"agy","toAgent":"claude","filePath":"artifacts/report.pdf"}
{"action":"task.transfer","sessionId":"my-session","taskId":"task_...","agentId":"agy","toAgent":"claude"}
{"action":"task.resume","sessionId":"my-session","taskId":"task_..."}
```

### CLI examples
```text
/brain task.create Review CSV output
/brain task.list
/brain task.claim <taskId> main
/brain task.checkpoint <taskId> main Validated results
/brain task.transfer <taskId> main agy
/brain task.resume <taskId>
/brain delegate.start agy Create an analysis report
```

## Acceptance and remaining limits
```bash
bun scripts/sync-brain-runtime.ts --check
bun scripts/verify-brain-release.ts --with-tline
```
Offline tests validate owner isolation, exclusive claims, failed unauthorized writes, task persistence, checkpoint integrity, verified artifact handoff, OAuth MCP schema and live loopback HTTP API/UI tests.

Not yet production-certified: actual OAuth end-to-end through the configured public tunnel after controlled restart, newly packaged T-Line interactive smoke, and fresh real Claude delegation. Existing active services have deliberately been left running.

The Brain scratch working directory and logical task membership are **not** OS containers or security sandboxes. If using untrusted agents on the same machine, enforce OS/process-level restrictions outside Brain.
