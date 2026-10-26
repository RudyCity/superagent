# Runtime R0-R7 — Engineering evidence, 2026-10-26

This is an engineering checkpoint, NOT a production release certificate.
All operations described below use local private stage ports or read-only
live inspection; no legacy listener signals, tunnel swaps, imported tokens,
external notifications, Scheduled Task registration or client cutover.

## Verified on the workstation

| Phase | Verified evidence | Unresolved production evidence |
| --- | --- | --- |
| R0/R1 | R1 independent MCP owner and permission boundary at a6991a0c; R0 background/master plan reviewed | Never adopt live legacy owner without authentic ownership |
| R2 | Independent loopback OAuth owner, PKCE S256/refresh rotation, restart persistence, Windows CurrentUser DPAPI; writer lock and immutable client ID/redirect validation | Certified transactional credential store, production ACL/key backup & restore, consent hardening, public OAuth client E2E |
| R3 | Separate loopback ingress PID, OS target owner verification, forwarded-header filtering, negative endpoint tests; exact public issuer/resource parity assessment | Public TLS tunnel with identical discovery/resource issuer, edge identity verification and safe reverse route |
| R4 | Supervised-external T-Line source guards; unavailable port never spawns replacement; native 1.3.728 MSI and NSIS packages successfully built | Installer installation and native two-workspace/session/reconnect E2E on a test Windows profile |
| R5 | Core per-user logon Scheduled Task PREVIEW for 7888 and 7892, six negative cold recovery tests, all production restart/replay decisions denied | Real Windows reboot / power loss and stale PID, owner recovery, checkpoint, task persistence exercises |
| R6 | 16 test suites, 106 Vitest tests passing in SuperAgent; T-Line 6 suites/17 tests passing; CI security matrix configured for Windows/Linux | Actual remote CI execution, OS-keystore ACL/certificate checks, 24–72h soak, signed operator review |
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
