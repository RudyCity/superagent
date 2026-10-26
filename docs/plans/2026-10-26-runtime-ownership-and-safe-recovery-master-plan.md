# SuperAgent Runtime Ownership & Safe Recovery — Revised Master Plan
**Audit date:** 2026-10-26
**Scope:** SuperAgent CLI/API Core, independent MCP HTTP/OAuth owners, tunnels and T-Line desktop/backend integration.
**Status:** Research and implementation plan ONLY. No production cutover, credential migration, scheduled-task installation or restart authorized by this document.

## 1. Decision / executive summary

Do not continue blindly with an isolated “Phase 5o = persist OAuth tokens” implementation. Earlier Phase 5a–5n work provided useful Core guardian, fail-closed recovery, MCP process audits and a safe staging-only static-bearer MCP owner, but the actual production dependency graph and OAuth session boundary are still coupled.

**Target architecture:** three independent process ownership domains — (A) Core API and worker supervisor, (B) MCP authorization + HTTP session owner, and (C) external tunnel/ingress owner — with T-Line as a client of Core, not its implicit process manager. Each owner needs its own identity, health, lifecycle, secrets, state and rollback policy. Tunnel and client routing must not imply session/token migration. Maintain old and new endpoints in parallel during a manual, staged client reauthorization.

**Safety invariant:** no PID is killed or adopted based on port occupancy, state file or an unverified lease; no ambiguous tool/chat side effect is replayed; no OAuth token is copied out of a legacy process; no production listener is repointed without an independent verified owner plus an approved rollback. “Zero-downtime” can mean continued availability for unaffected connected clients during Core worker restart, NOT guaranteed preservation of every active TCP/SSE/MCP session across an OAuth owner restart or reboot.

## 2. Actual codebase findings (audited, not assumptions)

### 2.1 SuperAgent MCP ingress and OAuth

| Component | Current files | Verified design | Remaining constraint |
|---|---|---|---|
| MCP HTTP server | src/core/mcp/mcpHttpTransport.ts | Loopback HTTP listener, static bearer or OAuth, Host/Origin checks, per-session transports, bounded registries | OAuth store created in the listener process; no external durable owner or independently replaceable in-memory MCP session |
| OAuth route/consent | src/core/mcp/mcpOAuthRoutes.ts | Public protected-resource/authorization-server discovery, dynamic client registration, consent, authorization-code + refresh endpoints | Needs dedicated issuer ownership, durable client-registration policy, documented issuer/resource stability and production-grade validation |
| OAuth state | src/core/mcp/mcpOAuthStore.ts | In-memory client registrations, pending requests, used codes and hashed access/refresh token records; PKCE S256, expiry, revocation/rotation and resource binding | Process crash loses registration/token state; storing just a PID or tunnel URL does not fix this |
| MCP session identity | src/core/mcp/mcpSessionRegistry.ts, mcpHttpTransport.ts | Session transport registered by mcp-session-id and bound to exact auth mode, subject and credential hash | Client must initialize a fresh session on token change/restart; old transport/stream cannot be transparently adopted |
| Remote tool security | src/core/mcp/mcpToolPolicy.ts, mcpToolExposure.ts, mcpHttpTransport.ts | Safe-vs-dangerous tool classification; compact gateway and per-tool scope enforcement; policy annotations | Audit enforcement at dispatch (not merely discovery); ensure nested gateway dispatch cannot bypass scope/write checks |
| Tunnel lifecycle | src/core/mcp/mcpTunnel.ts, openaiTunnelClient.ts, src/core/remoteAgent/cloudflareTunnel.ts | Cloudflare/OpenAI ingress options, shared cross-process state files, in-process activeServers registry | HTTP owner and ingress may still live in/with old Core PID; state file alone is not authority to adopt or terminate an endpoint |

OAuth endpoints already have test coverage; do not rewrite them without a failing acceptance case. Check issuer/resource/redirect/PKCE/refresh/revoke semantics under an independent owner rather than copying legacy in-memory records. The existing dynamic-registration endpoint and bootstrap-code owner-consent model must be reviewed for abuse limits, CSRF/redirect validation, replay, rate limits and persistent client metadata before public deployment.

### 2.2 Core/T-Line ownership and recovery

