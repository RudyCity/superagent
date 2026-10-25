# T-Line Agent Execution Journal (Core-owned)

Last verified: 2026-10-26

## Architecture
- `src/core/channels/tlineAgentTimeline.ts`: atomic, bounded **metadata-only** journal. Hashes workspace/session into a scope file name; never persists the workspace path, session ID, prompt, tool inputs/results, browser cookies, permission IDs/tokens or private subagent IDs.
- `src/core/channels/tlineAgentTimelineHttp.ts`: **GET** `/api/tline/agent-timeline?workspace=...&sessionId=...&cursor=N`. Existing authenticated local API/trusted-directory gate applies before the route; the route additionally requires `x-client-mode: tline`, exact `x-workspace-path`, and a server-verified active session belonging to the same workspace.
- `src/server.ts`: whitelisted tool start/finish, agent done, permission requested and verified subagent status events are projected by the server **only for a T-Line active session**. Unknown/unscoped streams are never journaled.
- `src/serverRoutes.ts`: explicit successful permission decisions are stored as metadata with normalized decision values, after prompt-owner validation. A recorded approval does **not** re-authorize any future action.
- `src/core/tools/subagentTools.ts`: child tool start/finish metadata is saved only if the child inherits the exact scope through a root Agent verified by the T-Line server. Nested and resumed subagents follow the original parent scope. Tools in unrelated sessions/Muse are unaffected.

## Retention, recovery and gaps
- Each scope retains up to **400** recent records, with monotonically increasing `seq` and source-time `at`, and atomically rewritten on each event under an exclusive per-file writer lock.
- At most **96** scope files and **7 days** of retention are kept by periodic best-effort pruning. The client must treat `gap: true` as proof that earlier data is missing.
- The GET endpoint reads at most 100 records after a validated cursor per page. Reopening T-Line fetches from the journal without re-executing a tool or pending permission.
- An interrupted tool may have `tool_start` without `tool_end`. This is **unknown**, not necessarily success or failure.
- After **Core** restarts, journal snapshots are still readable once the session is re-established; missing events during Core downtime are not fabricated.

## Authorization
- The Core root binds T-Line identity only from its **server-owned active session**; child agents inherit through object identity in a WeakMap, never by workspace-path guessing.
- Separate sessions under the same workspace maintain different hash-named journal files. A wrong session, wrong workspace or chrome-extension mode fails the HTTP read check.
- The timeline is **read-only**; historical `permission_requested` events cannot be approved again. Existing live Core permission workflow remains the only approval path.

## Validation
```sh
bun run build
bun --bun x vitest run tests/tlineAgentTimeline.test.ts tests/assistantTaskHttpRoutes.test.ts tests/tlineTaskLedger.test.ts
```

## Limits
The journal intentionally omits detailed tool arguments, outputs, prompt text and reasoning; full forensic replay of secret-bearing payloads is prohibited. Plan-review UI and live permission cards remain separate workflows. Packaged Tauri visual QA and a live provider roundtrip need to be performed against an active desktop session. Existing Muse code and tunnels are not modified.
