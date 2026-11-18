# Permissions & tools remediation — execution ledger

Date: 2026-11-18
Master plan: [2026-11-18-superagent-permissions-tools-remediation-master-plan.md](./2026-11-18-superagent-permissions-tools-remediation-master-plan.md)
Security threat model: [Native desktop mediation](../security/2026-11-18-desktop-native-mediation-threat-model.md)

**Overall state: PARTIAL IMPLEMENTATION. NOT runtime verified. NOT released.**
Definitions: Implemented=source reached main; Tested=passing exact-HEAD CI; Runtime Verified=attested installed source/build/owner; Released=versioned accepted signed artifact. Pending, cancelled, prior-HEAD or red tests are not green.

| Slice / owner / priority | Code, evidence and acceptance | Implemented | Tested | Runtime Verified | Released | Blocker / next |
| --- | --- | --- | --- | --- | --- | --- |
| M0 CI / Core+QA / P0 | OAuth label rotation, duplicate declaration, negative host policy test, expanded Windows/macOS/Linux security and Tray suites; commits 2d5dc2da and ec57fb38 | Partial | Pending exact HEAD | No | No | Complete cross-platform focused tests + Bun typecheck/build; earlier 2d5 CI red |
| M1 owner parity / Native+Core / P0 | Core/MCP/Tray owner, build and WebView attestation must match running binary, then read-only safe lifecycle plan | Prior service inventory exists | No | No | No | Core OWNER_UNVERIFIED, Tray unmanaged, MCP release digest missing. No unsafe adoption/restart |
| M2 permission trace / MCP security / P0 | Added explicit bounded layered codes and nonexecuting Desktop UI preflight; test mcpPermissionDecision and mcpApprovalAndFilePolicy; commit 79b8db08 | Partial | Pending exact HEAD | No | No | General tool/host/native parity and further negative integration tests needed |
| M3 exact read receipt / Tray native / P0 | Access Manager JS focus must find exact request before notification read; commit f89f4f1f | JS only | Pending exact HEAD | No | No | Signed, principal-bound, owner-attested native receipt NOT implemented |
| M4 desktop broker / Native security / P0 | Security threat model committed; arbitrary window inspection remains denied | Design only | No | No | No | Reviewed OS mediator, protected-file negative cases, stale target tests |
| M5 approvals/UX / Tray+MCP / P1 | OAuth owner label survives refresh; JS notification navigation and read-on-focus partial | Partial | Pending exact HEAD | No | No | Complete pending-load UX, two independently authenticated MCP clients and native read ACK |
| M6 OS banners / Native Tray / P1 | Generic Core failure OS alerts avoid raw exception/path disclosure; commit ec57fb38 | Partial | Pending exact HEAD | No | No | Secure signed expiring OS click activation, replay tests, cold/minimized Tray |
| M7 release / Release owner / P0 | Green CI, Windows-installed, two PCs/physical Android as applicable, signed artifacts and immutable release evidence | No | No | No | No | Every critical gate open |

## Read-only live observation
- Core :7888 responded but **ownershipVerified=false**, doctor blocker CORE_RECYCLE_OWNER_UNVERIFIED.
- MCP :9227 active and owner verified; backendReleaseDigest=null, therefore no proof current GitHub changes were loaded.
- Tray: no verified managed owner; Guardian: unverified. Never assume a responsive port means safely owned process.
- No restart, deployment, forced kill, grant change, signing or runtime adoption occurred.

## Checkpoints and next actions
1. Correct failing regression tests without weakening gates; keep per-OS runs and preserve unrelated work. One LAN terminal test in earlier run 44265735978 mistakenly expected 1 argument; actual start contract takes device ID and command.
2. Wait for success on the exact latest source SHA, not older cancelled workflow attempts. Evidence: [Actions](https://github.com/RudyCity/superagent/actions).
3. Verify Core, MCP and Tray installed owner/build parity. Require independent native supervisor evidence before restart or reload.
4. Implement the native receipt and security-reviewed Desktop UI broker; no privilege bypass.
5. Run Windows installed and device acceptance and prepare release only after all P0 gates are satisfied.

## Source commits
- [2d5dc2da](https://github.com/RudyCity/superagent/commit/2d5dc2da8a6de8343d36d337b6dca22359da9a70) — OAuth refresh, type/CI baseline
- [ec57fb38](https://github.com/RudyCity/superagent/commit/ec57fb38f3fea48288e1f2422ad97812d6faa963) — generic native alerts and notification fixture
- [79b8db08](https://github.com/RudyCity/superagent/commit/79b8db080aa3c6d95863192a0a8bc7fe0ca9c7de) — layered permission diagnostic and redaction
- [f89f4f1f](https://github.com/RudyCity/superagent/commit/f89f4f1f09eb0b57f0bfc11323f8612e36a620d1) — exact pending request row before read

Runtime build SHA: unknown. Release tag: none. Device acceptance evidence: not gathered. All native actions require independently verified owner/operator decision.