| Component | Current files | Verified state | Remaining constraint |
|---|---|---|---|
| Core supervisor | src/core/runtime/coreSupervisor.ts, coreBoot.ts, coreGuardian.ts | Authenticated owner, worker generations, drain/restart/rollback, offline cold-boot fail-closed | Does not adopt an arbitrary unsupervised 7888 process, nor reconstitute in-flight model state |
| Durable evidence | coreRecoveryEvidence.ts, coreColdReconciliation.ts, coreRecoveryCasebook.ts, coreRecoveryCanary.ts | Snapshot checksum + SQLite, anonymized case review, explicit isolated canary | No transactionally exact-once external tool effects; cannot automatically clear old checkpoints |
| Owner split | coreMcpOwnershipAudit.ts, mcpOwnerSandbox.ts, mcpOwnerLifecycle.ts, mcpOwnerStagingLease.ts | OS listener PID audit and managed local staging MCP owner with private lease/nonce stop handshake | Existing managed owner is static-bearer, safe-tool, loopback-only; not an OAuth issuer or reboot-installed production service |
| OAuth migration guard | src/core/runtime/mcpOAuthMigrationPolicy.ts | Conservative blocker report; no auto-cutover, token export or live session transfer | Policy is not a real OAuth deployment, client reauthorization or rollout controller |
| Core routing in T-Line | t-line/backend/src/superAgentCorePort.ts, superAgentBridge.ts, superAgentAuth.ts | Optional alternate Core port, port-scoped server-only bearer; fail-closed occupied port checks and explicit resume | Default 7888 legacy path still has eager bootstrap logic; packaged desktop opt-in/real E2E and version-capability handshake not production-certified |
| UI reconnect | t-line/frontend/src/components/SuperAgentConsole.tsx, CoreReconnectBanner.tsx | Read-only health probe, explicit resume button, no automatic chat POST replay | Native installed Tauri process/crash/reopen and multi-workspace acceptance remain separate gates |

### 2.3 Live ownership snapshot and limitations

At the last read-only Windows audit on 2026-10-26:
- Legacy API Core TCP 7888 -> PID 13424, not an authenticated supervised generation.
- MCP OAuth TCP 6789 -> **same PID 13424**.
- MCP OAuth TCP 9877 -> independent PID 10060.
- Therefore ownership decision = shared_owner_do_not_cutover. Stopping 13424 would disrupt API and MCP 6789.
- Current remote MCP state lists two active endpoints; this is an observed snapshot, not a guarantee they stay up or that external OAuth clients are connected.

**Non-negotiable:** no automatic cutover, process kill, tunnel rebind or credential copying against these listeners while shared-owner evidence remains. Re-audit immediately before every staged migration action.

### 2.4 Tests run during this plan audit

- SuperAgent MCP/OAuth/security focused suite: **91/91 passed across 9 test files** (OAuth store/routes/HTTP E2E/resource scope/proxy boundary, HTTP transport, session registry, owner lifecycle, ownership audit).
- T-Line core-port/auth/reconnect focused suite: **10/10 passed across 3 test files**.
- These are local repository tests, not remote CI or a live public OAuth reauthorization / native packaged desktop release certificate.
- Other concurrent modifications were present. Do not stage or overwrite unrelated assistant-task changes, the untracked scripts/mcp-dedicated-local.ts, or the separately authored ACP plan.

## 3. New architecture

    T-Line desktop/backend -- authenticated loopback --> Core API ingress
                                                       |
                                                   Core supervisor
                                                    + workers
                                 (owns agent/chat state, NOT MCP OAuth)

    External MCP client -> dedicated TLS/tunnel ingress (owner C)
                                |
                      verified MCP HTTP owner (owner B)
                       |-- OAuth issuer + client registry
                       |-- MCP session registry + auth scopes
                       |-- MCP tool permission gateway
                       '-- authorized workspace/project execution adapter
                                  |
                       optional scoped Core/project delegation
                       (must be separately authenticated/authorized)

Each owner has independent private config, process identity, discovery, health, credentials, audit, service manager and rollback. OAuth clients must continue to use the legacy endpoint until they individually reauthorize for the new issuer/resource and establish a new MCP session. Never forward credentials silently between domains; keep internal authentication separate from external OAuth.

