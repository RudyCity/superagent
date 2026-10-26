# Independent Runtime Activation and End-to-End Release — P1–P4 Execution Plan

**Date:** 2026-10-26
**Status:** READY FOR IMPLEMENTATION — production cutover BLOCKED
**Priority:** P0 critical path; complete existing capabilities before feature expansion
**Repositories:** SuperAgent runtime + T-Line desktop (separate repositories)
**Parent roadmap:** [Runtime Ownership and Safe Recovery R0–R7](2026-10-26-runtime-ownership-and-safe-recovery-master-plan.md)
**Current evidence:** [2026-10-26 R0–R7 engineering evidence](../guides/runtime-r0-r7-2026-10-26-evidence.md)

> This is an executable implementation plan, not a certificate, release authorization,
> proof of current online availability or approval to change production routing.
> Complete milestones using real evidence, not a passing unit-test count.

## 1. Decision and fastest safe path

**Decision:** keep the legacy Core/MCP owners serving existing clients, activate
an independently owned next-generation stack in a separate private profile,
complete real installed-desktop and new OAuth client journeys against it,
collect recovery/security/soak evidence, then migrate ONE explicitly approved
client at a time. Never use a forced stop of a shared legacy PID as a shortcut.

**Critical path:**

```text
G0: topology freeze + owner evidence
  |
  v
P1-A: independent Core/MCP owners  -----> P2: installed desktop E2E
  |                                              |
  +--> P1-B: durable OAuth + TLS ingress --------+
                       |                         |
                       +------> P3: reboot + security + soak
                                         |
                                         v
                                  G3: release review
                                         |
                                         v
                             P4: canary client reauthorization
                                         |
                                         v
                             G4: reversible client-by-client migration
```

Start P2 once a verified private Core exists. Start P3 observation as soon
as the isolated stack is genuinely stable; do not wait for desktop polish
before collecting non-disruptive measurements. OAuth/TLS testing and T-Line
native testing may proceed in parallel on distinct resources.

**Stop adding unrelated features** to the release branch until G3. Use
existing modules and tests; do not build another parallel supervisor, MCP
registry, OAuth state engine or process launcher unless a verified gap
requires it.

## 2. Known state and precise gap list

| Area | Existing evidence (as of this plan) | Still required to ship |
| --- | --- | --- |
| R0/R1 ownership | Independent MCP owner abstraction, authenticated local status, kernel PID/nonce checks, isolated owner lifecycle tests | Actual long-running separate owner deployment with authenticated lifecycle evidence |
| R2 OAuth | Isolated issuer, PKCE S256, refresh/revoke/restart, DPAPI CurrentUser, backup/restore rehearsal | Transactional production-safe persistence, hardened account/ACL/key backup, real external test-client consent and continuity |
| R3 ingress | Separate local ingress process; test coverage and public metadata parity assessor | Provider-owned HTTPS ingress, TLS trust, real discovery parity and tested tunnel rollback |
| R4 T-Line | Opt-in `supervised-external` routing and fail-closed no-spawn/no-replay safeguards; native installers have previously been built | Install the **current** build on Windows and demonstrate actual two-workspace, approval, reconnect, independent worker restart |
| R5 Windows | Cold-recovery policies and staging-only startup-task guard; task preview tested | Dedicated test Windows reboot and recovery/rollback of separately owned processes |
| R6 | Local regression 20 suites / 136 tests green; isolated OAuth/ingress smoke previously passed 20 checks; read-only monitor available | Real remote CI status, 24–72-hour continuous soak, signed evidence, failure injection on installed stack |
| R7 | Read-only global and per-client migration evidence gates | Operator-attested client authorization, zero/drained old sessions, reconciled effects, real route/revert of opted-in canary |

**Last live topology snapshot:** Core TCP `7888` and MCP OAuth TCP
`6789` share kernel PID `13424`; another MCP OAuth listener `9877`
was PID `10060`. These are historical observations, not current
authorization or durable PID identity. Re-run the read-only inventory before
every stage or routing decision. The release gate remains `blocked`.

**Safety invariants:**

1. Do not stop, adopt, restart or signal the shared legacy Core/MCP PID.
2. Do not reuse legacy ports `7888`, `6789` or `9877` in the new stage.
3. Do not copy existing OAuth access/refresh tokens, signing keys, or MCP
   session IDs into the new owner.
