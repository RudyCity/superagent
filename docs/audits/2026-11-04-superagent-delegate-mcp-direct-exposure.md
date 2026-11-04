# SuperAgent Delegate direct MCP exposure — implementation audit

## Root cause

The four `delegate.*` definitions lived only inside the single-agent
`delegateToolset` (T-Line and Chrome extension chat), which is separate
from `MCP_TOOL_DEFINITIONS`. Therefore `superagent_tool_search` through
the ChatGPT-connected siplah MCP server returned no Delegate tools.
Moreover, the Chrome WebSocket client is owned by the HTTP Core process,
not necessarily the MCP server process; duplicating the bridge would
conflict over port 17341 and disrupt pairing.

## Implementation

- `src/core/mcp/tools/delegateMcpTools.ts`: four strictly validated MCP
  entrypoints, fixed loopback target, host bearer auth, single dispatch,
  response/error propagation, timeout uncertainty, no retry, audit redaction.
- `src/core/mcp/superagentMcpServer.ts`: register and dispatch tools
  through existing authorization, audit and OAuth/YOLO gates.
- `src/core/mcp/mcpToolPolicy.ts`: read safe; create/send/stop dangerous.
- `src/core/mcp/mcpToolGateway.ts`: eagerly advertise only authorized
  Delegate entries in the compact gateway catalog.
- `src/serverRoutes.ts`: private local authenticated HTTP route calling
  the existing host-owned `delegateReadChatTool`, etc. The outer Core
  bearer gate protects the route; it additionally requires local socket,
  loopback Host, no Origin header, POST, bounded JSON, known method and
  validated arguments. No arbitrary URL forwarding.
- `src/core/mcp/mcpActivityBus.ts`: redact outgoing message text and
  ChatGPT responses from activity events and JSONL logs, including
  nested `superagent_tool_execute` calls.

## Security rules

1. No `mcp:tools:write` => mutation tools neither discoverable nor callable.
2. Local YOLO OFF => mutation tools denied even with OAuth write scope.
3. Restricted safe-owner MCP retains its own limited allowlist.
4. No chat message content in connection audit, MCP activity or onToolCall.
5. Local host/credential boundaries remain; no separate Chrome connection.
6. A timeout does not prove a message was not sent; mutation is not retried.

## Verification and activation

Unit tests:
- `tests/delegateMcpExposure.test.ts`
- `tests/delegateMcpHostRoute.test.ts`
- updated gateway catalog, HTTP gateway and MCP server integration tests.

No live ChatGPT message was sent during this change.
A new Core HTTP route cannot be hot-loaded into an existing running
`dist/cli.js --server 7888` process. Refresh the built Core server and
MCP connector session to activate, with deliberate Chrome re-pairing if
using the default ephemeral server secret. Do not claim live MCP tool
availability before the new server and connector sessions are verified.

## Tests and build (verified 2026-11-04)

- `bun run verify:delegate`: **PASS**, eight suites, **87/87 tests**,
  including direct MCP argument and OAuth cases and authenticated Core
  host-dispatch guards.
- `bun --bun x vitest run tests/mcpServer.test.ts tests/mcpToolGateway.test.ts
  tests/mcpGatewayHttp.test.ts tests/mcpSafeOwnerR1.test.ts
  tests/mcpYoloPermissionMatrix.test.ts`: **PASS**, 5 suites,
  **39/39 tests**.
- `bun run build`: **PASS**, TypeScript and MCP schema sync.
- Dedicated tests verify the MCP activity bus does not retain outgoing
  message text, returned ChatGPT chat content or nested gateway payloads.
- Production connector tool discovery **not claimed** until a rebuilt Core
  and MCP tunnel process have been restarted and the connector reconnects.