**Proposed decision (ADR needed in R1):** first migration is *parallel issuer + client reauthorization* instead of raw legacy-token export. Evaluate a new durable authorization store only for NEW independently issued identities, after threat modeling. If durability is selected, persist bounded client metadata and token hashes/expiry/revocation with transactionality, file ACL / system keystore protection for signing/encryption secrets and explicit backup/restore. Do not revive an already-rotated refresh token or restore a pre-crash active MCP session. A Windows DPAPI-backed or supported native keychain abstraction is a candidate, not an already implemented feature.

## 4. New execution plan, replacing phase-number-only sequencing

### R0 / P0 — Freeze the topology and acceptance contract
**Source-first.** Owners: Runtime + Desktop.
- R0.1 Inventory ingress URLs, local ports, PID/parent PID, runtime binary/version, workspace identity, OAuth issuer/resource and service startup paths. Read-only command output must redact secrets.
- R0.2 Compare recorded MCP state with kernel listener, Core supervisor authenticated status, and existing tunnel-specific owner proof. Represent unknowns explicitly (never treat missing state as “safe”).
- R0.3 Record current client authentication flow, active session-drain observability and known external-tool effect/retry constraints; define rollout rollback and owner identity rules.
- R0.4 Create contract tests for owner identity, health/capabilities, port collision, stale lease, unknown listeners and non-deletion of existing external state.

**Deliverable:** Versioned Runtime Ownership Contract (schema and ADR) + read-only audit inventory.
**DoD:** Can show which PID actually owns each listener, which authenticated owner is entitled to stop it, and why Core 7888 is currently blocked; no mutation/secret leak. Reuse coreMcpOwnershipAudit.ts, don't duplicate it.

### R1 / P0 — One independent MCP owner abstraction; consolidate existing scripts
**Consolidate, don't proliferate new daemons.** Owners: MCP runtime.
- R1.1 Define one McpOwnerHost interface: start, authenticated status, drain intent, explicit graceful stop, heartbeat generation, external provider attachment; split policy vs OS operations.
- R1.2 Reconcile mcpOwnerSandbox.ts and mcpOwnerLifecycle.ts with the existing untracked local dedicated-host experiment. Adopt one controlled entrypoint, no separate competing owner registry.
- R1.3 Add process birth identity/generation nonce plus OS listener verification; enforce atomic single-writer lease and collision handling. PID-only proofs, symlinks and stale state remain fail closed; owner close must never affect Core.
- R1.4 Profile-scoped tool permissions/workspace grants and explicit read/write/admin enforcement at each MCP tool dispatch including dynamic gateway.
- R1.5 Add a private, authenticated protocol health endpoint with capability/version/mode (not only unauthenticated HTTP 401), counters and a bounded graceful-drain status; no bearer logged or exposed via UI.

**Deliverable:** production-shaped independent MCP host behind private loopback, with static-bearer staging first.
**DoD:** Owner start/stop survives CLI exit, doesn't spawn a model or tunnel implicitly, refuses duplicate owners, cannot stop other PID, and runs in its own process in repeatable Windows staging.

**Implementation status, 2026-10-26:** R1.1–R1.5 are implemented and locally validated for the **Windows isolated static-bearer staging MCP owner**, including owner host facade, nonce + kernel listener PID + process-birth attestation, hard safe-only dispatch and workspace boundary, authenticated health, drain and graceful stop. Production OAuth and external ingress remain separate R2/R3 tasks; no R7 cutover authorization is implied. Runbook: docs/guides/runtime-owner-r1-private-health-drain.md.

### R2 / P0 — Independently deployable OAuth issuer & credential lifecycle

**Implementation update, 2026-10-26:** An independent opt-in NEW OAuth issuer for isolated loopback staging, with a pluggable OAuth state contract, hash-only/HMAC-protected persisted state, client registration, PKCE S256, refreshed tokens and revocation surviving a simulated process restart, is implemented and validated. It is not certified for production secret storage, transactional durability or public TLS; client migration remains forbidden. Guide: docs/guides/runtime-oauth-r2-staging.md.
**Owners:** Security + MCP.
- R2.1 Extract OAuthStore interface from current in-memory implementation; keep it as reference and implement a pluggable local durable provider only for new credentials if ADR authorizes it.
- R2.2 Define issuer/resource identity and TLS/host/redirect/PKCE contract; register clients intentionally. Validate OAuth metadata, challenge, scope boundaries, refresh-token rotation atomicity and replay revocation across process restarts.
- R2.3 Design service-secret lifecycle: user-owned OS-keystore/DPAPI or equivalent, secure file ACL, encrypted backup, rotation, TTL, no raw bearer/refresh exports and no shared-env accidental inheritance. Test threat model (other local users, log/crash dumps, corrupt storage).
- R2.4 Implement authenticated issuer health and safe fallback: corruption/locked secret storage must block service, never silently reset identity or issue colliding tokens.
- R2.5 Treat existing 6789/9877 tokens and MCP session IDs as NON-transferable; side-by-side reauthorization for clients. Retain previous endpoints until their own drain/revocation is proven.

