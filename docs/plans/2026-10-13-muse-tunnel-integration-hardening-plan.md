# Muse Tunnel and MCP Integration Hardening Plan

**Date:** 2026-10-13  
**Status:** Implemented; build and focused verification passed. See Section 10 for results and validation boundaries.  
**Scope:** Cloudflare Quick Tunnel lifecycle, Muse WebSocket transport, MCP-over-HTTP tunnel, remote-service status, cross-process state, and regression coverage.

## 1. Objective

Make Muse WebSocket tunnels and MCP HTTP tunnels independent, correctly reported, safe to start/stop, and recoverable after startup failures. The implementation must preserve existing CLI/slash-command behavior where intentional, keep legacy state files readable, and avoid disrupting tunnels owned by another running Superagent instance.

This plan is based on the current code paths and live endpoint checks. It is not a claim that every listed risk has already been reproduced in production.

## 2. Verified Baseline

### Runtime checks performed

- Two Cloudflare Quick Tunnel processes were reported active: one forwarding to workspace `dualpointer-0.3.3` on port `8111`, and one forwarding to the Superagent workspace on port `9227`.
- The Muse Watcher registry reported inactive.
- The port `8111` local and public `/muse` endpoints accepted a WebSocket upgrade. The test deliberately sent no authentication frame; the server closed the connection with code `4001` after the handshake timeout. This confirms a reachable WebSocket listener, not an authenticated Muse session.
- The port `9227` MCP endpoint `/mcp` responded `401 Unauthorized` without credentials, which is consistent with the configured OAuth protection. Its `/muse` endpoint responded `404`, which is expected for the documented MCP-only mode.
- The repository working tree was clean during the audit.

### Existing regression suite

This focused command passed **7 test files / 102 tests**:

```sh
npm test -- --reporter=dot tests/cloudflareTunnel.test.ts tests/cloudflareTunnelFixes.test.ts tests/remoteStatusService.test.ts tests/mcpTunnelState.test.ts tests/museWebSocketTransport.test.ts tests/museMultiProjectWatch.test.ts tests/museTokenRefresh.test.ts
```

These results establish a baseline, but the suite does not currently cover all cross-service isolation and startup rollback cases below.

## 3. Findings

| ID | Finding | Current code | Impact / confidence |
|---|---|---|---|
| T1 | Generic tunnel startup mutates Muse-specific configuration. | `src/core/remoteAgent/cloudflareTunnel.ts`: `startQuickTunnel()` builds a WSS URL and writes `wsRemoteUrl`; stop/exit paths also clear it. `src/core/mcp/mcpTunnel.ts` uses this generic manager for MCP. | **Confirmed coupling.** MCP start/stop can pollute or clear the Muse URL even though MCP has no Muse WebSocket endpoint. |
| T2 | MCP-only command performs Muse configuration work before dispatching to MCP mode. | `src/core/commands/museTunnelSubcommand.ts` lines 30–44; `src/core/remoteAgent/museCli.ts` lines 92–102 and the later `wantMcp` branch. | **Confirmed side effect.** A command intended to expose MCP may generate a Muse WS token and change the configured transport to `websocket`. |
| T3 | Aggregate status classifies every active Quick Tunnel as a Muse tunnel. | `src/core/remoteAgent/remoteStatusService.ts` lines 92–135 and formatter lines 293–319; `listActiveTunnels()` returns generic Quick Tunnels. | **Confirmed reporting defect.** The MCP-only port appears in the Muse tunnel section with a synthetic/default `/muse` URL although that endpoint is not served there. |
| T4 | Startup failure can leave a tunnel or service in a partial state. | `src/core/remoteAgent/museWatcher.ts` lines 289–330 starts the tunnel before starting its transport; transport startup is handled asynchronously. `src/core/mcp/mcpTunnel.ts` lines 157–208 starts/reuses the tunnel before creating the HTTP server. | **Confirmed missing rollback path in code.** A WS bind failure can occur after the tunnel is created; MCP HTTP server creation can throw after a tunnel has been created/reused. Exact impact depends on whether this invocation owns the tunnel. |
| T5 | The ordinary stop path also probes/stops the default MCP server. | `src/core/commands/museTunnelSubcommand.ts` lines 722–741; `src/core/remoteAgent/museCli.ts` lines 523–535. | **Confirmed coupling.** When the MCP server is owned by the current process, a non-MCP stop command can stop MCP as well. |
| T6 | Persisted tunnel liveness is inferred from PID existence alone on read/start paths. | `cloudflareTunnel.ts` lines 433–439, 700–750, and 779–839. Stop paths have stronger command-line ownership validation in `isOwnQuickTunnelProcess()`. | **Confirmed inconsistency; PID-reuse failure not reproduced.** A reused PID can make old metadata look active until a stronger identity check is applied. |
| T7 | Current tests cover basic tunnel persistence and process-safe stop, but not service-kind isolation and several failure paths. | `tests/cloudflareTunnelFixes.test.ts`, `tests/remoteStatusService.test.ts`, `tests/mcpTunnelState.test.ts`, Muse transport/tunnel test files. | **Confirmed coverage gap.** Existing tests pass while the coupled behavior described in T1–T5 remains possible. |

