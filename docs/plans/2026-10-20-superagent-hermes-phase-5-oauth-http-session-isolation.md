# Hermes Phase 5 — OAuth HTTP Session Isolation and Token Lifecycle

Date: 2026-10-20
Status: Implemented with live loopback HTTP/MCP integration tests; public cloud tunnel staging remains open.
Parent: docs/plans/2026-10-20-superagent-hermes-phase-5-oauth-tool-scope-hardening.md
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md

## Confirmed vulnerabilities

1. MCP sessions were validated against OAuth client_id rather than the exact credential. Two different tokens from the same OAuth client, including a read-scoped token and a write-scoped token, could reuse the same initialized transport. The underlying tool server captured the original token identity during session initialization, creating a possible privilege mismatch.
2. DELETE /mcp with mcp-session-id removed a session before checking credential binding. An authenticated client could therefore terminate another client's session when it learned the session ID.
3. Valid but scope-less OAuth tokens could still discover/read safe MCP tools, despite the published mcp:tools scope requirement.

## Implemented guards

- Sessions are bound to authentication mode, principal identity and exact SHA-256 credential hash. Token refresh or reauthorization requires initializing a fresh MCP session. A different token cannot call tools or DELETE the original session, including a token from the same client.
- DELETE validates the current access token and its session binding before removing a session. Unknown sessions remain 404; foreign sessions 403; revoked/expired credentials 401.
- OAuth tools/list exposes no tools without an effective read scope. Safe tool calls require mcp:tools, the existing mcp:tools:read compatibility grant, or mcp:tools:write. Dangerous tools still require the explicit mcp:tools:write grant independent of YOLO or local allowDangerous.
- The allowlist, disabled tools, workspace restrictions and external project grants remain independent safety gates. This does not add privileged approval or alter static bearer mode.

## Live loopback acceptance

tests/mcpOAuthHttpE2E.test.ts exercises actual HTTP requests to an ephemeral loopback MCP server using real PKCE S256 authorization, owner consent and token issuance. It covers:

- Two separately registered OAuth clients with independent session IDs; foreign session DELETE returns 403 without breaking the owner session.
- Two tokens for the SAME OAuth client carrying different read/write scopes; cross-token session reuse and DELETE fail closed.
- Read-only token discovers only read-capable tools, cannot write, and never persists denied file content in the audit log.
- Revocation of an access token immediately returns 401 at the HTTP boundary while a separate valid token remains usable.
- Refresh-token rotation, rejected refresh replay and mandatory reinitialization of MCP session for a new access token.
- Token resource / audience mismatch rejection.

Other tests cover zero-scope tool discovery/dispatch and backwards-compatible read-scope metadata. Targeted TypeScript build, extension and wiki validation should pass prior to release.

## Open production gates

The tests target a real loopback HTTP server but not the Cloudflare/OpenAI public tunnel; cross-network proxies, live identity issuer integration, durable grants across server restarts, network failure/recovery, interactive privileged approval and production rollout need separate acceptance. Token refresh continues to leave an earlier *unexpired* access token valid unless explicitly revoked; this follows existing store semantics and is not implicit access-token revocation.

## Verified local acceptance — 2026-10-20

- TypeScript build passed.
- Extension JS verification passed (8 files), and wiki validation passed (9 documents, 24 links).
- Focused MCP OAuth, HTTP transport, OAuth routes, YOLO, compatibility and server suites: 87 passed across 6 suites (prior to the final refresh-rotation test addition); the dedicated HTTP/YOLO test rerun passed 19/19.
- Full bunx vitest run --reporter=default --maxWorkers=3: **exit 0; 387 suites passed, 1 skipped; 3,648 tests passed, 5 skipped; 0 failed**.
- Focused and full counts overlap, not additive.
- Only local HTTP OAuth behavior was exercised. Real Cloudflare/OpenAI tunnel, multi-host deployment and production approval flows remain open.