4. A locally reachable port or JSON PID record is not authenticated ownership.
5. Do not replay accepted chat/tool POSTs or ambiguous external side effects.
6. No public tunnel/DNS/client reroute without a distinct explicit release gate.
7. Keep private credentials and client-specific secrets out of Git, logs and
   broadly shared evidence artifacts.
8. Do not overwrite unrelated worktree modifications in either repository.

## 3. Workstream ownership and parallel implementation

The coordinating agent owns the plan, dependency board, review and merge;
implementation agents operate in isolated branches/worktrees. The agent
coordinator must not modify source code on behalf of implementation workers.

| Workstream / branch | Agent responsibility | Dependencies | Integration gate |
| --- | --- | --- | --- |
| WS-A `work/runtime-p1-owner-split` | MCP/Core owner lifecycle, authenticated capability contract, process separation, private canary | G0 | G1A |
| WS-B `work/runtime-p1-oauth-ingress` | New issuer persistence, TLS ingress, security and real OAuth client stage | WS-A private owner contract | G1B |
| WS-C `work/tline-p2-native-e2e` (T-Line repo) | Installed desktop routing, two workspaces, reconnect/approval acceptance, installer provenance | G1A | G2 |
| WS-D `work/runtime-p3-recovery-cert` | Staging Windows lifecycle, reboot drill, soak, chaos and release evidence | G1A + G1B for final sign-off | G3 |
| WS-E `work/runtime-p4-client-migration` | Client inventory, PKCE reauthorization, drain, reversible routing and rollback | G3 + operator approval | G4 |

**Coordination protocol:** delegate scoped tasks, inspect each branch's
diff/tests, merge per gate, record commit SHA and artifact checksums,
re-run integration smoke on the merged revision. Never merge all
workstreams blind. Resolve shared interfaces before independent editing
to avoid competing edits to `mcpHttpTransport.ts`, Core owner files,
runtime routing and release scripts.

**Single source of truth:** this execution plan tracks remaining tasks;
the older R0–R7 roadmap describes architectural background. Each completed
task must update its evidence entry here and the R0–R7 evidence file.
Commit each implemented change, with version/changelog per repository
policy; do not stage pre-existing unrelated files.

## 4. G0 — Baseline and isolation (required first)

- [ ] **G0.1** Capture read-only listener inventory, authenticated supervisor
  identity, tunnel registration, Core/MCP process birth identity, active
  MCP OAuth modes and existing stage profiles. Redact credentials.
- [ ] **G0.2** Capture clean or explicitly partitioned worktree baseline in
  BOTH repositories, current commit SHAs, installed T-Line version and
  package artifacts. Separate unrelated active changes from release work.
- [ ] **G0.3** Create private staging directory and dedicated port map.
  Prefer existing standalone supervised Core staging port `7892` only
  after verifying it is test-owned; otherwise select a fresh unused
  nonlegacy port. Use fresh separate ports for OAuth and ingress.
- [ ] **G0.4** Record a rollback reference for each current legacy endpoint
  and a process kill/stop allowlist containing **only** verified canary owners; never stop by numeric PID alone.
- [ ] **G0.5** Save redacted baseline evidence in an operator-controlled,
  timestamped location outside tracked source; include evidence ID here.

Read-only baseline commands:

```bash
bun src/cli.tsx core ownership-inventory --port 7888
bun src/cli.tsx core rollout-audit --port 7888
bun scripts/verify-runtime-security-release-r6.ts 7888
```

**G0 exit:** legacy stays online, new ports/profiles isolated, rollback
owner list recorded. Release state remains blocked.

## 5. P1 — Independent runtime plus OAuth/HTTPS

### P1-A — Owner split and authenticated readiness

- [ ] **P1-A.1** Run existing owner lifecycle and split tests. Reuse R1
  host/lifecycle, Core supervisor, OS kernel PID/process-birth proof and
  private authenticated owner health. Patch failures instead of creating
  competing supervisors.
- [ ] **P1-A.2** Launch test-owned Core and MCP on distinct, nonlegacy
  ports, OS PIDs, process generations, private profiles, leases and
  credential domains. Prefer existing canary Core port 7892 only if
  authenticated test ownership is established again.
- [ ] **P1-A.3** Verify authenticated capability/version handshake, safe
  tool exposure, permission gate at execution, and project isolation.