**Deliverable:** an independent **staging** OAuth owner with real client-registration/PKCE/refresh/revoke E2E and restart tests.
**DoD:** New issuer metadata and resource consistent, PKCE negative tests pass, old credential refresh fails when revoked, newly issued authorization records behave correctly after a controlled issuer restart according to chosen storage ADR; no legacy token import.

### R3 / P0 — Separate tunnel/ingress owner from MCP HTTP and Core

**Implementation update, 2026-10-26:** Separate loopback ingress process with exact kernel PID attachment and route restrictions is running in Windows staging; an ingress restart does not terminate the OAuth owner. The public provider/TLS tunneling contract and live issuer parity are still OPEN, so no public cutover may occur.
**Owners:** Transport.
- R3.1 Introduce a tunnel/ingress attachment contract targeting a verified private MCP owner, never a path or localhost port alone.
- R3.2 Separate existing provider subprocess management from in-process activeServers map in mcpTunnel.ts; retain provider-specific authentication, lifecycle evidence and rollback. No implicit tunnel ownership based on JSON PID.
- R3.3 Provide candidate endpoint routing and exact issuer/resource parity checks. Do not reuse an existing public issuer URL with a new unverified owner.
- R3.4 Bounded session drain: reject new sessions at old owner when explicitly enabled, allow active sessions to finish/expire; expose counts without leaking client IDs. Model unknown in-flight tool effects as blockers.
- R3.5 Verify new endpoint manually with one opted-in test client before broader rollout.

**Deliverable:** side-by-side MCP ingress (old stays active, new staging owner independent).
**DoD:** Restarting a *test-owned Core* doesn't change independent MCP owner PID, HTTP auth, tunnel target or client session. Killing/disrupting a test-owned ingress does not corrupt OAuth state; no production tunnel switched.

### R4 / P0 — Core + T-Line supervised routing contract

**Implementation update, 2026-10-26:** T-Line backend has explicit supervised-external opt-in, kernel TCP PID vs private Core supervisor owner verification, and a guard against falling back to spawning legacy 7888. Backend and frontend builds/tests passed. Installed native T-Line E2E remains OPEN.
**Owners:** Runtime + Desktop.
- R4.1 T-Line must choose Core endpoint from a verified capability/identity manifest and retain per-workspace/session binding. It cannot auto-spawn on an unknown or external-managed port.
- R4.2 Refactor remaining legacy eager-autostart paths: default 7888 backward compatible until operator opt-in; supervised mode uses explicitly selected verified port and does not takeover old process.
- R4.3 Keep restart and drain semantics confined to Core supervisor/worker; no action may kill/restart MCP or tunnel owner. Avoid coupling flags or workspace selection to process restart.
- R4.4 Browser/T-Line reconnect remains GET-only until explicit new session or verified user-approved resume, and never replays accepted chat/tool side effects.
- R4.5 Test CLI version vs bundled runtime vs native installed T-Line backend/renderer, not just source-level React/TypeScript.

**Deliverable:** opt-in, reversible supervised Core mode on installed T-Line.
**DoD:** Multiple workspace sessions and approvals survive Core worker rolling restart where supported; no wrong-session routing, prompt duplication, or MCP PID changes. Unsupervised legacy API never killed.

### R5 / P1 — Windows lifecycle and crash/reboot recovery