### Explicit interpretation

The `404` from `/muse` on the MCP tunnel is **not itself a defect**: the project documents `/muse tunnel start --mcp` as MCP-only. The defect is that shared tunnel metadata and status reporting imply a Muse WSS endpoint for that tunnel, and the shared manager performs Muse-specific configuration side effects.

## 4. Target Design

### 4.1 Explicit tunnel service identity

Introduce a persisted service kind, with a backwards-compatible migration policy. Proposed values:

- `muse-websocket`
- `mcp-http`
- `superagent-http`
- `unknown` for old/unclassifiable persisted records

New callers must pass their intended kind explicitly. The tunnel metadata must not fabricate a Muse WSS endpoint for HTTP-only services. Update types and formatters so public URLs and protocol-specific endpoints are represented separately.

Do not infer service kind exclusively from the port number: ports are configurable and can change.

### 4.2 Generic manager has no implicit Muse config side effects

Refactor `CloudflareTunnelManager` so creating, listing, or stopping a generic Quick Tunnel does not unconditionally set or clear `remote-agent.json:wsRemoteUrl`.

Muse-specific URL publication/cleanup must be an explicit operation owned by the Muse WebSocket flow. Clear a configured URL only when it still matches the URL owned by the stopping Muse tunnel. MCP and Superagent HTTP tunnel operations must never alter it.

Audit all call sites before changing defaults so existing Muse CLI and slash commands remain compatible. Support old state files and legacy callers during migration.

### 4.3 Isolate MCP-only command setup

Move Muse token generation and `transport: websocket` updates below the MCP-only dispatch, or make them conditional on a true Muse WebSocket action. The following commands must remain independent:

- `/muse tunnel start` — Muse WebSocket tunnel and watcher
- `/muse tunnel start --mcp` — MCP HTTP server and tunnel only
- HTTPS/REST mode — Superagent HTTP server and tunnel only

Starting or stopping one mode must not rewrite the configuration of another mode.

### 4.4 Transactional startup and cleanup

Model startup as acquiring resources with explicit ownership, then commit the running state only when required components are ready.

- For Muse WebSocket mode, confirm the WS server has bound/listened before publishing a working public endpoint. Establish a clear readiness contract: startup should know when the transport has successfully initialized without awaiting a long-running Telegram polling loop.
- When a requested tunnel cannot be established, report a clear failure and apply one documented policy: rollback the requested watcher/transport, or explicitly continue in local-only mode. Do not silently report the tunnel mode as active when only some components succeeded.
- For MCP, handle failure in HTTP server creation after tunnel startup. Roll back a tunnel only if this start operation created/owns it; never tear down a pre-existing tunnel owned by another workspace/process.
- Make `MuseWatcher.stop()` clean up partially initialized resources even if `isRunning` has already become false. Cleanup must be idempotent and safe to call after partial startup.
- Preserve authentication and permission checks; do not weaken auth to make health checks pass.

### 4.5 Ownership-aware stop and restart

