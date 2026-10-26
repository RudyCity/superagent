# Runtime R0-R7 — Engineering evidence, 2026-10-26

This is an engineering checkpoint, NOT a production release certificate.
All operations described below use local private stage ports or read-only
live inspection; no legacy listener signals, tunnel swaps, imported tokens,
external notifications, Scheduled Task registration or client cutover.

## Verified on the workstation

| Phase | Verified evidence | Unresolved production evidence |
| --- | --- | --- |
| R0/R1 | R1 independent MCP owner and permission boundary at a6991a0c; R0 background/master plan reviewed | Never adopt live legacy owner without authentic ownership |
| R2 | Independent loopback OAuth owner, PKCE S256/refresh rotation, restart persistence, Windows CurrentUser DPAPI; writer lock, immutable client ID/redirect validation, offline paired-key/snapshot staging restore rehearsal | Certified transactional credential store, production ACL/key backup & restore, consent hardening, public OAuth client E2E |
| R3 | Separate loopback ingress PID, OS target owner verification, forwarded-header filtering, negative endpoint tests; exact public issuer/resource parity assessment | Public TLS tunnel with identical discovery/resource issuer, edge identity verification and safe reverse route |
| R4 | Supervised-external T-Line source guards; unavailable port never spawns replacement; native 1.3.728 MSI and NSIS packages successfully built | Installer installation and native two-workspace/session/reconnect E2E on a test Windows profile |
| R5 | Core per-user logon Scheduled Task PREVIEW for 7888 and 7892, six negative cold recovery tests, all production restart/replay decisions denied | Real Windows reboot / power loss and stale PID, owner recovery, checkpoint, task persistence exercises |
| R6 | 17 test suites, 114 Vitest tests passing in SuperAgent; T-Line 6 suites/17 tests passing; CI security matrix configured for Windows/Linux | Actual remote CI execution, OS-keystore ACL/certificate checks, 24–72h soak, signed operator review |
| R7 | SHA-256-fingerprinted client-by-client, PKCE/audience/refresh/drain/rollback evidence gate, always read-only | External client reauthorization, legacy session drain, external tool reconciliation and reversible individually authorized migration |

The independently launched local OAuth + ingress smoke script reported 20/20
checks passing after the latest rebuild of SuperAgent CLI 1.14.36, with
unchanged live production listener PIDs. The local R6 release-evidence
script reported localChecksPassed=true and productionCertified=false.

Current live ownership at observation: Core 127.0.0.1:7888 and MCP
127.0.0.1:6789 share kernel PID 13424, while legacy MCP 9877
is PID 10060. These PIDs are snapshots, not durable proof of identity:
always rerun a read-only ownership inventory before further action.
The live release decision remains BLOCKED. In particular, do not
terminate PID 13424, replay external effects, import old OAuth tokens,
take over the 6789 listener or silently migrate clients.

## Native package provenance (locally built, not installed)

Source repository: t-line; source version 1.3.728. Build frontend, backend,
Rust/Tauri, Wix MSI and NSIS completed successfully.

- desktop-tauri/src-tauri/target/release/bundle/msi/t-line_1.3.728_x64_en-US.msi
  - bytes 45,466,896; SHA-256 e938d3efe4c4b989f5e8a9204c8bc546cdf345fbb4b90a9f2133cad5b30b3455
- desktop-tauri/src-tauri/target/release/bundle/nsis/t-line_1.3.728_x64-setup.exe
  - bytes 34,524,235; SHA-256 0676ba3ac0bd023f6cbd6621da9758a54f0600c6f8758a7c54914337ab07f2c8

SHA-256 establishes local artifact identity, not code signing or native
installer runtime validation. Existing installation has not been changed.

## Operator-gated continuation

1. Verify certified dedicated owner identities and secure production OAuth
   key backup/restore (including a distinct non-production rehearsal).
2. Provision public ingress/TLS in a separate test deployment and compare
   real issuer, resource and endpoint metadata (including redirect parity).
3. Run installed native desktop canary with concurrent workspaces, approval,
   reconnect, Core worker restart and no POST replay while MCP stays alive.
4. Test real Windows reboot and recover isolated owners from previously
   authenticated checkpoints with unknown-effects quarantined.
5. Measure required extended soak, reconcile tool effects and obtain signed
   release evidence. Do not invent operator approval.
6. Reauthorize individual external clients with PKCE and verified audience.
   After confirmed zero old sessions and rollback drill, approve and execute
   one reversible endpoint migration at a time, never wholesale auto-cutover.

Read-only audit: bun src/cli.tsx core rollout-audit --port 7888
Live inventory: bun src/cli.tsx core ownership-inventory --port 7888
OAuth private stage: bun scripts/verify-independent-oauth-stage.ts

## R2 additional offline staging recovery verification (follow-up)

Added src/core/mcp/mcpOAuthStageBackupR2.ts and
tests/mcpOAuthStageBackupR2.test.ts. The helper accepts only directories
beneath ~/.superagent-local-staging, refuses lock-held snapshots, live
Windows loopback listeners, reusing existing destinations, symlinks/hard
links and mismatched key/issuer/checksum material. The paired snapshot
and protected key can be restored into a fresh staging profile and
refresh-token rotation remains valid using the same Windows user DPAPI.
No legacy or production OAuth file is read or exported by this helper.

After rebuilding SuperAgent 1.14.36, the expanded local cross-domain
security suite reported 17/17 files and 114/114 tests passing.
No physical reboot, real hot-backup consistency, OS ACL certification,
public ingress TLS, installed desktop E2E or live migration is implied.

