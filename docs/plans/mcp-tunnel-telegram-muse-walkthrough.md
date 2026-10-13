# Walkthrough: MCP Tunnel Controls and Telegram-to-Muse

Date: 2026-10-13
Package version: 1.13.73

## Implemented

- Added `src/core/mcp/tools/remoteAgentMcpTools.ts` with three MCP actions:
  - `superagent_muse_tunnel_start`
  - `superagent_muse_tunnel_restart`
  - `superagent_telegram_send_to_muse`
- Wired their definitions, dispatch, and tool classifications into `src/core/mcp/superagentMcpServer.ts`.
- Classified all three as dangerous so they require explicit dangerous-tool enablement; tests assert they are absent from the default-safe list.
- Tunnel management checks service kind and local target before changing state, uses the existing Muse watcher/tunnel lifecycle, avoids duplicate watcher creation when an existing verified Muse tunnel is active, and does not return WebSocket or Telegram credentials.
- Telegram sending uses Muse's saved `botToken`, `groupId`, and `museBotId`, then uses the existing `MuseClient.sendEnvelope()` chat-envelope route. A success response means Telegram accepted the envelope, not that Muse processed it.
- Added mocked tests in `tests/remoteAgentMcpTools.test.ts` and adjusted MCP catalog tests in `tests/mcpServer.test.ts`.
- Updated the existing MCP tool-count constant and expected count to 56, matching the tool catalog after disabled MCP control tools are filtered.
- Updated `tests/mcpInstanceTask.test.ts` to assert that `superagent_manage` is hidden/rejected, reflecting the existing MCP disable policy in this working tree.
- Bumped `package.json` version to 1.13.73 and added a changelog entry.
- Stored this plan, task checklist, and walkthrough in `docs/plans/`. Removed temporary root-level plan/task files after they were found to affect unrelated plan-state and CLI bridge tests.

## Verification

- `bun run build`: passed.
- `bun run verify:extension-js`: passed; 8 extension JavaScript files checked.
- Focused MCP/tunnel/Telegram regression suites: 5 files, 39 tests passed.
- Broader affected suites: 6 files, 98 tests passed (including plan-state and CLI bridge tests after moving plan artifacts out of the repository root).
- `git diff --check`: passed; Git emitted only line-ending normalization warnings.
- Full `bun run verify:all`: invocation timed out before a final result could be returned. Full-repository verification is therefore not claimed.
- No live Telegram message was sent and no live tunnel start/restart was performed.

## Working-tree Notes

At final inspection, HEAD was `af8985d6` (`feat(mcp): add mcp-agentic-tooling skill, agentic prompt & resource, and remote agent tools (v1.13.73)`) and the working tree was clean. That commit contains this feature together with other MCP agentic-tooling changes already present in the workspace; it was not created through a separate explicit commit action in this run.
