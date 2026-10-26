# Production Core / MCP separation — guarded rollout evidence

Date: 26 October 2026
Decision: preserve Core 7888 / OAuth MCP 6789; **no unverified live cutover**.

## Actual runtime

- Production unsupervised global API port **7888** and OAuth MCP port **6789** are owned by the same process (PID 13424 at preflight). A separate OAuth MCP port 9877 is owned by another CLI process (PID 10060). The old unsupervised Core cannot be taken over by `core restart --port 7888`; its Core supervisor ownership audit explicitly reports unknown/unverified, while its live authenticated `GET /api/status` lacks the new `senopatiInference` field.
- Existing supervised **canary** on port **7892**, separate staging profile, successfully retained PID 19352 while replacing worker 34528 -> 33076 and safely draining the old worker. This validates rolling-restart capability for supervisor-owned workers, not live production adoption.
- The global SuperAgent Node/npm installation is a junction to the source repository; `bun run build` updates the disk-side global CLI, but cannot replace code loaded in the still-running unsupervised PID.

## T-Line gateway configuration

- T-Line backend now accepts optional `TLINE_SUPERAGENT_CORE_PORT` with strict loopback-only numeric port validation; default remains 7888.
- Backend auth reads the corresponding private `server-info-PORT.json`, never reuses another port's bearer, and no renderer/token URL is emitted.
- Its REST/SSE proxy modules, session history, studio/status/presets, Core probe and task operations now honor the selected port.
- A non-default port is externally owned: T-Line refuses surprise auto-spawn when it is unavailable; previously implemented arbitrary port-to-PID kill was removed.
- A safe test explicitly scoped to the staging profile at 7892 showed authenticated `compatible`; default 7888 remained `compatible`. No real desktop session was redirected by these tests.
- The T-Line change is committed independently in that repository as `8bd90c8`. See `t-line/backend/docs/core-port-handover.md`.

## Dedicated local MCP proof

- `bun scripts/mcp-dedicated-local.ts start` starts an owner-scoped *local-only* read-only gateway MCP listener on **127.0.0.1:6790**, independent of Core PID 13424. No Cloudflare process or OAuth issuer is started.
- `bun scripts/mcp-dedicated-local.ts status` reports PID, heartbeat and local-only mode without revealing the private bearer.
- `bun scripts/mcp-dedicated-local.ts stop` writes a private nonce-bound stop request for that process only and never calls taskkill/kill against the old Core. It closes its own listener and removes its own owner/token records.
- A start -> status -> graceful stop -> re-start drill passed. Latest observed dedicated MCP PID **16716**, port **6790**. GET without auth returned **401**; with private credential returned non-401 **400** on invalid GET framing, confirming auth recognition without using a tool.
- Local credential file is owner-private at `~/.superagent-r/mcp-dedicated-local-6790/bearer.json`. **Do not expose or copy it into logs, chat, remote clients or git.**
- This gateway is not a replacement for existing OAuth MCP, not a public endpoint, not an adopted OAuth issuer, not an automatically managed OS service, and not a guarantee of tool-state continuity.

## Native managed owner integration and production gate

- Concurrent SuperAgent Core Phase 5n implements a stronger staging-only managed MCP owner lifecycle with PID/listener verification and explicit approval. Its isolated `bun scripts/verify-managed-mcp-lifecycle.ts` passed **13/13 checks**, including owner survives CLI exit, rejects duplicates, requires explicit operator approval, and nonce-based graceful stop.
- Native `superagent mcp lifecycle plan --port 6791` explicitly **BLOCKED** OAuth production cutover for: shared legacy owner, missing independent OAuth issuer/public URL, missing client reauthorization, unknown legacy session/tool-effect reconciliation, unverified rollback and absent operator approval. Tokens and live sessions cannot be copied between processes. This is a safety check, not a task failure.
- The 6790 proof-of-separation is standalone/local-only. Prefer the native verified ownership implementation for future managed production workflows when approved; avoid running two competing public MCP endpoints.

## Requirements before enabling new Core for actual T-Line production

1. Independent **OAuth** MCP owner and its real public endpoint, including issuer discovery, PKCE, tool scope and every client reauthorization, must be verified. The old Cloudflare quick-tunnel URL cannot be assumed to transfer.
2. Production Core profile, session/turn reconciliation, no ambiguous tool effects and fallback/rollback must be verified independently. The 7892 canary profile is intentionally empty and must not be treated as production.
3. Only then explicitly launch T-Line backend against the intended supervised Core port and reconcile/rebind sessions with consent. Preserve old Core until its MCP client connections have drained; never force-free port 7888 or terminate its owning PID automatically.
4. Actual zero-downtime takeover of the original 7888 TCP listener is *not supported* while the original unsupervised owner still holds it; an explicit bounded maintenance handoff or an externally designed persistent front door is required.

Current status: safer new code and separately running MCP local process; **no claim of completed production 7888/OAuth cutover**. No external alerts were sent.