- A stop command without MCP flags must affect Muse WS and its matching tunnel only.
- MCP stop must be explicit through a documented MCP action/port; `stop all` remains the explicit cross-service operation.
- Do not stop another instance's server based only on a matching port. Use state owner PID, tunnel kind, target URL, and process identity consistently.
- Ensure restart performs stop and start against the same service kind and intended port.

### 4.6 Trustworthy service status

Report the following independently:

1. Cloudflare process is alive and its identity matches the persisted target.
2. Local endpoint is reachable with the expected protocol.
3. Service is ready (WS listener or HTTP server).
4. Muse is authenticated/connected, when applicable.
5. MCP is accepting requests and returns the expected auth challenge when unauthenticated.

A generic HTTP `401` with the expected `WWW-Authenticate` challenge is a healthy protected MCP endpoint, not an outage. For Muse, a WS upgrade followed by the expected authentication timeout without credentials proves reachability only; it must not be reported as an authenticated session.

Do not perform intrusive checks or send real tasks as part of routine status commands. If active protocol probing is too costly or unsafe, label the state as process-level rather than claiming endpoint health.

## 5. Implementation Phases

### Phase 0 — Lock the contracts and preserve baseline

1. Enumerate every `startQuickTunnel`, `stopQuickTunnel`, `getTunnelStatus`, `saveTunnelState`, `clearWsRemoteUrl`, `startMcpTunnel`, and `stopMcpTunnel` call site.
2. Document per caller: service kind, server process/port, expected public endpoint, state owner, and cleanup owner.
3. Add tests for expected command intent before refactoring: MCP-only start must not alter Muse config; Muse status must not claim an MCP-only tunnel is a Muse WSS service; non-MCP stop must not stop MCP.
4. Keep the existing focused test command above as the regression baseline.

**Exit criteria:** call-site inventory is complete and the new failing tests reproduce the defects before implementation.

### Phase 1 — Service-kind metadata and side-effect isolation

1. Add the service-kind field to tunnel metadata and status types with migration support for old state files.
2. Update the caller contract so MCP and Superagent HTTP callers identify their kinds; Muse callers identify Muse WebSocket mode.
3. Make WSS URL generation conditional on a WS kind and handle an explicitly empty/root path without falling back to `/muse`.
4. Move `wsRemoteUrl` publication/cleanup into the Muse-specific owner flow.
5. Remove premature Muse token/transport mutation from both command entry points' MCP-only path.
6. Add state migration tests and isolation tests, including parallel tunnels on separate ports.

**Exit criteria:** starting/stopping MCP or Superagent HTTP does not mutate Muse configuration, and new persisted metadata reports the correct protocol and kind.

### Phase 2 — Startup readiness, rollback, and lifecycle ownership

1. Define a transport readiness contract compatible with WS server startup, WS client startup, HTTPS server startup, and long-running Telegram polling.
2. Reorder Muse WS initialization so the listener is ready before the public endpoint is declared usable.
3. Add ownership information to the tunnel start result so rollback knows whether it created a tunnel or reused an existing one.
4. Make MCP startup failure close any newly created MCP HTTP/tunnel resources without terminating resources owned by another invocation.
5. Make watcher cleanup cover failed/partial startup and keep cleanup idempotent.
6. Verify listeners and child processes are released after failed startup and restart.

**Exit criteria:** injected port conflicts and startup exceptions leave no orphaned tunnel, HTTP server, active-watcher registry entry, or stale owned state file.

### Phase 3 — Safe stop/restart semantics

1. Parse stop intent once into an explicit service kind and port.
2. Remove implicit MCP stopping from the normal Muse tunnel stop path.
3. Keep `stop all` intentionally broad and ensure its output accurately reports what was actually stopped.
4. Validate process command lines and target URLs before treating a persisted PID as the owned tunnel; clean stale metadata without killing foreign processes.
5. Cover stopping one of multiple tunnels, foreign-owner state, stale PID, restart on one port, and stop-all scenarios.

**Exit criteria:** a Muse-only stop never stops MCP; a port-specific stop never affects a different service kind; foreign processes remain alive.

