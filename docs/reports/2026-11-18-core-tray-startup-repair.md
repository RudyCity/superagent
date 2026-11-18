# Tray Core startup repair — 2026-11-18

## Observed incident

The primary Core public listener on `127.0.0.1:7888` remained alive as supervisor PID `3972`, with private control listener `62604` and worker PID `19032` listening on private port `62605`. Windows process inventory showed the worker as a child of the supervisor.

The default profile at `C:/Users/USER/.superagent-r` lacked `core-supervisor-7888.json`, `server-info.json`, `server-info-7888.json` and `core-checkpoint-7888.json`. The unauthenticated `/api/status` request returned HTTP `401`, while the service doctor reported `OWNER_UNVERIFIED` and `CORE_RECYCLE_OWNER_UNVERIFIED`. The server log also contained `Failed to start server. Is port 7888 in use?`.

These initial observations established a live listener with missing ownership and authentication discovery. They did not establish which operation removed the files and did not, by themselves, authorize shutdown or takeover. The subsequent operator-approved recovery is recorded below.

## Repair scope

- Require authenticated readiness for the exact requested Core target.
- Preserve discovery and recovery files on uncertain startup or ownership failures.
- Reuse the verified supervisor restart contract to retain session affinity and independent MCP ownership.
- Record the patch as version `1.14.106` across the package and native Tray manifests.

## Verification ledger

| Check | Status | Evidence |
| --- | --- | --- |
| Initial Git safety check | PASS | Existing unrelated UI changes identified and preserved. |
| Live incident observation | PASS | Windows listener/process inventory, HTTP `401`, service doctor and server log. |
| Startup regression tests | PASS | Eight isolated native tests passed, covering unauthorized/occupied listeners, metadata preservation, vacant-port reservation, exact-target credentials, private/public readiness, identity mismatch, safe Stop refusal and kernel listener parsing. |
| Adjacent TypeScript regressions | PASS | `bun --bun x vitest run tests/coreBoot.test.ts tests/desktopTrayNotificationsUi.test.ts tests/desktopRuntimeUi.test.ts`: 3 files, 83 tests passed. |
| Version manifest parity | PASS | Package, Cargo package/lock and Tauri config all report `1.14.106`; no dependency version changes. |
| Native Tray checks | PASS | `cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --bin superagent-tray`: 113 passed, 0 failed, including all eight startup regressions and existing runtime control/detection tests; exit code 0. |
| Native release executable | PASS | `cargo build --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --release --bin superagent-tray`: exit code 0, optimized build completed in 1m35s. Artifact size and SHA-256 independently checked below. |
| `bun run build` | PASS | Parent run completed with exit code 0: TypeScript compilation and all postbuild scripts passed for `1.14.106`. Core manifest covered 998 files with SHA-256 `2fc06f37f08b9d502fb4d55c16d23def5865085f59f775550d87aaa7f7cbe5ac`. |
| Live primary registration recovery | PASS | After explicit operator approval and exact OS identity revalidation, only the old Core supervisor/worker were stopped and stale guardian evidence archived. Fresh primary supervisor PID `19488` and worker PID `23592` passed authenticated ownership and readiness checks. |
| Primary boot audit | PASS | The initial read-only audit was blocked with `UNKNOWN_PUBLIC_PORT_OWNER`. After the approved shutdown and reviewed archival, the audit allowed `fresh_guard_allowed` with `CLEAN_AND_VERIFIED_NAMESPACE`, no surviving workers, ambiguous turns `0`, receipts `34`, accepted effects `0` and reconciled `true`. |
| Live primary health | PASS | Authenticated public status returned HTTP `200`, `online`, version `1.14.106`. Core status was verified with a fresh matching build; doctor reported `active`, alive/ready/ownership verified, kernel listener PID `19488`, no runtime warning and no version drift. |

The native and TypeScript runs passed 196 tests in total. Independent source review confirmed that the real supervisor `/restart` handler accepts the existing native authenticated restart request: absent optional operation headers create a fresh operation ID, while current compiled-build validation and lifecycle ledger checks remain enforced. Windows readiness additionally requires an exact kernel loopback listener PID, and bootstrap success must belong to the launched process ancestry or an independently verified already-running owner.

