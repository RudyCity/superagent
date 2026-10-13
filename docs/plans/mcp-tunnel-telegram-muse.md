# Plan: MCP Tunnel Controls and Telegram-to-Muse

## Goal
Expose explicit, auditable MCP actions to inspect and control the Muse tunnel, restart it safely, and send a user-requested message to Muse via the configured Telegram bridge.

## Guardrails
- Preserve pre-existing working-tree edits and inspect them before touching overlapping files.
- Reuse existing tunnel/watcher and Muse Telegram client code. Do not create parallel transport implementations.
- Never return or log credentials, OAuth tokens, or bootstrap secrets.
- Never send real Telegram messages in tests, and never send a message as an implicit restart side effect.
- Restart only Superagent-owned services after checking type, target, PID, and port.
- Classify state-changing tools as dangerous; honor default safe allowlists and OAuth write-scope behavior.
- Do not make UI changes.

## Checklist
- [x] Read project guidance and inspect all pre-existing Git changes.
- [x] Trace MCP registration/dispatch/classification, tunnel lifecycle, Muse watcher lifecycle, and Telegram envelope semantics.
- [x] Reuse the existing read-only remote status tool for Muse/tunnel status.
- [x] Implement MCP tools to start/restart the Muse tunnel using existing lifecycle APIs, with safe ownership checks and sanitized structured results.
- [x] Implement a single-purpose MCP tool to send a text/chat envelope to Muse via the existing configured Telegram transport.
- [x] Add focused Vitest coverage for tool registration/classification, tunnel state cases, and mocked Telegram success/failure/config errors.
- [x] Run focused Vitest tests and TypeScript build. Full repository test run was attempted; unrelated/pre-existing failures are documented in the task report.
- [x] Review changes, preserve unrelated changes, update CHANGELOG/package version. Do not commit because the working tree contains unrelated staged and unstaged changes.
- [x] Report final outcomes, changed files, remaining runtime setup, and whether live behavior was verified. Build and focused regression suites pass; full `verify:all` invocation timed out, so full repository verification is not claimed.

## Implementation Notes
- Implementation was performed in the active Superagent workspace. No subagent delegation was used.
- Tunnel lifecycle lives in `src/core/mcp/tools/remoteAgentMcpTools.ts` and is wired through `src/core/mcp/superagentMcpServer.ts`.
- Muse Telegram send reuses `RemoteAgentConfig`, `MuseClient.sendEnvelope`, and the `chat` envelope defined in `src/core/remoteAgent/protocol.ts`; it does not use the separate Gateway Telegram bot config.
- A restart of the MCP HTTP server itself can drop the request that initiated it and rotate a quick-tunnel URL. The added restart action targets the Muse WebSocket tunnel, not the MCP HTTP server.

## Acceptance Criteria
- MCP exposes existing safe status and properly gated start/restart operations for the Muse tunnel.
- Restart affects only the verified Muse WebSocket service; it does not stop the MCP HTTP server or unrelated tunnels.
- MCP can send an explicit message to Muse using Muse's own configured Telegram bot/group and reports success only when Telegram accepts the envelope.
- No secret is included in tool output or logs; missing configuration returns actionable guidance.
- Automated tests mock tunnel and Telegram I/O; no real user message is sent.
- Tests/build results are reported accurately; unrelated user modifications remain intact.