### Phase 4 — Accurate service status and diagnostics

1. Separate Muse, MCP, and Superagent HTTP tunnel entries in `remoteStatusService.ts`.
2. Omit Muse WSS URLs for non-Muse tunnels.
3. Distinguish process-active, endpoint-ready, and Muse-connected states instead of reusing one `active` boolean for all meanings.
4. Retain backward compatibility for tools consuming `get_remote_service_status`; add optional structured fields rather than silently changing existing field semantics in a breaking way.
5. Add formatter and tool-output tests for mixed multi-workspace services.

**Exit criteria:** live status presents each service once, with accurate kind/protocol/owner and no false Muse endpoint for an MCP-only tunnel.

### Phase 5 — Full verification and delivery

1. Run the 7-file / 102-test baseline group.
2. Run the wider remote-agent, Muse command, MCP OAuth, MCP authentication/security, and command-dispatch tests affected by the changes.
3. Run TypeScript build and relevant repository verification commands.
4. Re-run safe local/public endpoint checks:
   - Muse WS endpoint: correct protocol upgrade; unauthenticated connections must not become authenticated.
   - MCP `/mcp`: expected OAuth discovery/auth challenge behavior.
   - MCP `/muse`: no longer advertised as a Muse endpoint; a 404 is acceptable for MCP-only mode.
5. Inspect Git diff, ensure no tokens or live credentials entered logs/docs/tests, update `CHANGELOG.md`, bump the package version according to the repository's release policy, and commit the implementation only after verification.

**Exit criteria:** all focused and wider tests pass, build succeeds, state migration works, endpoint results match service kind, and no cross-service config/stop regression remains.

## 6. Required Regression Matrix

| Scenario | Expected result |
|---|---|
| Start MCP-only while Muse uses Telegram | MCP starts; Muse transport/config remains unchanged. |
| Start MCP-only while Muse uses WebSocket client mode | MCP starts; Muse `wsRemoteUrl`, token, and mode remain unchanged. |
| Stop/restart MCP | Only the target MCP server and its owned tunnel are affected. |
| Start Muse WSS when local WS port is occupied | Command reports startup failure; no newly created tunnel is left running; no false ACTIVE watcher remains. |
| Start MCP when HTTP bind fails | Any tunnel created exclusively for that attempt is rolled back; a reused/pre-existing tunnel is not killed. |
| Multiple workspaces and mixed service types | Status lists each service with the correct kind and endpoint once. |
| Old tunnel state JSON without kind | State loads safely as legacy/unknown and is not falsely asserted to be healthy Muse WSS without evidence. |
| Persisted PID now belongs to an unrelated process | Status marks metadata stale; stop leaves the unrelated process alive. |
| Muse WS reachable but unauthenticated | Report listener reachable, session unauthenticated/disconnected. |
| MCP reachable without token | Report protected endpoint reachable if the expected challenge is returned. |
| `stop all` | Stops owned services only, reports accurate counts, and does not kill unrelated Cloudflare processes. |

## 7. Files Expected to Change

Primary implementation:

- `src/core/remoteAgent/cloudflareTunnel.ts`
- `src/core/remoteAgent/museWatcher.ts`
- `src/core/remoteAgent/museWatcherTunnel.ts`
- `src/core/remoteAgent/museWsTransport.ts`
- `src/core/remoteAgent/museWatcherRegistry.ts`
- `src/core/remoteAgent/config.ts`
- `src/core/remoteAgent/remoteStatusService.ts`
- `src/core/commands/museTunnelSubcommand.ts`
- `src/core/commands/museWatchSubcommand.ts`
- `src/core/remoteAgent/museCli.ts`
- `src/core/mcp/mcpTunnel.ts`
- `src/core/mcp/mcpHttpTransport.ts` only if readiness/health hooks are needed.

Likely tests to add or extend:

- `tests/cloudflareTunnelFixes.test.ts`
- `tests/cloudflareTunnel.test.ts`
- `tests/remoteStatusService.test.ts`
- `tests/mcpTunnelState.test.ts`
- Muse watcher/transport lifecycle tests and MCP tunnel startup/stop tests under `tests/`.