The vacant-port preflight uses a temporary loopback bind followed by immediate release rather than a Windows connection timeout. A competing bind is refused without deleting metadata, sending credentials to an unregistered endpoint or stopping its process. The eventual Core bootstrap performs its own ownership checks before activation.

The prepared executable is `apps/superagent-tray/src-tauri/target/release/superagent-tray.exe`, 19,315,712 bytes, SHA-256 `1AA0751504C1AECFCC4FF3A3FD18DE6CE54A49BC98DE080F828C8811E69259CF`. The native artifact was built and checked without launching or installing it. The separately running debug Tray PID `7508`, version `1.14.106`, remained in place; the prepared release executable was not installed.

## Completed operator-approved recovery

Read-only inspection found no current matching credentials in 19 archived records. The guardian lease saved on November 14 referenced PID `25204`, which Windows assigned to `Antigravity.exe` born on November 18. This was PID reuse, not the original guardian. The initial audit's PID-only liveness observation could not identify the original owner and left worker evidence unknown. That unrelated process was not signalled.

The user explicitly selected **“Izinkan pemulihan Core”**, approving the operator recovery exception. At approximately 17:09 WIB on November 18, the parent rechecked exact OS process birth, executable, ancestry and listener evidence, pinned process handles, and stopped only the old supervisor PID `3972` and worker PID `19032`. Wrapper PID `24544` exited automatically. Independent MCP PID `20896` and the unrelated `Antigravity.exe` PID `25204` remained unchanged.

After confirming the old Core and worker had stopped, the parent verified that both stale guardian file hashes were unchanged and moved exactly `core-guardian-7888.json` and `managed-guardian-7888.json` to `C:/Users/USER/.superagent-r/recovery-archive/operator-core-7888-20261118T100943Z-df0ae881`. The archive uses a private user-and-SYSTEM ACL and includes an evidence manifest. The audit required guardian review before this archival; afterwards it returned `fresh_guard_allowed` and `CLEAN_AND_VERIFIED_NAMESPACE` with no workers. Durable state remained clean: ambiguous turns `0`, receipts `34`, accepted effects `0`, reconciled `true`. No TypeScript policy was changed to bypass recovery blockers.

At 17:10:06 WIB, the parent launched `bun dist/cli.js core boot --port 7888 --client-mode tline` with a hidden window and the primary profile. The new launcher PID was `3380`, supervisor PID `19488`, and worker PID `23592` on private port `59152`. Authenticated Core status verified the supervisor and fresh build digest `2fc06f37f08b9d502fb4d55c16d23def5865085f59f775550d87aaa7f7cbe5ac`. Authenticated public `/api/status` returned HTTP `200`, status `online`, version `1.14.106`. The Core doctor confirmed `active`, alive, ready, ownership verified, kernel listener PID `19488`, `runtimeWarning: null` and `versionDrift: false`.

During the earlier implementation and isolated testing phase, no primary Core or independent MCP process was started, stopped or restarted. The later primary Core lifecycle changes were limited to the explicitly approved recovery above. No OAuth/provider credentials or session database were changed, no MCP or unrelated Antigravity process was stopped, and no tunnel or active runtime target was switched. Existing MCP affinity drift remains a separate limitation; this report does not claim all MCP health checks are green.

Local compilation and isolated tests do not certify installed desktop behavior, public ingress, OAuth migration or R0–R7 production release gates.

## Changed files

- `package.json`
- `CHANGELOG.md`
- `apps/superagent-tray/src-tauri/Cargo.toml`
- `apps/superagent-tray/src-tauri/Cargo.lock`
- `apps/superagent-tray/src-tauri/tauri.conf.json`
- `apps/superagent-tray/src-tauri/src/main.rs`
- `apps/superagent-tray/src-tauri/src/core_startup.rs`
- `apps/superagent-tray/src-tauri/src/runtime_control.rs`
- `apps/superagent-tray/src-tauri/src/runtime_detection.rs`
- `tests/tray_core_startup.rs`
- `docs/reports/2026-11-18-core-tray-startup-repair.md`

Unrelated existing changes to `apps/superagent-tray/ui/index.html` and `apps/superagent-tray/ui/styles.css` were preserved and are excluded from this repair.
