# T-Line Runtime Capability Contract (Increment 2)

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

T-Line negotiates the manifest before using a typed, authenticated backend
adapter. All other CLI slash commands are **not** implied to have T-Line
execution support. Workspace-global job listings and mutation operations are
not exposed by this contract without per-workspace authorization.

Verification: `bun x vitest run tests/tlineCapabilities.test.ts`,
`bun run build`. This is a source/build test; an actual existing server process
must be upgraded/restarted to expose the new endpoint. Do not kill or restart
an unrelated process on port 7888 for validation.

Next increments: workspace-scoped task status and replay, typed MCP/tool
discovery, Muse/selfdev monitoring, project/worktree authorization, then
controlled daemon writes. Avoid generic shell or arbitrary URL proxying.
