# Permissions & tools remediation — execution ledger

Date: 2026-11-19
Master plan: [2026-11-18-superagent-permissions-tools-remediation-master-plan.md](./2026-11-18-superagent-permissions-tools-remediation-master-plan.md)
Security threat model: [Native desktop mediation](../security/2026-11-18-desktop-native-mediation-threat-model.md)

**Overall state: IN PROGRESS (M0–M3/M5/M6 local source & unit gates green). NOT installed-runtime verified. NOT released.**
Definitions: Implemented=source reached workspace/main; Tested=passing Vitest/Cargo/TSC/Build locally (CI exact-HEAD pending push/reconciliation); Runtime Verified=attested installed source/build/owner; Released=versioned accepted signed artifact. Pending, cancelled, prior-HEAD or red tests are not green.

| Slice / owner / priority | Code, evidence and acceptance | Implemented | Tested | Runtime Verified | Released | Blocker / next |
| --- | --- | --- | --- | --- | --- | --- |
| M0 CI / Core+QA / P0 | `mcp-fast-regression.yml` updated (`ff737c1a`); local `tsc --noEmit`, `bun run build`, 44 Vitest files & 113 Cargo Tray tests pass on current tree | Partial (local diverges from `origin/main` + dirty UI tree) | Local green; remote CI pending | No | No | Reconcile `origin/main` cleanly preserving concurrent Tray UI edits, then confirm GitHub Actions exact-HEAD run |
| M1 owner parity / Native+Core / P0 | Core startup ownership repair & approved recovery recorded (`283b32d6`, `ca5d9e79`, [Core repair report](../reports/2026-11-18-core-tray-startup-repair.md)); `serviceOwnerAttestation.ts` tracks build/WebView parity | Yes (Core/Tray source) | Local green (`serviceOwnerAttestation`, `tray_core_startup`) | Partial (Core `:7888` verified; Tray release binary built, not installed) | No | Attest installed MCP backend release digest & installed signed Tray binary |
| M2 permission trace / MCP security / P0 | Layered decision codes (`mcpPermissionDecision.ts`), structured `remediationAction` (`supportedFields`, Tray routes), bounded preflight for `superagent_manage_services` & `superagent_chrome_cdp_observe`, fixed `superagent_tool_execute` pre-auth oracle leak & nested audit/activity redaction | Yes (bounded preflight & gateway parity) | Local green (`mcpPermissionDecision`, `mcpApprovalAndFilePolicy`, `mcpToolGateway`, `mcpFilePolicyMatrix`) | No | No | Reconcile legacy `tests/desktop-ui-privacy/mcp-audit.test.ts` mock non-hex `credentialHash` fixture if included in future CI |
| M3 exact read receipt / Tray native / P0 | `tray_navigation_receipt.rs` single-use nonce tickets + attested `webviewDigest`/`sourceBuildSha`/`targetTab`/`targetFound` receipts; `notifications.js` keyboard `Enter`/`Space` activation, tab-not-loaded retry, explicit `ack_navigation(targetFound:false)` error state without marking read; `access-manager.js` in-flight reload race fix | Yes (native receipt + UI integration) | Local green (`tray_navigation_receipt`, `desktopTrayNotificationsUi`, `desktopAccessManagerTrayUi`) | No | No | Verify live installed Tray WebView click, keyboard & receipt flow end-to-end |
| M4 desktop broker / Native security / P0 | Security threat model & audit complete; `desktopNativeMediator.ts` enforces owned-surface vs `third_party_window` isolation, `readPermanentAccessRegistryStatus()` (`POLICY_STORE_UNAVAILABLE`), semantic redaction & disabled raw screenshots; `desktopUiTools.ts` re-verifies live `(pid, nativeId, title, active)` on `snapshot`/`action`; third-party window content remains DENIED under `registeredFileToolGate.ts` | Yes (narrow owned-surface mediator; third-party DENIED) | Local green (`desktop-native-mediator`, `registered-file-tool-gate`, `trusted-desktop-input`, `persistent-access-policy`) | No | No | Third-party OS file/content provenance mediation remains intentionally disabled pending OS-level proof |
| M5 approvals/UX / Tray+MCP / P1 | OAuth owner label preserved, multi-principal isolation tested, narrowed capability approval, pending load error handling & focus race fixed | Partial (UI polish concurrent in `index.html`/`styles.css`) | Local green (`desktopAccessManagerTrayUi`, `mcpApprovalAndFilePolicy`) | No | No | Live two-client OAuth UX walk-through on installed Tray |
| M6 OS banners / Native Tray / P1 | `tray_os_action.rs` single-use OS toast IDs (`46b90c1e`) + generic Core OS alerts (`0134c736`) | Partial (core + toast IDs) | Local green (`tray_os_action`, `desktopTrayNotificationsUi`) | No | No | Cold-start, minimized Tray, reboot & multi-monitor Windows toast acceptance |
| M7 release / Release owner / P0 | Cross-platform CI, Windows installed E2E, two-PC/Android checks, signed artifacts & R0–R7 evidence | No | No | No | No | Blocked on M0 CI reconciliation, M4 native broker review & physical Windows/device E2E |

