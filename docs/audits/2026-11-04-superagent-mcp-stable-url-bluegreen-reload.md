# SuperAgent MCP Stable-URL Reload — Implementation & Operational Guardrails

Date: 2026-11-04
Project: `D:\backup from pc asus\Documents Development\superagent`
Branch: `main` (no worktrees)

## Objective

Allow MCP backend updates without restarting Cloudflare Quick Tunnel,
changing the connector URL, resetting the ingress owner PID, or changing
the OAuth issuer. The existing `mcp tunnel restart` implementation stopped
both services in a single process, so Quick Tunnel URLs could rotate.

## New lifecycle

```text
ChatGPT / OAuth client
  -> unchanged https://<quick-host>.trycloudflare.com/mcp
  -> cloudflared (owned by the durable MCP ingress PID)
  -> localhost:PORT stable ingress / owner control
  -> private Bun MCP backend worker (new PID each reload)
```

- **Durable owner / ingress**:
  `src/core/runtime/mcpReloadableOwner.ts`. Owns public tunnel,
  stable local port, private reload credentials, backend generations and
  session affinity. Serves private owner commands only from loopback
  with the exact localhost Host and a process-scoped 256-bit bearer.
  Client input never selects the upstream port. Public ingress permits
  known MCP/OAuth routes only; owner routes are never forwarded.
- **Replaceable backend**:
  `src/core/runtime/mcpReloadableBackend.ts`. Forked from the latest
  compiled `dist/cli.js mcp backend-worker` via parent-child IPC.
  Starts isolated MCP/OAuth listener on an ephemeral private loopback
  port. No Core, Chrome bridge, cloudflared, or additional public URL.
- **Blue-green swap**: start new backend, confirm its listening socket,
  then atomically switch *new sessions* to it; preexisting
  `mcp-session-id` values continue to be routed to the old process.
  Old generations are retained for active sessions (up to the current
  MCP maximum session lifespan, with cleanup after a 5-minute grace).
  In-flight HTTP/SSE requests are not interrupted by reload.
  If candidate startup fails, the old backend stays in service.
  If the current backend dies unexpectedly, reload may recover it.
- **OAuth**: the public issuer stays unchanged and the backend reopens
  the configured persistent OAuth store. OAuth reload is refused if
  persistent storage is unavailable, rather than silently invalidating
  the user's access/refresh tokens. Static bearer credentials remain
  stable within the ingress owner's lifetime.
- **No secrets on CLI**: backend bearer and OAuth bootstrap verifier are
  transferred through private child IPC; status files contain no tokens.
  The owner lease is private and still protected by process identity,
  OS listener PID and Windows process birth checks.

## Commands

```text
/mcp tunnel reload --port 8857
/mcp tunnel restart --port 8857
/mcp reload --port 8857
superagent mcp tunnel reload --port 8857
superagent mcp tunnel restart --port 8857
```

All five commands request *backend-only reload* on reloadable Cloudflare
owners. They return unchanged public URL and new backend PID.

**Backward compatibility**:
- Bare `/mcp reload` retains its prior meaning: refresh configured
  outbound MCP connections in the current CLI session.
- `/mcp tunnel restart --port 8857 --full` is the explicit **full
  tunnel + owner restart**. This can rotate the Cloudflare Quick URL,
  disrupt sessions, or require connector reconfiguration.
- Legacy owners without an authenticated private reload endpoint
  return `MCP_RELOAD_LEGACY_OWNER` and are **not** restarted silently.
- OpenAI Secure MCP Tunnel keeps its prior implementation. Backend-only
  reload is currently supported for Cloudflare Quick Tunnel owners.

## Important: first migration of the existing live owner

The currently connected legacy owner (port `8857`) was started **before**
this architecture existed. It cannot be transparently converted into a
new process without replacing the old owner. A one-time migration using
`--full` may change its Quick Tunnel URL. Do **not** do this without
explicitly accepting a possible connector URL update. After that
migration, routine backend-only reloads preserve the URL as long as
the ingress and cloudflared remain alive.

If the URL must survive **machine/owner/tunnel** restarts, provision a
Cloudflare **Named Tunnel + fixed domain**. A Quick Tunnel hostname
is ephemeral even with this architecture.

Refreshing a ChatGPT connector's cached tool list may still require
reconnecting its MCP session to discover newly added tool schemas.
An existing session continues using its previous backend until released.

## Verification

- Local mocked Cloudflare tunnel + **real compiled Bun MCP backend**
  integration in `tests/mcpReloadableOwner.test.ts`:
  - Public URL unchanged before/after backend PID swap.
  - Durable owner PID unchanged; Cloudflare process not restarted.
  - Existing MCP session `listTools` still succeeds after swap.
  - A new MCP client connects to the new backend.
  - Private routes require local Host, bearer and method.
  - Unknown public URLs are blocked.
  - OAuth issuer remains constant, with fail-closed reload when
    persistence is unavailable.
  - Explicit shutdown cleans its own state and tunnel.
- Lifecycle/command regression suites: managed owner, ingress,
  owner control, command domain separation.
- Compiled with `bun run build`; never tested by restarting
  the live ChatGPT-connected port `8857`.

## Release boundary

This change produces new code and tests, **not an automatic
migration of the currently running legacy owner**. No live user
connection, OAuth grant, or Chrome Delegate pairing should be
modified as part of the code-only deployment.

## Verified results (2026-11-04)

- `bun run build`: **PASS**, Bun TypeScript compilation and schema synchronization.
- `bun --bun x vitest run tests/mcpReloadableOwner.test.ts
  tests/mcpTunnelReloadCommand.test.ts
  tests/mcpManagedTunnelOwnerLifecycle.test.ts
  tests/commandDomainSeparation.test.ts
  tests/mcpOwnerControlR1.test.ts
  tests/mcpGatewayHttp.test.ts
  tests/mcpToolGateway.test.ts`: **7 suites, 40/40 passed**.
- No live Quick Tunnel was stopped, restarted or replaced during verification.
- Production port `8857` remains on its original legacy owner until a
  separately authorized migration. Calling backend-only reload there
  fails closed rather than silently changing its URL.
