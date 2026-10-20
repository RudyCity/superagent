# Hermes Phase 5 — Public OAuth Issuer Hardening and Proxy Boundary

Date: 2026-10-20
Status: Local implementation and proxy-boundary tests; real public tunnel acceptance still open.
Parent: docs/plans/2026-10-20-superagent-hermes-phase-5-oauth-http-session-isolation.md
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md

## Confirmed OpenAI tunnel configuration flaw

OpenAI Secure MCP Tunnel used http://127.0.0.1:<port> as the OAuth issuer and returned a local authorization-server discovery URL. A remote OAuth client cannot discover or reach an issuer bound to its own localhost. An opaque openai-tunnel://<id> identifier is not an HTTPS authorization-server origin, and must never be passed as one.

## Change

- When using provider=openai with authMode=oauth, **a real public HTTPS OAuth issuer is mandatory**. Supply --oauth-public-url https://your-public-host or the OPENAI_MCP_OAUTH_PUBLIC_URL environment variable.
- Missing or invalid issuers (HTTP, localhost, URI userinfo, query parameters, fragments, or non-root paths) are rejected before the local MCP listener or external tunnel client starts.
- The explicit public issuer is used for OAuth resource metadata and discovery instead of localhost. Host/Origin validation remains independent. The non-secret issuer is persisted with tunnel state to support restart with the same configuration; changing it on an active port requires stopping that MCP instance.
- /mcp tunnel restart reuses the recorded issuer unless explicitly overridden. The opaque OpenAI tunnel ID continues to designate the private transport; it is not silently converted to an HTTPS URL.
- Cloudflare Quick Tunnel already yields an actual public HTTPS hostname and continues to use that hostname without requiring the new OpenAI-specific setting. Static bearer mode is unaffected.
- This config option is **not** proof that the configured public issuer is actually reachable via OpenAI Secure MCP Tunnel. The operator must ensure DNS/proxy routing of the OAuth endpoints is live.

## Local reverse-proxy acceptance

tests/mcpOAuthProxyBoundary.test.ts uses an actual loopback HTTP listener configured with a representative public HTTPS issuer and simulated proxy request headers.

- Public resource and authorization-server metadata consistently advertise the configured issuer, never the injected X-Forwarded-Host or X-Forwarded-Proto.
- Unknown Host is rejected even if X-Forwarded-Host claims the trusted hostname (raw node:http request preserves the Host header).
- Unauthenticated MCP HEAD responds with 401 and the public OAuth resource discovery challenge, without issuing a session.
- OpenAI tunnel startup integration and command tests cover malformed issuer rejection, correct issuer propagation, discovery and restart state, without starting an actual external tunnel.

## Remaining gates

No real Cloudflare or OpenAI public tunnel was started by these tests. Real DNS/TLS, public issuer reachability, OAuth consent across an external browser/client, cross-network identity/session isolation, rate limiting, remote error handling and privileged user approval still need staged public acceptance. Do not claim production-ready Phase 5 from local issuer/proxy tests.

## Verified local acceptance — 2026-10-20

- TypeScript build: passed.
- Extension JavaScript validation: passed (8 files); wiki validation: passed (9 documents, 24 links).
- Focused MCP tunnel/OpenAI provider/OAuth HTTP/authorization, lifecycle and proxy suites: **108 tests passed across 9 suites**.
- Full Vitest run (maxWorkers=3): **exit 1; 387 suites passed, 3 failed, 1 skipped; 3,659 tests passed, 4 failed, 5 skipped**.
- Full-suite failures: 2 in tests/motionFoundation.test.ts, 1 in tests/nudgeSkip.test.ts, 1 in tests/tlineInspection.test.ts. All are outside this issuer/proxy change and were observed while those workstreams had concurrent uncommitted changes. These failures are NOT resolved or certified by this increment.
- Focused suite results are not additive with the full test totals.
- Production OAuth over a real public OpenAI/Cloudflare tunnel is NOT yet verified.