**Implementation update, 2026-10-26:** Added fail-closed multi-owner reboot preflight; existing Core Windows per-user task provisioning was validated in PREVIEW mode only. Hardware reboot, task installation and production session recovery remain OPEN and require a dedicated staging machine / operator approval.
**Owners:** Runtime + release.
- R5.1 Plan a single opt-in Windows launcher/service arrangement per owner (Core supervisor, MCP owner, tunnel ingress, T-Line front door); no implicit machine-wide service installation.
- R5.2 Model dependency startup independently: Core can restart while MCP stays connected; MCP OAuth failure does not reset Core; tunnel reconnect does not invent a new issuer identity.
- R5.3 Recovery after OS reboot must use durable owner/effect evidence; Windows PID reuse, delayed exit, locked SQLite, stale leases and clock jumps are explicitly tested.
- R5.4 Preserve old runbooks and explicit operator reconciliation for dead Core workers and uncertain tool effects; no automatic resume from stale checkpoint.
- R5.5 Emit actionable bounded health and alerts in local logs; external alerts require separate opt-in.

**Deliverable:** opt-in local service lifecycle with explicit install/uninstall/backup.
**DoD:** Safe reboot staging drill, correct non-adoption of stale PIDs, no cross-service kill, no secrets in logs, no unverified task replay.

### R6 / P1 — Security, chaos and desktop release gates

**Implementation update, 2026-10-26:** Extended Windows staging canary covers real new-issuer PKCE, refresh/replay/restart, two independently owned ingress+OAuth processes, owner PID and production listener preservation. Added CI workflow coverage. Real remote CI run, threat-model remediation, installed desktop and long soak remain OPEN.
**Owners:** QA + Security.
- R6.1 Threat-model OAuth PKCE/DCR/redirect/issuer/resource attacks, scope escalation through gateway, replay after refresh rotation, corrupted storage and local unauthorized process control.
- R6.2 Automatic tests in isolated profiles: token issuance/revocation, bad redirects, wrong resource, split-owner crash, client disconnect, concurrency, T-Line WS/SSE rejoin, rollbacks and failure-injection.
- R6.3 Run Windows and Linux CI, then true Windows native installed T-Line E2E and long soak (24–72 h) with resource measurements (CPU/RAM/handles/PIDs), reconnect and failure counters.
- R6.4 Gate with reproducible release artifact/runtime versions and clean production secrets audit.

**Deliverable:** release evidence with green CI and a signed/offline release checklist.
**DoD:** No P0 open, no client unexpectedly routed to foreign workspace, negative auth tests green, last known good binaries/leases restorable. Label unsupported scenarios rather than claiming “zero downtime”.

### R7 / P2, explicitly manual — Staged client migration and optional Core cutover

**Implementation update, 2026-10-26:** Added read-only SuperAgent Core rollout audit command for port 7888 reporting exact live blockers with no process or token mutation. Live output remains BLOCKED by shared Core 7888/MCP 6789 PID plus unverified production OAuth/client sessions, keystore/TLS, drain, rollback, desktop and soak. No production client reauthorization or cutover was performed. Guide: docs/guides/runtime-r3-r7-release-gates.md.
**Owners:** Human operator + release.
- R7.1 Deploy new OAuth issuer/ingress in parallel on a *new* endpoint, reauthorize canary clients and inspect external tool/approval outcomes.
- R7.2 Drain legacy MCP sessions; verify live clients, connection and outbound operation counts reach zero (or operator accepts a documented maintenance interruption).
- R7.3 Obtain explicit approval for each routing change; preserve old endpoint and rollback until independent client verification passes.
- R7.4 Only when MCP 6789 no longer depends on legacy Core PID, plan a **separate** supervised Core port 7888 cutover. Do not infer independence from stopping MCP clients alone; verify listener PID ownership again.
- R7.5 Revert client routing on failure; never restore raw legacy OAuth token state or replay an uncertain tool invocation.

**Deliverable:** approved, logged, reversible migration.
**DoD:** Per-client reauth evidence; verified owner separation; no unknown tool outcomes; operator-approved rollback drill; no forced termination of live legacy PID as a migration shortcut.

## 5. Recommended first engineering batch

Execute these **in order** before implementing full durable OAuth:
1. R0.1–R0.4: write the ownership contract/ADR, formalize verified live vs unverified states and add executable topology snapshots.
2. R1.1–R1.3: consolidate owner lifecycle APIs, staging lease semantics and duplicated local owner prototypes. Ensure the previously untracked scripts/mcp-dedicated-local.ts is reviewed, not silently added or removed.
3. R1.4–R1.5: audit gateway nested authorization and introduce authenticated health/capability/drain contract to replace reliance on 401/PID alone.
4. R2.1: extract auth store interface and write ADR for durable new-issued identities vs mandatory client reauth. Only then implement R2.2–R2.5.
5. R4.1–R4.2: ensure T-Line/CLI have a common owner-routing contract before any live endpoint change.

