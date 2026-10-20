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

Increment 6A: The same observed SSE journal now also has a **bounded local
persistence layer** at `~/.superagent-r/tline-task-ledger/`. Records are keyed
by a workspace/session hash and atomically rewritten with explicit metadata
allowlisting; persisted copies strip chat session IDs and unexpected fields.
A maximum of 64 events/2 MiB per scope, 64 scopes and 24-hour retention
applies. After restart, retained event IDs can be replayed only to the
authenticated exact workspace and TLine session. The SSE stream warns of a
`restart-observation-gap` because source updates not sampled while offline
cannot be reconstructed. It warns `ledger-unavailable` if durable storage
fails while memory-based streaming continues. This is **not** complete durable
source-event capture and offers no cancel/retry action.

Increment 6B: An optional local operator capability can be enabled explicitly
with `SUPERAGENT_TLINE_WORKSPACE_CANCEL=1` in the **SuperAgent HTTP server**
environment (requires service restart). Without that flag the capability
manifest does not advertise cancellation and the endpoints respond 403.

When enabled, `tasks.cancel.prepare` and `tasks.cancel.confirm` are
two **fixed** POST endpoints. They require a valid registered workspace, an
exact active TLine chat session, and a CLI Bridge job owned by the current
runtime process with an active process handle. The server issues a cryptographic
one-use 30-second challenge, then checks the same job's PID, startedAt,
updatedAt, canonical workspace and runtime ownership again before calling the
existing CLI Bridge cancellation handler. It signals a *cancellation request*,
not a verified completed shutdown.

**Important limitation (Increment 6C):** New CLI Bridge delegations launched
while a server-authorized TLine chat is executing now store **server-internal
creator-session provenance** in the immutable job snapshot. TLine cancellation
requires the same creator chat ID, canonical workspace and active runtime
handle. Old CLI/MCP jobs without trusted creator provenance are always denied,
even with operator opt-in. No user input or tool argument can assign the
creator. Workspace task snapshots expose only a boolean cancellation
eligibility hint, never another session's creator identity.

Retry remains disabled: old job storage has no full original prompt/arguments
to replay safely. A future retry needs an explicit fresh user request,
idempotency protection and artifact claim verification.

**Remaining limitation:** The creator chat is now verified for newly launched
TLine jobs, but the app does not establish independent human-account identity
or out-of-band user approval. Leave cancellation OFF for shared or untrusted
workspaces. Legacy jobs are denied, and there is still no daemon/Muse kill,
arbitrary PID control or automatic retry.

Verification: `bun x vitest run tests/tlineCapabilities.test.ts tests/tlineInspection.test.ts tests/tlineTaskSnapshot.test.ts tests/tlineTaskFeed.test.ts tests/tlineTaskLedger.test.ts tests/tlineTaskCancel.test.ts tests/tlineJobCreator.test.ts`,
`bun run build`. This is a source/build test; an actual existing server process
must be upgraded/restarted to expose the new endpoint. Do not kill or restart
an unrelated process on port 7888 for validation.

Next increments: workspace-scoped task status and replay, typed MCP/tool
discovery, Muse/selfdev monitoring, project/worktree authorization, then
controlled daemon writes. Avoid generic shell or arbitrary URL proxying.