- [ ] **P1-A.4** Restart only the test-owned Core worker; confirm MCP
  remains reachable with the SAME authenticated owner PID and credentials.
- [ ] **P1-A.5** Restart only the test-owned MCP; confirm Core remains
  alive and clients must initialize fresh MCP sessions as appropriate.
- [ ] **P1-A.6** Test stale owner, duplicate port, reused PID, missing
  nonce and unverifiable process start; none may adopt/kill a legacy owner.

Existing checks:

```bash
bun scripts/verify-managed-mcp-lifecycle.ts
bun scripts/verify-core-mcp-owner-split.ts
bun --bun x vitest run tests/mcpSafeOwnerR1.test.ts tests/mcpProcessBirthR1.test.ts
```

**G1A exit:** verified distinct Core/MCP kernel PIDs, authenticated owner
identities, independent failure/recovery, unchanged legacy listeners.

### P1-B — New issuer, durable credentials, real ingress

- [ ] **P1-B.1** Re-evaluate the existing atomic-file/HMAC, writer lock,
  DPAPI, offline backup and refresh lifecycle against concurrency.
  Introduce a transactional new-issuer credential store only where
  required by failure tests; never import legacy token material.
- [ ] **P1-B.2** Cover client registration, redirect URI, consent abuse,
  PKCE S256, resource audience, scope enforcement, refresh-token replay,
  revocation and crash-restart consistency.
- [ ] **P1-B.3** Verify restricted Windows service identity/ACL,
  OS-protected signing material, synchronized state/key recovery,
  and denial on corrupt/locked state. User-scoped DPAPI alone is not
  production account separation.
- [ ] **P1-B.4** Deploy a distinct new HTTPS ingress using an explicitly
  configured domain/provider. Verify trusted TLS and exact public
  issuer/resource/discovery parity, authenticated private upstream,
  forwarded header filtering and private endpoint exclusions.
- [ ] **P1-B.5** Exercise ONE genuinely new OAuth test client end-to-end:
  register, consent, PKCE exchange, initialize session, permitted tool,
  rotate refresh token, restart independent issuer, replay denied,
  revoke and reauthorize.
- [ ] **P1-B.6** Fault isolated ingress, issuer and client connection in
  turn; verify separation, failing closed and independently tested rollback.
  Keep legacy tunnels/ports unchanged.

Existing verification:

```bash
bun scripts/verify-independent-oauth-stage.ts
bun --bun x vitest run tests/mcpOAuthStageBackupR2.test.ts tests/mcpPublicIssuerParityR3.test.ts tests/mcpIngressStageR3.test.ts
```

**G1B exit:** external test client authenticates with an independent
public HTTPS issuer and a scoped MCP session; refresh/revoke/restart and
public metadata parity verified. Retain real TLS/OS secret evidence.

## 6. P2 — Installed T-Line end-to-end

- [ ] **P2.1** Rebuild current T-Line revision into a native MSI/NSIS
  canary. Record source SHA, desktop/backend version and installer SHA-256.
  Old installer 1.3.728 hashes do not certify later code changes.
- [ ] **P2.2** Install on a dedicated Windows test account, not only run
  the source development server. Verify installed backend/renderer/Core
  runtime compatibility and browser bridge.
- [ ] **P2.3** Opt in only to authenticated external Core: use
  `TLINE_SUPERAGENT_OWNER_MODE=supervised-external`,
  `TLINE_SUPERAGENT_CORE_PORT=<verified-stage-port>` and matching
  `SUPERAGENT_CONFIG_DIR` private supervisor profile.
- [ ] **P2.4** Create two simultaneous workspaces and sessions. Test
  chat, multi-agent timeline, tool permissions, human approval,
  cancel and cross-workspace isolation against actual server audit data.
- [ ] **P2.5** Interrupt desktop bridge, websocket and worker in the
  middle of separate tasks; recover without duplicate accepted
  chat/tool POST or misplaced session approvals.
- [ ] **P2.6** Independently restart stage Core worker, MCP and ingress;
  verify desktop recovery UX and old production listener continuity.
- [ ] **P2.7** Capture installed UI screenshots, redacted action logs,
  endpoint owner evidence and exact package revision. Test reversal
  to prior known-good *test* installation and routing.

Regression:

