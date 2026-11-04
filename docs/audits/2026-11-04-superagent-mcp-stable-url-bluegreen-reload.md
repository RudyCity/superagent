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


## Help, autocomplete and metadata-only owner logging (2026-11-04 update)

- `/mcp help` and `superagent mcp --help` now explicitly distinguish
  bare `/mcp reload` (outbound connections) from `/mcp reload --port`
  and `/mcp tunnel reload --port` (blue-green hosted backend).
- `/mcp tunnel restart --port` is backend-only on reloadable owners;
  explicit `--full` is needed to restart Cloudflare, potentially
  rotating a Quick Tunnel URL. Legacy owners fail closed.
- `/mcp tunnel logs --port 8857 --tail 20` and aliases
  `/mcp logs`, `superagent mcp logs`, and
  `superagent mcp tunnel logs` read the new lifecycle journal.
- Local status output differentiates Legacy versus Reloadable,
  shows the latest backend PID and generation, last reload time, and
  recommended commands. Interactive startup help includes reload/logs.
- T-Line/dashboard autocomplete advertises help, safe reload,
  log tail, and separately labeled destructive full restart; known
  ports are discovered from existing per-port MCP state files.
- `src/core/runtime/mcpOwnerLog.ts` writes allowlisted
  `owner_started`, `backend_reload_started`,
  `backend_reload_succeeded`, `backend_reload_failed`,
  and `owner_stopping` events. This is a separate, bounded
  per-port 256 KiB JSONL journal with rotation and a maximum
  100-event read; only numeric PIDs/durations and a small fixed
  allowlist of MCP error codes are admitted, with no OAuth tokens,
  client credentials, arbitrary raw error text, prompts or responses.
- Owner status receipts expose only `reloadable`,
  `backendPid`, `backendGeneration`, and `lastReloadAt`.
  Preflight denials are logged with safe error codes.

### New verification

- `tests/mcpOwnerLog.test.ts`: secrets never stored, bounded tail,
  rotation, file-safety checks and invalid-argument handling.
- `tests/mcpReloadableOwner.test.ts`: blue-green worker integration
  validates state receipt updates and lifecycle journal entries.
- `tests/mcpTunnelState.test.ts`: correct Legacy/Reloadable
  status formatting and owner metadata.
- `tests/mcpTunnelReloadCommand.test.ts`:
  read-only logs, help and aliases, rejected invalid port/tail.
- `tests/commandDomainSeparation.test.ts`:
  safe reload/log/full-restart suggestion discovery.
- CLI read-only smoke: `bun dist/cli.js mcp --help` and
  `bun dist/cli.js mcp tunnel logs --port 8857 --tail 5`.

**Live guard:** current port 8857 is still PID 22228,
`https://backed-large-license-causing.trycloudflare.com/mcp`,
OAuth legacy owner. It has no reloadable-owner journal yet. Code
and tests do not migrate or restart it.


### Standalone CLI dispatch smoke

`src/cli.tsx` dispatches `mcp logs`, `mcp log`, and
`mcp reload` before launching the agent. The standalone CLI
implements `mcp reload --port <port>`; a bare `mcp reload`
reports that only the live interactive TUI can refresh its own
outbound clients. Read-only smoke of `bun dist/cli.js mcp logs`
and a deliberately nonexistent reload port confirmed no delegate
bridge was started.


### Final regression (read-only production boundary)

- `bun run build`: PASS.
- 10 relevant Vitest suites: **67/67 passed**.
- Standalone `mcp logs` and `mcp reload --port` CLI routes
  verified; neither accidentally starts the agent or Delegate bridge.
- Port `8857` production owner was not restarted or migrated.


## OAuth one-use bootstrap code hot regeneration

- `/mcp tunnel token regenerate --port N` and
  `superagent mcp tunnel token regenerate --mcp-port N`
  request a new, cryptographically random OAuth owner approval code
  without restarting cloudflared, the ingress owner, the MCP backend,
  or rotating the public issuer URL.
- Owner-only POST `/_internal/owner/bootstrap/rotate` requires the
  existing, process-bound lease credential, loopback socket and
  exact local Host. The control request is authenticated by the owner;
  a public MCP or OAuth caller cannot reach it.
- The owner forwards **only the new SHA-256 code hash** to the
  backend over trusted child IPC and waits for an explicit ACK.
  The plaintext code is returned exactly once to the local CLI.
  The TUI copies it to the clipboard and never adds it to chat history.
- Bootstrap hash is consumed synchronously **after successful owner
  approval**, not at first incorrect code attempt. Subsequent
  approvals using the same code return access_denied until regenerated.
  The owning process tracks consumption to ensure a later backend
  reload does not resurrect a used code.
- Only `bootstrap_rotated` and `bootstrap_consumed` event names,
  timestamp and numeric process metadata enter the lifecycle journal.
  The plaintext token, hash and pending authorization data are omitted.
- Existing OAuth access tokens, refresh tokens, grants and issuer
  remain untouched. This operation is unavailable on Legacy owners,
  static bearer owners and OpenAI Secure MCP Tunnel legacy lifecycle.


### Crash-safe approval-code handling

The current OAuth worker's unexpected exit invalidates the owner
bootstrap verifier before backend recovery, even if a consumption
notification was lost due to that crash. The operator then regenerates
a fresh code after recovery. This intentionally favors invalidating
an unused code over accidentally resurrecting a spent code.
Only `bootstrap_invalidated_on_crash` event metadata is journaled.


### Verified implementation (2026-11-04)

- Build: `bun run build` PASS.
- Targeted security/CLI/OAuth/blue-green regression:
  **104/104 PASS, 13 test suites**.
- Real compiled-backend OAuth integration verifies:
  - owner/control auth checks; public owner-control path never forwarded;
  - old approval code rejected immediately after regeneration;
  - new approval code accepted once and then rejected on replay;
  - subsequent backend blue-green reload cannot resurrect spent code;
  - an OAuth access token remains usable after code regeneration;
  - unchanged Cloudflare mock start count, public URL, owner PID and
    backend PID during rotation;
  - no secret value in owner state or sanitized lifecycle journal.
- Corrected ingress authorization-path validation to allow percent
  encoding of an OAuth `redirect_uri` query value while still
  prohibiting encoded separators in the actual URL path; R3/R6
  security regression suites passed.
- CLI/TUI commands and `--mcp-port`/`--port` suggestions verified.
- Production port 8857 still has a Legacy MCP owner. Regeneration
  must fail closed there until separately authorized one-time
  architecture migration; do not claim production rotation happened.
