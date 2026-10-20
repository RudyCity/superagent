# Hermes Phase 5 — OAuth Resource Scope and Fresh-Runtime Isolation

Date: 2026-10-20
Status: Local MCP handler and loopback HTTP acceptance; live tunnel / process-crash verification OPEN.
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md
Previous: docs/plans/2026-10-20-superagent-hermes-phase-5-privileged-oauth-grants.md

## Security finding

The OAuth scope gates in tools/list and tools/call did not cover the independent MCP resources/list, resources/read, prompts/list and prompts/get handlers. Those handlers serve session history, pinned memories, current runtime configuration, live process/task prompts and reusable prompt templates. A token valid at HTTP level without tool read permission could still invoke those handlers, while ordinary read-only tokens could enumerate sensitive resources.

## Implementation

- The resource/prompt handler registration now takes the same **per-session OAuth identity getter** as the tool dispatcher and checks current scopes on every invocation. No new remote mutation routes are introduced.
- OAuth resources/list and prompts/list and direct reads/gets require a read-capable scope (mcp:tools, legacy mcp:tools:read, or mcp:tools:write). The absence of readable scopes is rejected before fetching sensitive state.
- Four sensitive resources require **both** mcp:tools:write and the independently owner-consented mcp:tools:admin: status/live (can contain task prompts), config/current (runtime settings), history/sessions (conversation history), and memory/pinned (pinned personal knowledge).
- Resources/list hides those four URIs from OAuth readers lacking admin consent; direct resources/read remains denied even when a client knows or caches a URI. Other resources and prompt templates remain readable with the regular read grant.
- The guards apply at handler boundaries for both initialized-session and stateless HTTP MCP requests. Local stdio and static-bearer resource behavior is unchanged.
- Client token privilege derives from the server-side OAuth identity; no identity or grant is inferred from request-supplied tool arguments or headers.

## Acceptance

- Direct handler tests cover missing scopes, sensitive-resource discovery and direct read denial, ordinary read/prompt compatibility, admin visibility and live admin scope revocation, and unchanged local stateless/stdin behavior.
- Actual loopback HTTP tests issue owner-approved OAuth tokens, test initialized and stateless direct resource reads, enforce sensitive-resource restrictions and allow ordinary prompt discovery.
- A fresh second local HTTP OAuth runtime rejects another runtime's access token and MCP session with HTTP 401 while still advertising the unauthenticated challenge. The original runtime continues to function independently.
- This is **not** proof of a real OS process crash/restart or persistent token revocation across a distributed cluster; the current OAuth token store is in-memory and a fresh server intentionally invalidates earlier tokens.
- No live public Cloudflare/OpenAI tunnel, TLS, multi-host token store, or per-tool interactive approval is certified.

## Remaining gates

Public tunnel DNS/TLS reachability, real external-client consent/refresh/revocation, multi-host credential synchronization, crash-restart lifecycle and owner-approved high-impact operations remain OPEN.

## Final local verification — October 20, 2026

- TypeScript build: passed.
- Extension JavaScript verification: passed (8 files).
- Wiki validation: passed (9 documents, 24 links).
- Focused MCP OAuth resources, real HTTP E2E, MCP server, YOLO, routes and compatibility: **78 tests passed across 6 suites**.
- Full Vitest (maxWorkers=3): **exit 1; 393 suites passed, 2 failed, 1 skipped; 3,682 tests passed, 2 failed, 5 skipped**.
- Failed outside this change: tests/remoteAgentSession.test.ts auto-cancel (fixture missing Muse config) and tests/sharedMemoryLiveness.test.ts live-PID lock (fixture file directory removed before write). Targeted rerun with both suites and relevant OAuth E2E tests passed **48/48 tests across 4 suites**.
- Focused and full suite totals overlap; do not add counts. The full repository regression gate remains OPEN despite successful reruns.
- No real Cloudflare/OpenAI tunnel, OS process crash/restart, persistent OAuth tokens or distributed multi-host acceptance was executed.