**Do not start with:** copying OAuth token memory, installing task scheduler, binding production port 6789, force-killing PID 13424, moving public tunnel URL, or changing T-Line's default production Core endpoint.

## 6. Test and acceptance matrix

| Scenario | Expected result | Target |
|---|---|---|
| Shared API/MCP PID still owns both ports | CUTOVER BLOCKED; no signals | R0, R7 |
| Managed local MCP owner survives CLI exit | Verified independent OS PID + authenticated health | R1 |
| Malformed/duplicate lease, PID reused, port hijacked | BLOCKED; no cleanup or adoption | R1, R5 |
| Gateway tool asks write/admin under read-only token | DENIED at actual execution dispatch | R1, R6 |
| PKCE wrong verifier/client/resource/redirect | DENIED without any issued token | R2, R6 |
| Refresh token replay or revoked credential | DENIED after rotation/restart | R2, R6 |
| OAuth process crash with new durable issuer | Verified persistence policy; MCP session must reconnect | R2, R5 |
| Core worker restarts while MCP owner stays up | MCP owner PID/session unaffected | R3, R4 |
| MCP ingress restarts while Core stays up | Core unaffected; client reauth/reconnect as required | R3, R5 |
| T-Line loses WS mid-chat | No automatic POST replay; explicit review/resume only | R4 |
| Windows reboot with stale checkpoints | Fail-closed until reconciled; no unknown-PID kills | R5 |
| Native T-Line installed with two workspaces | Correct session routing and approval isolation | R4, R6 |
| Public endpoint/issuer changed without approved migration | Denied/blocked by rollout gate | R3, R7 |

Current relevant baseline (2026-10-26): MCP/OAuth suite 91/91 green; T-Line core port/auth/reconnect suite 10/10 green. These are developer-local focused suites, not end-to-end release gates or proof of external client state transfer.

## 7. Explicit non-goals / no false promises

- No transfer of already active OAuth access/refresh token values from an unsupervised legacy process.
- No migration of live MCP StreamableHTTP sessions, external TCP streams, or in-flight LLM memory across unrelated owners.
- No guarantee of exactly-once external tool effects from a local checkpoint or completion flag alone.
- No auto-stop/adoption of PID 13424, or any other owner without verified process identity and operator control.
- No silent DNS/tunnel reroute, automatic public credentials/issuer reuse, or unsupervised production restarts.
- No production rollout based solely on passing unit tests or the existence of a saved state file.

## 8. Existing documents and change management

This plan is the **preferred forward roadmap** after Phase 5n. Preserve older code, tests and operator runbooks as historical acceptance artifacts; do not erase them simply to align numbering. The old continuously numbered Phase 5 plans should no longer be used as an implicit instruction to implement the next unreviewed module. New work should reference R0–R7, each with a separate narrow commit and independent validation report.

SuperAgent key references:
- docs/plans/2026-10-25-superagent-core-rolling-restart.md (historical Phases 1–5n)
- docs/guides/core-mcp-ownership-phase5m.md
- docs/guides/core-mcp-phase5n-managed-owner.md
- src/core/mcp/mcpHttpTransport.ts
- src/core/mcp/mcpOAuthRoutes.ts
- src/core/mcp/mcpOAuthStore.ts
- src/core/mcp/mcpSessionRegistry.ts
- src/core/mcp/mcpTunnel.ts
- src/core/runtime/mcpOwnerLifecycle.ts
- src/core/runtime/coreMcpOwnershipAudit.ts
- src/core/runtime/coreSupervisor.ts

T-Line key references:
- backend/src/superAgentBridge.ts
- backend/src/superAgentCorePort.ts
- backend/src/superAgentAuth.ts
- frontend/src/components/SuperAgentConsole.tsx
- docs/guides/core-reconnect-phase5e.md

**Change policy:** Inspect Git status before each batch; stage and commit only authored files. Preserve concurrent assistant-task changes and unrelated untracked files. Before any production cutover, new consent/maintenance approval must explicitly identify old/new issuer, client reauthorization plan, affected endpoints, operator rollback and observability evidence.