## Read-only live observation
- Prior live incident (2026-11-18): Core `:7888` responded with `OWNER_UNVERIFIED`; approved operator recovery completed in [Core repair report](../reports/2026-11-18-core-tray-startup-repair.md) (`1.14.106`, supervisor PID `19488`, worker PID `23592`, `ownershipVerified=true`).
- Today's session (2026-11-19): No live Core/MCP/Tray process was stopped, restarted, or mutated. Unrelated concurrent working-tree edits in `apps/superagent-tray/ui/index.html` and `apps/superagent-tray/ui/styles.css` were preserved untouched.

## Checkpoints and next actions
1. Run final full verification (`tsc --noEmit`, `bun run build`, full `mcp-fast-regression` Vitest suite, `cargo test`) on exact working tree.
2. Reconcile `origin/main` (26 Tray notification triage commits) with local `main` once concurrent `index.html`/`styles.css` edits are settled, then confirm exact-HEAD GitHub Actions pass across Windows/Linux/macOS.
3. Conduct independent security review & implementation of M4 native Desktop UI broker before lifting any third-party window content denial.
4. Execute installed Windows E2E + multi-device verification before M7 release gating.

## Source commits
- [2d5dc2da](https://github.com/RudyCity/superagent/commit/2d5dc2da8a6de8343d36d337b6dca22359da9a70) — OAuth refresh, type/CI baseline
- [ec57fb38](https://github.com/RudyCity/superagent/commit/ec57fb38f3fea48288e1f2422ad97812d6faa963) — generic native alerts and notification fixture
- [79b8db08](https://github.com/RudyCity/superagent/commit/79b8db080aa3c6d95863192a0a8bc7fe0ca9c7de) — layered permission diagnostic and redaction
- [f89f4f1f](https://github.com/RudyCity/superagent/commit/f89f4f1f09eb0b57f0bfc11323f8612e36a620d1) — exact pending request row before read
- `46b90c1e`, `f5ab9f9d`, `0134c736`, `271ed1b6` — one-use OS toast mapping, read-only service preflight, tracked private incidents, legacy pending deep links
- `283b32d6`, `ca5d9e79` — Tray Core startup ownership preservation & approved Core recovery report (`1.14.106`)

Latest Core `bun run build` SHA: `b8baa1b20e0e593e7407d390ba49f11c152e2c3b61ed42be6dcf1de8d6f2aa38` (source `7e1217f4f71df16f12d08907b71e23097dbca93ee62064a2a3af00cf77caaf91`, 998 files). Release tag: none. Device acceptance evidence: not gathered. All native actions require independently verified owner/operator decision.
