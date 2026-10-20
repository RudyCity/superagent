# T-Line Runtime Capability Contract (Increment 4)

Date: 2026-10-20. Implemented at `GET /api/tline/capabilities` in
`src/serverRoutes.ts` after the existing authorization and workspace gate.

The HTTP response is versioned (`schemaVersion:1`, `server:"superagent"`,
`version`). Its `commands` are **names and aliases from the actual runtime
CLI registry**. They are labelled `desktopExecution:"cli-only"` on purpose:
the server does not expose a general-purpose slash command executor.

The independent `httpActions` allowlist currently contains:

| Action ID | Upstream endpoint | Method |
|---|---|---|
| `daemon.status` | `/api/daemon/status` | GET |
| `gateway.status` | `/api/gateway/status` | GET |
| `mcp.status` | `/api/tline/inspect/mcp.status` | GET |
| `tools.catalog` | `/api/tline/inspect/tools.catalog` | GET |
| `selfdev.status` | `/api/tline/inspect/selfdev.status` | GET |
| `muse.status` | `/api/tline/inspect/muse.status` | GET |
| `tasks.snapshot` | `/api/tline/inspect/tasks.snapshot` | GET |
| `tasks.events` | `/api/tline/tasks/events` | GET (SSE) |

T-Line negotiates the manifest before using a typed, authenticated backend
adapter. Inspection actions require a valid registered workspace with an active
TLine session. They only return sanitized MCP/server names and counts, tool
names, workspace-specific selfdev counters, or the current workspace's Muse
task metadata. No credentials, process environment, transcripts, remote task
payloads, or tool input schemas are exposed. All other CLI slash commands are
**not** implied to have T-Line execution support. Workspace-global job listings and mutation operations are
not exposed by this contract without per-workspace authorization.

`tasks.snapshot` is built from existing CLI delegate, daemon ledger and Muse
sources and strictly limited to a registered workspace's authenticated TLine
session. The server only returns a bounded, redacted metadata projection.
Clients may send `cursor=<64-character-hex>` to omit an unchanged task array.
The cursor includes a per-process generation so reconnecting to a new server
produces a full resync, but this is **not SSE event replay**. Intermediate
status transitions can be missed, and no task controls are exposed.

`tasks.events` requires a server-authorized, exact TLine session ID and
workspace. It emits `snapshot` frames with opaque process-scoped event IDs,
`heartbeat`, `warning` and `reset`. Up to 64 **observed** snapshot changes
are held in a process-local journal per scope (10-minute inactivity expiry;
maximum 64 scopes). The client may resume from `Last-Event-ID` while a
matching journal still exists. An absent/foreign/expired ID produces
`reset` plus a full current snapshot. Streaming ends when the session
is no longer authorized. This is not an append-only durable source ledger:
intermediate source transitions during downtime cannot be replayed.
No task mutation or process cancellation is offered by these endpoints.

Verification: `bun x vitest run tests/tlineCapabilities.test.ts tests/tlineInspection.test.ts tests/tlineTaskSnapshot.test.ts tests/tlineTaskFeed.test.ts`,
`bun run build`. This is a source/build test; an actual existing server process
must be upgraded/restarted to expose the new endpoint. Do not kill or restart
an unrelated process on port 7888 for validation.

Next increments: workspace-scoped task status and replay, typed MCP/tool
discovery, Muse/selfdev monitoring, project/worktree authorization, then
controlled daemon writes. Avoid generic shell or arbitrary URL proxying.
