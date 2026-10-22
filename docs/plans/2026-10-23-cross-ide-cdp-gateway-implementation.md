# Cross-IDE CDP Gateway — Codex / Antigravity / SuperAgent

Implemented 2026-10-23. Source: `src/core/tools/crossIdeCdpGateway.ts`, MCP exposure: `superagent_browser_gateway`.

## Scope & security

A single SuperAgent CDP coordinator now serves separate authenticated MCP connections from Codex, Antigravity (AGY), SuperAgent, or other IDEs. Each initialized MCP connection gets its own random, session-bound actor ID (`ide-...`) and ephemeral X25519 key pair. The MCP `clientInfo.name` / optional `SUPERAGENT_CDP_IDE_LABEL` is **informational, not authenticated application identity**. Request arguments cannot override the actor ID or CDP owner token.

The transport still enforces its normal bearer/OAuth policy: this tool is classified **dangerous**, requires dangerous-tool exposure (or approved local mode), and OAuth `mcp:tools:write` scope. Gateway catalog mode discovers and invokes this tool using `superagent_tool_search`, `superagent_tool_describe`, `superagent_tool_execute`; full mode exposes `superagent_browser_gateway` directly.

For true cross-IDE coordination, point clients either to **one Streamable HTTP MCP server with distinct initialized sessions** or to local stdio MCP servers under the **same OS user and `~/.superagent-r/cdp-sessions`**. Direct stateless HTTP calls do not preserve session-local browser capability state; use persistent MCP sessions. Changes to MCP server or tool-exposure settings need reconnect/restart.

## End-to-end workflow

Each action below is a call to the `superagent_browser_gateway` MCP tool. Port defaults to 9222; `targetId` comes from discover. Tool results contain **no owner or contributor sessionToken**.

1. **Identify:** Every IDE calls `{ "action": "identity" }`. Result contains its immutable MCP connection actor ID and a display label.
2. **Discover:** `{ "action": "discover", "port": 9222 }` merges live Chrome targets with coordinator leases, participant roles, revision, and queue pressure. If Chrome is unreachable, the response reports that separately while retaining coordinator session information.
3. **Claim & share:** The first IDE calls `{ "action": "claim", "targetId": "TAB_ID" }`, then `{ "action": "share", "targetId": "TAB_ID", "enabled": true }`. Owner capability remains in server memory and is not shown in the response.
4. **Request:** AGY/Codex/another client calls `{ "action": "request_attach", "targetId": "TAB_ID", "role": "contributor" }` (or observer). This returns a `requestId` and creates a bounded, short-lived pending approval.
5. **Approve:** The owner calls `{ "action": "pending", "targetId": "TAB_ID" }` and then `{ "action": "approve_attach", "targetId": "TAB_ID", "requestId": "..." }`, or `deny_attach`.
6. **Attach without copying secrets:** The requester calls `{ "action": "poll_attach", "targetId": "TAB_ID", "requestId": "..." }`. Approval stores the one-time invitation **encrypted to the requesting MCP connection's ephemeral X25519 public key**. Only its in-memory private key can decrypt it. After successful join, the guest's CDP session token remains in that MCP server's private memory. Request file is consumed.
7. **Execute:** `{ "action": "execute", "targetId": "TAB_ID", "command": "shared_snapshot" }` returns the current revision. A shared write must explicitly supply `expectedRevision`, e.g. `{ "action": "execute", "targetId": "TAB_ID", "command": "click", "expectedRevision": 4, "payload": { "index": 2 } }`. A change by another agent invalidates the old snapshot/index and rejects stale writes.
8. **Events:** `{ "action": "events", "targetId": "TAB_ID", "cursor": 0 }` returns bounded, allowlisted activity and the next cursor. `wait_events` long-polls up to 10 seconds for changes. Only an attached participant can read a target's events.
9. **Lifecycle:** `heartbeat` renews only that participant's lease. A contributor or observer may `leave`; the owner may `release` or disable sharing via `share enabled:false`.

`execute` accepts only a bounded allowlist of page operations (snapshots, DOM reads, navigation, evaluate, click/type, screenshots, form operations, wait/verify). It never forwards arbitrary terminal commands, cookies, an arbitrary endpoint, or caller-supplied `agentId` / `sessionToken` fields. All writes are serialized by the coordinator's cross-process lock and optimistic revision check. Owner approvals are verified against the *current owner lease/generation*; transfer or expiry invalidates pending joins.

## Optional gateway-only mode

Set `SUPERAGENT_CDP_GATEWAY_ONLY=1` **on the SuperAgent MCP server process** and restart/reconnect. This blocks **direct MCP** `superagent_chrome_cdp` and `superagent_chrome_vision` tools, including calls through the compact `superagent_tool_execute` router; use `superagent_browser_gateway` instead. `{ "action": "policy" }` reports the active restriction.

**Important limitation:** This is **MCP-layer enforcement, not an operating-system firewall**. Independent software with direct access to `127.0.0.1:9222` can still bypass the coordinator; SuperAgent cannot prevent this from a separate process. Do not share the debugging port over a public network. Bind Chrome debugging to loopback, isolate the debugging browser/profile/OS user from untrusted local processes, and configure Codex/AGY to use this MCP gateway rather than their own direct CDP drivers. Unverified cross-adapter Chrome Extension writes remain fail-closed.

## Tests and verification

- `bun run build`
- `bun --bun x vitest run tests/crossIdeCdpGateway.test.ts tests/mcpCrossIdeGateway.test.ts --maxWorkers=1`
- `bun --bun x vitest run tests/chrome*.test.ts tests/mcpToolGateway.test.ts --maxWorkers=1`
- Existing cross-process queue benchmark: `bun scripts/benchmark-shared-cdp.ts --agents=10 --actions=4 --work-ms=10`.

The tests use a mock Chrome CDP endpoint and multiple independent MCP-bound gateway instances. A real Chrome desktop E2E across logged-in profiles remains required before production-critical checkout/payment automations.

## Operational notes

- Requests and sealed approvals are short-lived (max two minutes), bounded, and stored with restricted local filesystem permissions under `~/.superagent-r/cdp-sessions/gateway/requests`.
- Owner/CDP member credentials are never written there in plaintext. The owner token and guest token are in the respective MCP transport's in-memory capability map only; they disappear when the connection/server restarts.
- The authenticated MCP tunnel's ordinary OAuth/bearer and dangerous-tool permissions still apply. A shared static bearer identifies the same account but **each initialized MCP session remains a distinct gateway actor**. For different trust domains, use separate OAuth clients/scopes.
- Cross-process audit events are append-only to the existing `cdp-sessions/events.jsonl` and contain only time, event name, hashed target key prefix and actor ID, not page content.
