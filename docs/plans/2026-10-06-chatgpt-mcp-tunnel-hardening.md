# ChatGPT-Compatible MCP Tunnel Hardening Implementation Plan

> **For implementer:** Execute this plan task-by-task, running the verification command after every source change.

**Goal:** Extend `/muse tunnel start --mcp` so it remains compatible with generic MCP clients while supporting ChatGPT's remote MCP authentication and session lifecycle requirements.

**Architecture:** Keep the existing Cloudflare quick tunnel and `/mcp` Streamable HTTP endpoint. Add two explicit authentication modes: `static-bearer` for backward compatibility and `oauth` for ChatGPT. Replace the singleton stateful transport with a per-session registry, then add defense-in-depth request validation, safe logging, and MCP tool metadata.

**Tech Stack:** Node.js, TypeScript, `@modelcontextprotocol/sdk` Streamable HTTP transport, Cloudflare `cloudflared`, Vitest/Bun tests, SQLite/JSON project configuration.

---

## Current baseline

- `src/core/mcp/mcpHttpTransport.ts` exposes `/mcp` and uses one stateful transport for the whole server.
- `src/core/mcp/mcpTunnel.ts` publishes `https://*.trycloudflare.com/mcp` and creates a transient Bearer token.
- Static Bearer auth and safe-tool allowlisting work; focused MCP tests currently pass.
- ChatGPT compatibility is incomplete because OAuth discovery, per-session routing, Origin/Host validation, and safe argument logging are missing.
- Preserve the existing static-Bearer path; do not silently change its behavior.

## Task 1: Freeze the compatibility contract and record the design decision

**Files:**
- Modify: `docs/wiki/07-adrs-and-decisions.md`
- Test: `tests/mcpHttpTransport.test.ts`

**Steps:**

1. Add an ADR defining the supported modes: `static-bearer` and `oauth`.
2. Document that `/mcp` remains the canonical endpoint and that OAuth metadata endpoints are public discovery endpoints.
3. Document the security boundary: the tunnel is public; authorization, session ownership, and tool authorization happen in the MCP server.
4. Record the ChatGPT acceptance target: OAuth 2.1 authorization-code + PKCE, protected-resource metadata, authorization-server metadata, and `WWW-Authenticate` challenges.
5. Run the focused baseline tests:

   `clov bun test tests/mcpHttpTransport.test.ts tests/mcpTunnelState.test.ts`

6. Commit the ADR and baseline test adjustments if any:

   `clov git add docs/wiki/07-adrs-and-decisions.md tests/mcpHttpTransport.test.ts && clov git commit -m "docs: define MCP ChatGPT compatibility contract"`

**Acceptance:** The ADR makes the two auth modes, backward-compatibility promise, and OAuth scope explicit.

## Task 2: Add an authentication abstraction and OAuth state store

**Files:**
- Create: `src/core/mcp/mcpAuth.ts`
- Create: `src/core/mcp/mcpOAuthStore.ts`
- Test: `tests/mcpAuth.test.ts`
- Test: `tests/mcpOAuthStore.test.ts`

**Steps:**

1. Define typed auth interfaces for request authorization, identity, challenge headers, and auth mode.
2. Move the existing constant-time static Bearer comparison behind the abstraction.
3. Implement an in-memory OAuth store for pending authorization requests, authorization codes, refresh/access token records, client registrations, expiry, and one-time use.
4. Generate all codes and tokens with `crypto.randomBytes`; store hashes where possible; never persist the static token, authorization code, or access token.
5. Implement PKCE S256 verification and reject missing, expired, reused, or mismatched `state`, `code_verifier`, redirect URI, and client ID values.
6. Return a standards-shaped Bearer challenge for unauthenticated MCP requests, including the protected-resource metadata URL.
7. Write failing tests for constant-time static auth, expired tokens, code replay, PKCE mismatch, and challenge headers.
8. Run:

   `clov bun test tests/mcpAuth.test.ts tests/mcpOAuthStore.test.ts`

9. Commit:

   `clov git add src/core/mcp/mcpAuth.ts src/core/mcp/mcpOAuthStore.ts tests/mcpAuth.test.ts tests/mcpOAuthStore.test.ts && clov git commit -m "feat: add MCP static and OAuth authentication primitives"`

**Acceptance:** Auth decisions are typed, testable, constant-time where applicable, and no credential is written to disk or logs.

## Task 3: Implement OAuth discovery and authorization endpoints

