# Adaptive MCP Tool Runtime — Implementation Tracker
Date: 2026-10-22
Workspace: SuperAgent T3 (main)
Status: P0 registry + connection recovery hardening implemented; P1 lexical intent discovery and default compact MCP gateway implemented (full is an explicit compatibility mode); P2 lightweight execution metrics started. Embedding-based semantic ranking remains future work.

## Shipped in this change
- MCP tool registry changes bump `toolRegistryVersion` so existing Agents invalidate cached catalogs.
- Remote MCP tools are exposed to Superagent/single + extension tier, not automatically to Master or specialist Subagents.
- Remote `tools/list` discovery follows cursor pagination (50-page safety cap; duplicate names deduplicated).
- MCP client's `notifications/tools/list_changed` handler queues catalog refresh per server without restarting other servers.
- Selective refresh method `refreshMcpServerTools(serverName)`, exposed as `manage_mcp({action:"refresh",name:"..."})`.
- Stale cached remote tool closures reject execution if tool removed or server disconnected.
- MCP unregister cleanup removes only remote tool objects, preserving built-in tools despite naming collisions.
- `list_tools({intent:"audit checkout and commit",limit:8})` provides bounded, intent-aware *lexical* ranking from authorized catalog. Unlike embedding retrieval, no semantic model is involved.
- Agent discovery descriptions/prompt guidance updated without changing explicit `query` behavior.

## 2026-10-22 continuation: MCP lifecycle and observability
- Unexpected stdio/HTTP disconnect retires only tools owned by that connection; another server's tools are not touched.
- Reconnect uses per-server bounded exponential backoff (1, 2, 4, 8, 16 seconds; at most 5 retries); timers do not hold the CLI process open.
- HTTP OAuth auto-reconnect is disabled by default to avoid repeatedly opening authorization windows; opt-in with `autoReconnect: true`.
- `manage_mcp({action:"reconnect",name:"server"})` forces a reconnect for one server, while `refresh` only resynchronizes tools.
- `manage_mcp({action:"list"})` includes pending retry counts, and `manage_mcp({action:"stats",name:"server"})` gives bounded per-tool counts/failures/average and last duration without storing inputs or results.
- Registered remote tool ownership is tracked by object identity, preventing cleanup of unrelated tools with equal names.
- Registry refresh, cleanup and registration pass through a shared asynchronous mutation queue.
- In-flight reconnects are fenced against server shutdown/initialization generations.
- Structured MCP output is retained as JSON text alongside text content; image binary transport remains unsupported by the text-only internal Tool interface.

### Usage
```ts
manage_mcp({ action: "reconnect", name: "context7" });
manage_mcp({ action: "refresh", name: "context7" });
manage_mcp({ action: "stats", name: "context7" });
```

## 2026-10-22 continuation: default compact MCP gateway
- New external MCP gateway tools:
  - `superagent_tool_search`: bounded keyword / natural-language lexical capability search over the **current authorized** catalog.
  - `superagent_tool_describe`: full input schema of one currently authorized target.
  - `superagent_tool_execute`: explicitly permission-gated target invocation; reuses the **same** MCP call handler, including OAuth scopes, project grants, safety guards, allowlist and activity audit. Nested gateway execution is blocked.
  - `superagent_tool_status`: restricted gateway status (exposes no hidden tool names).
- Enable compact MCP catalog with `superagent mcp use gateway` or `/mcp use gateway` (saved to `~/.superagent-r/mcp-tool-exposure.json`), `SUPERAGENT_MCP_TOOL_EXPOSURE=gateway` (environment override), or `createSuperagentMcpServer({toolExposure:"gateway"})` / `startMcpHttpServer({...,toolExposure:"gateway"})`. Restart the MCP server for new sessions to pick up the selected mode.
- Gateway is the default when no explicit saved mode or environment override exists. Explicitly saved `full` and `SUPERAGENT_MCP_TOOL_EXPOSURE=full` remain supported. In gateway mode `tools/list` returns only the four authorized gateway endpoints.
- Gateway execute is available in read-only sessions but can dispatch only authorized safe targets. The target's original checks enforce write/admin scopes and dangerous-tool allowlists. Gateway execute is marked potentially mutating for MCP client approvals.
- The gateway does **not** implement privilege elevation; clients still need appropriate OAuth scopes, workspace permissions, and dangerous-tool approval.
- Dashboard/T-Line autocomplete: `/mcp use` branches to a dedicated `MCP_USE_SUGGESTIONS` list (`gateway`, `full`, `status`). Keyword and trailing-space matching, case-insensitive Tab completion, and separation from `/mcp tunnel` are verified by `tests/mcpUseSuggestions.test.ts`.
- Keyword/intent ranking is **lexical with synonyms**, not embedding-based semantic retrieval yet.
- Tests: `tests/mcpToolGateway.test.ts`, `tests/mcpGatewayHttp.test.ts` (SDK-level and actual Streamable HTTP).

### Example MCP gateway use
```json
{"name":"superagent_tool_search","arguments":{"intent":"audit checkout and commit","limit":6}}
{"name":"superagent_tool_describe","arguments":{"name":"superagent_get_workspace"}}
{"name":"superagent_tool_execute","arguments":{"name":"superagent_get_workspace","arguments":{}}}
```
Read-only clients can execute authorized safe targets through the gateway; write/admin operations require their original privileges and gateway execution never elevates permissions.

## Verification
- Test coverage: `tests/mcpRemoteClient.test.ts`, `tests/mcpIntentDiscovery.test.ts`, `tests/mcp.test.ts` and discovery/provider/system prompt test suites.
- TypeScript `bun --bun x tsc --noEmit --pretty false`.
- Track baseline dirty working tree; do not overwrite unrelated changes.

## Remaining phases
### P0 follow-up
- Completed: server disconnect/reconnect lifecycle with bounded retry/backoff and proactive stale-catalog removal.
- Explicit role + capability allowlist for assigning selected read-only MCP tools to master and specialist subagents.
- Completed: serialized registry reconciliation across concurrent server notifications; continue stress testing high concurrency.
- Harden name-collision handling, client identity, tool-scoped audit and execution permissions.
- Partially complete: structured MCP output retained in text adapter; image/blob handles and typed error propagation still needed.

### P1
- True semantic/embedding ranking as optional provider with lexical fallback.
- Short-lived core schemas and query-specific tool selection without repeated `describe_tool` loops.
- Completed: opt-in external MCP gateway with stable search/describe/execute/status entrypoints, restricted by existing permissions.
- MCP large-output streaming/paging and per-call context budgets.

### P2
- Partially complete: per-tool MCP call count/latency/failures; discovery hit rate, tools-per-task and token usage still pending.
- RMemory preference feedback (never as an authorization source).
- Stress and soak testing on multiple unstable MCP servers, OAuth refresh and shutdown paths.

## Safety
- Tool discovery only reveals authorized tools; it does not grant execution permission.
- Master/subagent external MCP access remains disabled by default pending explicit capability policy.
- Keep changes on main limited to files listed by the focused diff; avoid unrelated WIP.