## R6 short live OS monitoring follow-up

A new foreground read-only monitor
`scripts/observe-runtime-soak-r6.ts` observes kernel PID identities and
CPU/working-set/handle counters of existing local Core and MCP listeners,
without HTTP writes, signals or tunnel operations. During the brief
2026-10-26 observation, kernel PIDs stayed at 13424 for Core 7888 and
MCP 6789, and 10060 for MCP 9877. This short sample does NOT count as
a 24–72-hour production soak, and does not certify an independent owner.
Read-only assessor: `src/core/runtime/runtimeReadOnlySoakR6.ts`.

The monitoring policy adds eight negative tests. Re-run of the expanded
cross-domain R6 suite on 2026-10-26 passed 18/18 test files (122/122
individual tests). The current R6 owner-monitor implementation remains
read-only, foreground-only and never sets productionCertified=true.

## R5 startup hardening follow-up

`--apply` on `setup-core-windows-startup.ts` is now guarded by an
isolated profile, legacy-port exclusion, Task Scheduler task absence,
live OS listener absence and an empty cold-start namespace. The staging
launcher explicitly targets its separate SUPERAGENT_CONFIG_DIR.
Existing production Core 7888 and MCP 6789 were not restarted;
no logon task was installed by this work.

Build after R5 startup guard changes: SuperAgent 1.14.36 compiled
successfully and 20/20 cross-domain Vitest suites passed (136/136 tests).
A real isolated staging --profile preview on port 7903 was performed
without creating any launcher or Scheduled Task. An actual --apply attempt
for legacy 7888 with no staging profile was refused before any OS mutation.
These results do not replace Windows reboot verification or the final
production installation certificate.


## G0 -> P1-A independent restart proof (later 2026-10-26 snapshot)

The read-only inventory no longer matched the previous shared-PID
snapshot: Core 7888 was an unauthenticated PID 38608, MCP OAuth 6759
was PID 45176, MCP OAuth 9877 was PID 10060, and 6789 had a stale
state record without a TCP listener. This is a temporal observation,
NOT proof that either old owner is safe to stop or transfer. The global
R6/R7 gate still reports BLOCKED; no authenticated production Core
supervisor, external OAuth session drain or public ingress certificate
was obtained.

SuperAgent 1.14.37 local Windows build passed. Repeated isolated
Core/MCP acceptance at test-owned Core 62532 and MCP 62533 verified
16/16 checks: separate PID 47276/49828, authenticated private Core
supervisor, bearer-only MCP, test Core worker roll from 49612 to
39212, unchanged MCP PID and authorization after the roll, and
unchanged legacy listeners (6759/6789/7888/9877). After cleanup both
ephemeral listeners were verified released. Managed MCP owner
lifecycle independently passed 17/17 checks, including authenticated
generation, duplicate owner refusal, drain and graceful stop without
a process signal; the private owner release was confirmed. Five
focused policy test files passed 26/26 cases.

This establishes isolated staging P1-A.1/A.2/A.4 evidence. It does
NOT establish durable standalone services, independent public OAuth
ownership, a running desktop integration or production certification.
The ephemeral canary is intentionally torn down, not left in the
background; no installed startup task or production process was touched.
The operator-held stage report was written under
`~/.superagent-local-staging/core-mcp-owner-EFTYhn/report.json`.
The new execution plan tracks the remaining stages.


Final local regression after source and documentation changes:
SuperAgent 1.14.38 built successfully; 20 R1–R7 test files,
136/136 tests passed. This is not remote CI, an installed desktop
certification or an authorization to change legacy endpoints.


## New issuer and independent ingress P1-B staging continuation

On 2026-10-26 `bun scripts/verify-independent-oauth-stage.ts`
passed all 20 real HTTP staging checks using a new test client and
isolated DPAPI CurrentUser issuer state. It verified client
registration, S256 PKCE/consent/token exchange, independent ingress
owner PID, private owner control excluded from ingress, issuer
restart, refresh persistence, rotated refresh replay rejection,
immutable redirect and MCP initialize with the restarted issuer.
The new canary port 64261 was verified released after the test.

The verifier now explicitly protects all observed legacy listener
ports (6759, 6789, 7888, 9877), including a missing/stale 6789
listener: the before/after kernel listener map must be identical.
No OAuth credential was imported, no public TLS ingress or tunnel
was created, and no existing client was reauthorized or migrated.
G1B remains BLOCKED pending real HTTPS, hardened credentials,
permissioned external client E2E and rollback.


## G1A Core-only versioned ownership handshake (2026-10-26)

SuperAgent 1.14.40 now reports an explicit private control-plane
ownerContract v1 (Core supervisor role, no MCP lifecycle ownership,
explicit-only replay). The real isolated split owner verifier passed
17/17 checks with this contract; managed MCP stage separately passed
17/17 lifecycle checks. Protected port 6759 was added to the staging
owner denylist. Source-level T-Line opt-in owner checks passed 18/18
tests and reject forged/unsupported owner-contract versions and
incompatible replay/MCP policies. No installed T-Line E2E is implied.

The R1–R7 combined local Vitest regression passed 22/22 test files
(145/145 tests). SuperAgent TypeScript passed. A repeat full
SuperAgent build exposed a Windows EUNKNOWN on overwriting an
identical compiled font asset; making the sync compare content and
skip redundant writes recovered the full build successfully. This
is engineering evidence only, not a Core/MCP long-running service
certificate or a public HTTPS deployment.