Update the relevant docs and `CHANGELOG.md` as part of implementation delivery, not as a substitute for tests.

## 8. Non-Goals

- Do not replace Cloudflare Quick Tunnels or introduce domain management in this change.
- Do not relax Bearer, Cloudflare Access, or MCP OAuth checks.
- Do not automatically terminate untracked/foreign `cloudflared` processes.
- Do not treat a successful unauthenticated handshake as proof that Muse is authenticated.
- Do not refactor unrelated Telegram, Gateway, or MCP tool behavior beyond what is needed to isolate lifecycle and status.

## 9. Definition of Done

- Tunnel metadata has an explicit kind and backward-compatible loading.
- Muse-specific configuration changes only occur in the Muse WS lifecycle.
- MCP-only commands have no Muse config side effects.
- Startup failure is rolled back according to explicit ownership.
- Stop/restart affects only the requested service kind and port.
- Service status distinguishes process, endpoint, readiness, and connection state.
- Regression matrix passes, existing focused tests pass, TypeScript build passes, and documentation/changelog/version are updated for the implementation release.
- A final audit confirms the change did not expose secrets or terminate foreign processes.

## 10. Implementation Result

### Delivered

- Added `serviceKind` metadata (`muse-websocket`, `mcp-http`, `superagent-http`, and legacy `unknown`) and only generates a WSS URL for Muse WebSocket tunnels.
- Removed Muse `wsRemoteUrl` writes/cleanup from the generic tunnel manager. The Muse tunnel owner publishes the URL only after service readiness and clears only the URL it owns.
- Isolated MCP-only token/configuration behavior and removed implicit MCP stop/restart behavior from normal Muse commands.
- Reordered Muse Watch startup to bind/start the local transport before creating the public tunnel, with ownership-aware rollback and partial-start cleanup.
- Added ownership/target-port validation for persisted tunnel state, safe reuse/stop checks, and conservative handling of mis-keyed or legacy state.
- Tracked per-instance MCP tunnel ownership so stopping a reused MCP server leaves the shared tunnel running and foreign-process MCP state intact; only the instance that created a tunnel stops it.
- Split Muse tunnel reporting from MCP/HTTP and unclassified legacy tunnels; status explicitly says when endpoint/auth probes were not performed.
- Added regressions for PID reuse, MCP startup rollback and target collisions, reused/foreign/locally-owned MCP cleanup, MCP/Muse service isolation, matching URL cleanup, status classification, and rollback before tunnel creation when the local Muse WebSocket listener fails.

### Verification performed

- `npm run build` — passed (TypeScript).
- Focused verification — **8 test files, 116 tests passed**:

```sh
npm test -- --reporter=dot tests/remoteStatusService.test.ts tests/cloudflareTunnel.test.ts tests/cloudflareTunnelFixes.test.ts tests/mcpTunnelState.test.ts tests/mcpTunnelLifecycle.test.ts tests/museMultiProjectWatch.test.ts tests/museWebSocketTransport.test.ts tests/museTokenRefresh.test.ts
```

- Additional security/auth and command verification — **5 test files, 70 tests passed**:

```sh
npm test -- --reporter=dot tests/mcpSecurity.test.ts tests/mcpOAuthStore.test.ts tests/mcpOAuthRoutes.test.ts tests/mcpAuth.test.ts tests/museMessageCommand.test.ts
```

- Local, non-intrusive endpoint smoke check returned: port `9227` `/mcp` = `401` (protected), port `9227` `/muse` = `404` (MCP-only), and port `8111` `/muse` = `426` (WebSocket upgrade required). These are consistent with the documented service modes; no real Muse task was sent.
- Process ownership checks require both a live PID and a command line matching the recorded local target. Mis-keyed state is preserved for explicit reconciliation rather than deleting metadata for a still-owned process.

### Validation boundary

The focused suites and TypeScript build passed. A full repository-wide test run and a fresh public Cloudflare endpoint probe were not performed as part of this implementation pass. Routine status remains deliberately non-invasive and does not claim a public endpoint is healthy or a Muse session authenticated without probing it.
