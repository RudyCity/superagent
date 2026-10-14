# Google Gemini MCP Connector Compatibility and Remote MCP Client Plan

**Date:** 2026-10-14
**Scope:** Fix inbound Gemini/Gemini Spark connection to SuperAgent MCP, improve diagnosis of OAuth failures, and add outbound remote HTTP MCP client support without breaking existing stdio clients.

## Context and verified baseline

- SuperAgent exposes a Streamable HTTP MCP endpoint at `/mcp` and has OAuth protected-resource metadata, authorization-server metadata, DCR, PKCE S256, authorization-code exchange, and refresh-token rotation.
- Initial live endpoint probe found `HEAD /mcp` returned HTTP 405, while root OAuth metadata returned HTTP 200 and unauthenticated POST returned HTTP 401 with `WWW-Authenticate`.
- Implemented local protocol behavior now returns 401 plus `WWW-Authenticate` and no body for unauthenticated HEAD; authenticated HEAD returns 204 and does not create a session. Both root and path-specific protected-resource metadata routes are covered by tests.
- `McpManager.ts` now supports existing stdio MCP clients and outgoing Streamable HTTP clients, optional SDK OAuth, encrypted per-server credential persistence, and a loopback state-checked OAuth callback.
- Added credential-safe lifecycle diagnostics and bounded log rotation; added local HTTP MCP client tests for connect/list/call/close, missing auth, and conflicting Authorization/OAuth configuration.
- The live MCP tunnel still runs in an existing process. Local source/build tests do not prove that this process has loaded the changes or that an interactive Gemini account-linking flow succeeds.

## Goals

1. Make the inbound MCP endpoint discoverable by clients that probe with HEAD while preserving the existing bearer/OAuth behavior and never executing tools during a probe.
2. Support both the root RFC 9728 resource metadata endpoint and path-specific `/.well-known/oauth-protected-resource/mcp` metadata route.
3. Add safe, structured OAuth lifecycle diagnostics that make it clear where Gemini stops (discovery, registration, authorization, token exchange, MCP initialize, tools/list), without writing tokens, authorization codes, client secrets, PKCE verifiers, or OAuth state values to logs.
4. Extend outgoing MCP client configuration to support stdio and Streamable HTTP without regressing existing stdio configurations.
5. Use the official MCP SDK's OAuth client/provider API for remote OAuth. Make interactive authentication explicit: remote HTTP servers that require OAuth must provide a documented callback/authorization handoff and persistent client state; do not silently pretend they are connected when authorization is pending.
6. Add focused tests, configuration documentation, and an end-to-end verification checklist. Do not claim Google Gemini compatibility until a real Gemini client connection is verified.

## Implementation tasks

### A. Inbound Google/Gemini compatibility
- [x] Add a HEAD probe handler with an authentication challenge and no session/tool dispatch.
- [x] Add regression tests for HEAD response status, challenge headers, and empty body.
- [x] Test both root and path-specific protected-resource metadata URLs.
- [x] Preserve Host/Origin checks and public OAuth discovery routing.

### B. OAuth traceability and security
- [x] Add structured, sanitized OAuth lifecycle events for discovery, DCR, authorization, token endpoint, MCP initialize, tool discovery and calls.
- [x] Persist only an allow-listed stage/method/status/timing schema; do not include credentials, code, state, query string, client ID or form contents.
- [x] Make diagnostics best-effort, permission-restricted, and bounded with a 5 MiB rotation threshold.

### C. Outbound MCP HTTP clien
- [x] Extend config to backward-compatible stdio and HTTP transport variants.
- [x] Support environment-backed static headers and redact credentials from remote-client errors.
- [x] Add a transport abstraction and lifecycle cleanup for stdio/HTTP transports.
- [x] Discover, namespace, register and call remote tools through existing toolsets.
- [x] Add local tests for connect/list/call/close and incorrect/missing auth.

### D. Outbound OAuth behavior
- [x] Use the official MCP SDK HTTP transport and OAuth client-provider interfaces.
- [x] Encrypt OAuth client/token/verifier/discovery state with the existing secret store and fail closed if unreadable.
- [x] Add browser authorization with a loopback-only callback and OAuth-state validation; report pending auth instead of connected.
- [x] Add provider storage/callback tests and an automated local authorization-code flow covering discovery, DCR, consent, PKCE token exchange, reconnection and tool listing.

### E. Docs and acceptance
- [x] Document inbound Gemini setup, account/region eligibility caveats, troubleshooting and audit-stage diagnosis.
- [x] Document outbound MCP stdio/HTTP config with sanitized examples.
- [x] Extend the deterministic OAuth smoke test with HEAD, metadata, PKCE, MCP initialize, tools/list and safe tool call.
- [x] Run TypeScript build and focused/extended MCP tests.
- [x] Preserve unrelated selfdev changes in the workspace.

## Acceptance criteria

- [x] HEAD /mcp no longer returns 405 and unauthenticated probes receive authentication-discovery headers with no body.
- [x] Root and path-specific protected-resource metadata routes return valid JSON.
- [x] OAuth audit/diagnostics include stages/outcomes and omit secrets.
- [x] Existing stdio MCP configurations remain supported by the transport manager.
- [x] A configured Streamable HTTP remote MCP server connects, exposes namespaced tools, calls a tool, and disconnects cleanly in local tests.
- [x] OAuth authorization uses pending status until browser callback/token flow completes.
- [x] TypeScript build and focused/extended MCP suites pass; the legacy edit-tool fixture was updated to the current batch-only contract.
- [x] Documentation distinguishes local protocol tests from a real Gemini account-linking test.

## Verification boundary

- **Verified automatically:** build, local endpoint tests, OAuth smoke-flow, credential storage/callback tests, end-to-end local OAuth code exchange, remote HTTP connect/list/call/close.
- **Not verified yet:** a real Gemini custom Connected App linking attempt using the currently running tunnel. The Gemini UI requires an eligible account and interactive authorization, and the existing process must be restarted/reloaded before it serves this build.