```bash
bun --bun x tsc --noEmit --project backend/tsconfig.json
bun --bun x vitest run backend/tests/superAgentCoreOwnershipR4.test.ts backend/tests/superAgentAuthenticatedOwnerR4.test.ts backend/tests/superAgentExternalPortUnavailableR4.test.ts backend/tests/superAgentCorePort.test.ts backend/tests/coreReconnectSafety.test.ts backend/tests/superAgentAuthConfig.test.ts
```

**G2 exit:** native installed T-Line works across two concurrent
workspaces, keeps approval/session identity, reconnects without replay,
and does not own or kill MCP/Core legacy listeners.

## 7. P3 — Windows recovery, security and release certification

### P3-A — Genuine reboot and failure recovery

- [ ] **P3-A.1** Prepare a dedicated staging Windows machine/account;
  capture encrypted test-only data backup and last-known-good binaries.
- [ ] **P3-A.2** Review the stage-only Task Scheduler R5 guard. Install
  per-owner tasks only on new test ports/profiles. Never use --apply for
  Core 7888 or MCP 6789/9877.
- [ ] **P3-A.3** Actually reboot the isolated test Windows machine.
  Verify owner identity and startup dependency behavior for Core,
  MCP, OAuth issuer, ingress and installed desktop.
- [ ] **P3-A.4** Inject stale PID, PID reuse, bad checkpoint, locked
  storage, missing DPAPI key, stale lease and unconfirmed external
  tool effects. Refuse adoption/deletion/replay when evidence is unknown.
- [ ] **P3-A.5** Rehearse staged offline state+key restore without
  reviving already revoked or rotated test credentials. Document
  operator reconciliation and recovery of broken components.
- [ ] **P3-A.6** Remove only verified test-owned Scheduled Tasks and
  check production services and legacy ports remain unchanged.

### P3-B — CI, soak and signed release manifest

- [ ] **P3-B.1** Observe actual Windows and Linux CI workflows,
  recording run URL/commit SHA, not only YAML definitions.
- [ ] **P3-B.2** After a stable G1 stack, collect uninterrupted
  **24–72h** CPU/RAM/handle/PID, reconnect, permission and
  external-effect telemetry. Missing samples must not be treated
  as successful time.
- [ ] **P3-B.3** Repeatedly test test-owned worker failure, OAuth
  refresh/revoke, ingress disconnect, concurrent sessions and
  explicit recovery. Flag unexplained crashes and duplicate effects P0.
- [ ] **P3-B.4** Assemble exact binaries, SHA-256 manifests,
  TLS identity, Windows ACL/secret audits, screenshots, CI run IDs,
  reproducible reboot logs, soak duration, negative test outcomes,
  operator rollback drills and unresolved risks.
- [ ] **P3-B.5** Obtain an explicit security/release review with
  documented decision. Do NOT set productionCertified=true from
  local tests or an attractive dashboard.

Read-only short sample (not a soak certificate):

```bash
bun scripts/observe-runtime-soak-r6.ts 6 2
```

A supervised extended observation may use
`bun scripts/observe-runtime-soak-r6.ts 86400 30`, but the
foreground process must remain alive and an external test evidence
collector must retain the result; no task or background completion
is implicitly scheduled.

**G3 exit:** no open P0, complete and authentic issuer/TLS/secret,
installed desktop, actual Windows reboot, extended soak,
remote CI, verified rollback and approved release certificate.

## 8. P4 — Controlled client-by-client migration

- [ ] **P4.1** Privately inventory each external MCP client, old
  issuer/resource, credential owners, sessions and rollback path.
  Store only SHA-256 fingerprints in tracked evidence.
- [ ] **P4.2** Choose exactly one opted-in test/canary client.
  Require G3 with signed operator approval before any production
  route mutation.
- [ ] **P4.3** Reauthorize via new public issuer with S256 PKCE and
  verified resource audience, then initialize a fresh MCP session.
  No legacy access/refresh/session tokens are transferable.
- [ ] **P4.4** Verify authenticated safe tool use, restricted scopes,
  approvals, reconnect and credential rotation with the REAL client.
- [ ] **P4.5** Prove old client sessions are drained (or maintenance
  impact approved), zero ambiguous external tool effects and a
  verified reverse route. An absent metric means unknown, not zero.
