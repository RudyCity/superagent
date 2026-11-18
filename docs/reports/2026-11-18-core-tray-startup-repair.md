# Tray Core startup repair — 2026-11-18

## Observed incident

The primary Core public listener on `127.0.0.1:7888` remained alive as supervisor PID `3972`, with private control listener `62604` and worker PID `19032` listening on private port `62605`. Windows process inventory showed the worker as a child of the supervisor.

The default profile at `C:/Users/USER/.superagent-r` lacked `core-supervisor-7888.json`, `server-info.json`, `server-info-7888.json` and `core-checkpoint-7888.json`. The unauthenticated `/api/status` request returned HTTP `401`, while the service doctor reported `OWNER_UNVERIFIED` and `CORE_RECYCLE_OWNER_UNVERIFIED`. The server log also contained `Failed to start server. Is port 7888 in use?`.

These observations establish a live listener with missing ownership and authentication discovery. They do not establish which operation removed the files. No PID-only shutdown, credential migration, runtime target switch or independent MCP restart is authorized by this evidence.

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
| Live primary registration recovery | BLOCKED | Read-only inspection found no matching current credentials in 19 archived records. Existing owner PID `3972` cannot be authenticated for an automated takeover or shutdown. Operator review must address the original owner, worker and stale guardian evidence before any fresh bootstrap. |
| Read-only primary boot audit | PASS (diagnostic) | `bun dist/cli.js core boot-audit --port 7888` returned exit code 0 and a blocked assessment with `UNKNOWN_PUBLIC_PORT_OWNER`. Durable state was clean: ambiguous turns `0`, receipts `34`, accepted effects `0`, reconciled `true`. Diagnostic success does not authorize recovery. |

The native and TypeScript runs passed 196 tests in total. Independent source review confirmed that the real supervisor `/restart` handler accepts the existing native authenticated restart request: absent optional operation headers create a fresh operation ID, while current compiled-build validation and lifecycle ledger checks remain enforced. Windows readiness additionally requires an exact kernel loopback listener PID, and bootstrap success must belong to the launched process ancestry or an independently verified already-running owner.

The vacant-port preflight uses a temporary loopback bind followed by immediate release rather than a Windows connection timeout. A competing bind is refused without deleting metadata, sending credentials to an unregistered endpoint or stopping its process. The eventual Core bootstrap performs its own ownership checks before activation.

The prepared executable is `apps/superagent-tray/src-tauri/target/release/superagent-tray.exe`, 19,315,712 bytes, SHA-256 `1AA0751504C1AECFCC4FF3A3FD18DE6CE54A49BC98DE080F828C8811E69259CF`. The native artifact was built and checked without launching or installing it. Its presence does not establish that an installed Tray has been replaced or that live registration was recovered.

## Remaining operator recovery

The guardian lease saved on November 14 references PID `25204`; Windows currently assigns that PID to `Antigravity.exe`, born on November 18. This is PID reuse, not the original guardian. Do not signal it. The audit's PID-only liveness observation does not identify the original owner and leaves worker evidence unknown.

Recovery therefore requires explicit operator review of the unregistered Core supervisor PID `3972` and worker PID `19032`. After the original Core and worker are confirmed stopped through an operator-approved path, archive the stale guardian evidence in a controlled, reviewed operation and rerun the boot audit before attempting a fresh authenticated bootstrap. Closing the old Core alone is not sufficient evidence that fresh boot is safe. The repair does not change TypeScript recovery policy to bypass these blockers or discard unknown effects.

No primary Core or independent MCP process was started, stopped or restarted during this repair and verification. No tunnel, OAuth credential or active runtime target was changed.

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