**Files:**
- Create: `src/core/mcp/mcpOAuthRoutes.ts`
- Modify: `src/core/mcp/mcpHttpTransport.ts`
- Modify: `src/core/mcp/mcpTunnel.ts`
- Test: `tests/mcpOAuthRoutes.test.ts`

**Steps:**

1. Add `GET /.well-known/oauth-protected-resource` with the canonical public MCP resource URL and authorization-server URL.
2. Add `GET /.well-known/oauth-authorization-server` with authorization endpoint, token endpoint, supported `S256`, redirect URI policy, and supported scopes.
3. Add the authorization endpoint with a minimal owner-consent page. Require a one-time bootstrap approval code printed only when OAuth mode starts; store only its hash.
4. Add the token endpoint for authorization-code exchange and refresh-token rotation if refresh tokens are enabled.
5. Add optional dynamic client registration only if the current OpenAI integration contract requires it; otherwise support the documented client metadata flow and keep registration closed by default.
6. Ensure discovery endpoints never require the MCP access token, while token and tool requests do.
7. Use the public tunnel URL as the canonical resource URL; reject ambiguous host/path values.
8. Add tests for discovery JSON, PKCE success/failure, owner approval, authorization-code replay, expired metadata, and malformed redirect URIs.
9. Run:

   `clov bun test tests/mcpOAuthRoutes.test.ts tests/mcpAuth.test.ts tests/mcpOAuthStore.test.ts`

10. Commit:

   `clov git add src/core/mcp/mcpOAuthRoutes.ts src/core/mcp/mcpHttpTransport.ts src/core/mcp/mcpTunnel.ts tests/mcpOAuthRoutes.test.ts && clov git commit -m "feat: expose MCP OAuth discovery and authorization routes"`

**Acceptance:** A standards-compliant MCP client can discover the OAuth server, complete PKCE, receive an access token, and use it on `/mcp`.

## Task 4: Replace the singleton transport with a per-session registry

**Files:**
- Create: `src/core/mcp/mcpSessionRegistry.ts`
- Modify: `src/core/mcp/mcpHttpTransport.ts`
- Test: `tests/mcpSessionRegistry.test.ts`
- Test: `tests/mcpHttpTransport.test.ts`

**Steps:**

1. Define a registry keyed by `mcp-session-id`, storing the transport, MCP server, auth identity, creation time, last activity, and cleanup timer.
2. For an initialization POST without a session ID, create a new transport/server pair and register it as soon as the SDK assigns the session ID.
3. Route every subsequent POST, GET, and DELETE through the matching session transport.
4. Return MCP-compliant 400/404 responses for missing or unknown session IDs instead of routing to a global transport.
5. Close and remove sessions on DELETE, transport close, idle timeout, and server shutdown.
6. Add bounded limits for maximum concurrent sessions and maximum session lifetime; expose safe configuration defaults without using forbidden model/settings environment variables.
7. Ensure one session cannot access another session's transport or authorization identity.
8. Test two simultaneous sessions, reconnect using the same ID, invalid IDs, DELETE cleanup, idle cleanup, and shutdown cleanup.
9. Run:

   `clov bun test tests/mcpSessionRegistry.test.ts tests/mcpHttpTransport.test.ts`

10. Commit:

   `clov git add src/core/mcp/mcpSessionRegistry.ts src/core/mcp/mcpHttpTransport.ts tests/mcpSessionRegistry.test.ts tests/mcpHttpTransport.test.ts && clov git commit -m "fix: isolate MCP HTTP state per session"`

**Acceptance:** Two clients can initialize and call tools concurrently; reconnects remain valid; unknown sessions are rejected; no singleton transport remains.

## Task 5: Add Origin, Host, method, and request-size defense-in-depth

**Files:**
- Modify: `src/core/mcp/mcpHttpTransport.ts`
- Modify: `src/core/mcp/mcpTunnel.ts`
- Test: `tests/mcpSecurity.test.ts`

**Steps:**

1. Validate `Host` against the local listener and configured public tunnel host; reject unexpected hosts.
2. Validate `Origin` when present against an explicit allowlist; allow server-to-server requests with no Origin only where the MCP deployment mode permits it.
3. Keep POST content type and Accept checks delegated to the SDK, but add clear error responses for invalid body size, malformed JSON, unsupported methods, and wrong paths.
4. Make the allowed-origin/host policy explicit in `McpHttpServerOptions`; pass the public hostname from `mcpTunnel.ts` after the tunnel URL is known.
5. Ensure validation runs before auth and before creating a session.
6. Test valid/invalid Origin, valid/invalid Host, oversized bodies, unsupported methods, wrong path, and unauthorized requests.
7. Run:

   `clov bun test tests/mcpSecurity.test.ts tests/mcpHttpTransport.test.ts`

