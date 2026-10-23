# Grok MCP Integration — Verification and rollout

Official docs: https://docs.x.ai/grok/connectors ; https://docs.x.ai/grok/connectors/custom-mcp-tunneling ; https://docs.x.ai/build/features/mcp-servers

## Existing SuperAgent components
- `src/core/mcp/mcpHttpTransport.ts`: Streamable HTTP SDK, per-credential sessions, HEAD challenge, safe tool filtering.
- `src/core/mcp/mcpOAuthRoutes.ts`: OAuth protected resource / authorization server discovery, DCR, PKCE, token exchange.
- `src/core/mcp/mcpTunnel.ts`: Cloudflare quick tunnel and OpenAI tunnel; Grok must use HTTPS Cloudflare URL, not openai-tunnel://.

## Deployment checklist
1. Start SuperAgent MCP tunnel with Cloudflare, OAuth, safe-only tools. Avoid dangerous mode until explicitly authorized.
2. Test public HTTPS `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` for correct current public origin, token and registration URLs.
3. Verify unauthenticated `HEAD /mcp` returns a 401 with `WWW-Authenticate` discovery challenge and no body.
4. Complete OAuth in Grok connector at https://grok.com/connectors (New Connector > Custom).
5. Verify initialize, tools/list and one read-only tools/call, plus unauthenticated and unauthorized denials.
6. Verify transport JSON responses via Cloudflare; quick tunnels may not carry SSE.
7. Prefer a named/stable tunnel to avoid connector re-registration after restart.
8. Run Grok Build CLI `grok mcp add --transport http superagent https://HOST/mcp`, then `grok mcp doctor superagent` where available.

## Follow-up code tasks
- Add an explicit Grok safe-only profile and sanitized doctor command.
- Add integration tests for OAuth discovery, dynamic registration, HEAD, initialize, tools/list, and scope denial.
- Check JSON-only response support (Cloudflare quick tunnel may not support SSE).
- Never log secrets or grant terminal/file-write privileges implicitly.

## Status
Documentation and code paths inspected; real Grok OAuth and tools/call handshake not yet verified.