- [ ] **P4.6** Route only that client with explicit approved change.
  Keep legacy endpoint running and freeze the next client until
  monitoring and rollback have passed.
- [ ] **P4.7** On failure, revert the one client, reauthorize where
  required and reconcile unfinished side effects. Do not replay
  unknown external tool calls.
- [ ] **P4.8** Repeat individually; migrate Core default routing
  in a SEPARATE later review after authenticated verification that
  MCP 6789 no longer shares the legacy Core process.

Read-only gate: `bun src/cli.tsx core rollout-audit --port 7888`;
per-client gate: `src/core/runtime/runtimeClientMigrationR7.ts`.
`operator_canary_review_candidate` is not authorization to
automatically change routing.

**G4 exit:** all intended clients reauthorized, validated, drained and
reversibly migrated under explicit per-client operator approval.
Legacy owner retirement remains a separate maintenance activity.

## 9. Release gate matrix and rejection criteria

| Gate | Pass only with | Block/revert on |
| --- | --- | --- |
| G0 | Live read-only topology, private stage port map and legacy fallback | Unknown ownership or mutable secret leak |
| G1A | Distinct authenticated owner PIDs and independent restart | Core restart affects MCP or foreign PID adopted |
| G1B | Correct TLS issuer/resource discovery, PKCE, durable refresh and new client session | Wrong audience, proxy bypass, credential replay |
| G2 | Installed native desktop, two workspaces, approval/reconnect/no replay | Cross-session routing, duplicated tool/chat action |
| G3 | Physical staging reboot, OS keystore, actual CI and 24–72h soak, reviewed recovery | Missing evidence, untracked crash or unresolved P0 |
| G4 | Per-client new authorization, zero/drained old sessions, verified rollback and signed approval | Unknown effects, unverified owner, no reverse route |

Definition of done: **G1A + G1B + G2 + G3 + G4 all have
reproducible real-environment evidence.** Labels must distinguish
IMPLEMENTED, STAGING_VERIFIED, CERTIFIED, MIGRATED, BLOCKED.

## 10. First vertical implementation batch

1. **WS-A:** read-only audit + stage Core/MCP owner split; save
   authenticated distinct-process evidence. Fix only real blockers.
2. **WS-B:** stage issuer+ingress and one test OAuth session.
   Use failing concurrency/TLS/security tests to scope changes.
3. **WS-C:** simultaneously prepare and install a native T-Line
   canary with two-workspace/reconnect acceptance.
4. **WS-D:** prepare separate Windows staging reboot and start
   monitoring once the independent stack is stable.
5. **Coordinator:** review branches, run build/tests on merged
   revision, record commit/release artifact SHA and gate blockers.
6. **WS-E:** no actual client switch until G3 and explicit approval.

**Earliest useful milestone:** authenticated private Core and MCP
owners plus a new OAuth test client on the isolated stack, with
native T-Line E2E in progress. Do not confuse it with production release.

## 11. Required evidence per task

```text
Task ID / gate / status:
Repository / branch / exact commit:
Implementation agent / reviewer:
Test-only environment and profile:
Read-only owner inventory before/after:
Commands and actual test results:
Authenticated PID/process birth evidence:
Expected and observed behavior, incl. failures:
Build SHA-256 / CI links / screenshot references:
Security and unknown-effect assessment:
Last-known-good revision and tested rollback:
Operator approval (only if actually recorded):
Status = NOT_STARTED | IMPLEMENTED | STAGING_VERIFIED | CERTIFIED | BLOCKED
```

Never commit secrets, raw OAuth client identifiers, issuer key material,
consent bootstrap codes, access/refresh tokens, or personally identifying
records. Keep evidence in private operator-controlled storage.

## 12. Boundaries and references

- No unrelated desktop redesign, agent feature expansion or codebase-wide
  refactor as part of this critical-path release.
- No unsupervised reboot of an active machine, PID 13424 termination,
  legacy OAuth token copying, old-tunnel reroute, automatic POST replay
  or DNS/public endpoint changes without a separate approval.
- No promise of ongoing background work without an observable,
  configured job and completed evidence.
- Reuse existing R0–R7 architecture plan and the runtime guides under
  `docs/guides/` for owner, OAuth, ingress, security and client policy.
- Components and tests must remain modular; add new abstractions only when an acceptance test proves a missing contract.