8. Commit:

   `clov git add src/core/mcp/mcpHttpTransport.ts src/core/mcp/mcpTunnel.ts tests/mcpSecurity.test.ts && clov git commit -m "fix: harden MCP tunnel request validation"`

**Acceptance:** Public requests cannot bypass host/origin policy or allocate sessions before validation.

## Task 6: Add ChatGPT-friendly tool metadata and authorization semantics

**Files:**
- Modify: `src/core/mcp/superagentMcpServer.ts`
- Modify: `src/core/mcp/mcpHttpTransport.ts`
- Test: `tests/mcpServer.test.ts`
- Test: `tests/mcpChatgptCompatibility.test.ts`

**Steps:**

1. Add MCP tool annotations based on the existing safe/dangerous classification: `readOnlyHint`, `destructiveHint`, and `idempotentHint` only where behavior is accurate.
2. Add per-tool `securitySchemes` metadata for anonymous/read-only versus OAuth-protected actions according to the selected auth mode.
3. Preserve the safe allowlist as the default; keep dangerous tools opt-in and require OAuth mode for ChatGPT write access.
4. Return stable, actionable tool descriptions and structured error text for denied tools.
5. Add tests confirming safe tools advertise read-only behavior, dangerous tools are hidden by default, and auth-protected tools do not execute without a valid identity.
6. Run:

   `clov bun test tests/mcpServer.test.ts tests/mcpChatgptCompatibility.test.ts`

7. Commit:

   `clov git add src/core/mcp/superagentMcpServer.ts src/core/mcp/mcpHttpTransport.ts tests/mcpServer.test.ts tests/mcpChatgptCompatibility.test.ts && clov git commit -m "feat: add MCP tool metadata for ChatGPT approvals"`

**Acceptance:** ChatGPT can distinguish read-only and mutating tools, and dangerous operations remain explicitly gated.

## Task 7: Redact MCP audit and diagnostic logging

**Files:**
- Create: `src/core/mcp/mcpLogSanitizer.ts`
- Modify: `src/core/mcp/mcpHttpTransport.ts`
- Modify: `src/core/mcp/superagentMcpServer.ts`
- Test: `tests/mcpLogSanitizer.test.ts`

**Steps:**

1. Add recursive redaction for keys and values matching authorization, token, secret, password, API key, cookie, credential, and private-key patterns.
2. Replace full raw tool arguments in both audit and diagnostic logs with sanitized, bounded summaries.
3. Include safe metadata such as tool name, success, duration, session hash, and argument shape; never include access tokens or complete file contents.
4. Ensure logging failures cannot break MCP request handling.
5. Add tests for nested secrets, long file content, command arguments, malformed/circular values, and audit-log durability.
6. Run:

   `clov bun test tests/mcpLogSanitizer.test.ts tests/mcpHttpTransport.test.ts`

7. Commit:

   `clov git add src/core/mcp/mcpLogSanitizer.ts src/core/mcp/mcpHttpTransport.ts src/core/mcp/superagentMcpServer.ts tests/mcpLogSanitizer.test.ts && clov git commit -m "fix: redact sensitive MCP audit data"`

**Acceptance:** Representative tool calls cannot place bearer tokens, credentials, or full sensitive payloads in MCP logs.

## Task 8: Extend CLI and tunnel UX without breaking existing clients

**Files:**
- Modify: `src/core/commands/museTunnelSubcommand.ts`
- Modify: `src/core/commands/museCommand.ts`
- Modify: `src/utils/dashboardSuggestions.ts`
- Modify: `README.md`
- Test: `tests/mcpTunnelState.test.ts`
- Test: `tests/cloudflareTunnel.test.ts`

**Steps:**

1. Add explicit flags such as `--mcp-auth static-bearer|oauth`, keeping static Bearer as the default for backward compatibility.
2. Make `--allow-dangerous` invalid or strongly warned in static-Bearer mode; require OAuth mode plus explicit confirmation for ChatGPT write access.
3. Print mode-specific setup output: endpoint, metadata URL, scope, one-time OAuth approval instructions, and the static config snippet only in static mode.
4. Never print access tokens after the initial one-time display; never persist them in tunnel state files.
5. Add status output showing auth mode, active session count, safe/full tool mode, and metadata availability without secrets.
6. Update command help, autocomplete, README setup instructions, and troubleshooting guidance.
7. Test both modes, restart/stop behavior, cross-workspace listing, and old static-Bearer output compatibility.
8. Run:

   `clov bun test tests/mcpTunnelState.test.ts tests/cloudflareTunnel.test.ts`

9. Commit:

   `clov git add src/core/commands/museTunnelSubcommand.ts src/core/commands/museCommand.ts src/utils/dashboardSuggestions.ts README.md tests/mcpTunnelState.test.ts tests/cloudflareTunnel.test.ts && clov git commit -m "feat: expose MCP auth modes in tunnel commands"`

**Acceptance:** Existing static-Bearer users continue to work, while OAuth mode gives a complete ChatGPT setup path without leaking secrets.

## Task 9: Add protocol-level and manual ChatGPT verification

**Files:**
- Create: `tests/mcpChatgptCompatibility.test.ts`
- Modify: `README.md`

**Steps:**

1. Add an end-to-end local test covering discovery, PKCE, initialize, tools/list, tools/call, reconnect, and DELETE.
2. Add a negative test proving invalid Origin, invalid token, invalid session, expired token, and dangerous tool calls are rejected.
3. Run the MCP-focused suite:

   `clov bun test tests/mcpAuth.test.ts tests/mcpOAuthStore.test.ts tests/mcpOAuthRoutes.test.ts tests/mcpSessionRegistry.test.ts tests/mcpSecurity.test.ts tests/mcpChatgptCompatibility.test.ts tests/mcpHttpTransport.test.ts tests/mcpTunnelState.test.ts`

4. Start a real OAuth tunnel in a disposable workspace and run MCP Inspector against the public `/mcp` URL.
5. In ChatGPT Developer Mode/custom MCP app, create a draft app using the public `/mcp` URL, complete authorization, scan tools, and call one safe read-only tool.
6. Verify that a denied dangerous tool produces a clear approval/auth error and does not execute.
7. Document the exact manual test date, plan limitation, endpoint mode, and observed result in README troubleshooting.

**Acceptance:** Automated protocol tests pass and a real ChatGPT scan plus one safe tool call succeeds.

## Task 10: Release hygiene and final verification

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/wiki/07-adrs-and-decisions.md`

**Steps:**

1. Bump the package version from `1.6.2` to the next feature version, expected `1.7.0` unless the repository release policy chooses another version.
2. Add a changelog entry covering OAuth mode, per-session transport, validation, tool metadata, and redacted logging.
3. Run the required build immediately after source changes:

   `clov bun run build`

4. Run the focused MCP suite and confirm the expected pass count:

   `clov bun test tests/mcpAuth.test.ts tests/mcpOAuthStore.test.ts tests/mcpOAuthRoutes.test.ts tests/mcpSessionRegistry.test.ts tests/mcpSecurity.test.ts tests/mcpChatgptCompatibility.test.ts tests/mcpHttpTransport.test.ts tests/mcpTunnelState.test.ts`

5. Run the full suite:

   `clov bun test`

6. Compare full-suite failures with the pre-change baseline. Do not claim the repository is green if unrelated baseline failures remain; document them separately.
7. Verify no credentials, temporary files, or generated probe artifacts are tracked:

   `clov git status --short`

8. Commit release files:

   `clov git add package.json CHANGELOG.md README.md docs/wiki/07-adrs-and-decisions.md && clov git commit -m "feat: harden MCP tunnel for ChatGPT"`

**Acceptance:** Build succeeds, focused MCP compatibility tests pass, full-suite status is reported honestly, documentation matches behavior, version/changelog are updated, and the worktree is clean.

## Definition of done

- Static Bearer mode remains backward compatible for generic MCP clients.
- OAuth mode exposes protected-resource and authorization-server discovery.
- ChatGPT completes OAuth PKCE and can scan/call approved tools.
- Multiple MCP sessions are isolated and reconnect safely.
- Origin/Host/request validation runs before session creation and tool execution.
- Safe/dangerous tool metadata and allowlisting are enforced consistently.
- Audit and diagnostic logs redact credentials and sensitive payloads.
- Build, focused tests, manual ChatGPT verification, versioning, changelog, and commits are complete.

