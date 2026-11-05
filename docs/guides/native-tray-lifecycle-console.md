# Native Tray Unified Lifecycle Console

The Tauri desktop application has a new **Unified Lifecycle Supervisor**
section in **Runtime Detection**. It is wired to the same verified
`manage_services` runtime as the MCP and ordinary agent tools.

## Secure architecture

`Tray WebView -> lifecycle_console_request (Rust allowlist) ->
selected Core localhost HTTP with private server bearer ->
/api/desktop/lifecycle (loopback + Host + forwarding guard) ->
validateManageServicesArgs -> manageServices`.

The WebView never receives Core bearer tokens, service IPC tokens,
process command lines, user workspaces, public tunnel URLs or local
file paths. Native calls accept only explicit operation fields and
known service names. All mutations require an exact service target,
a validated owner-aware plan, explicit confirmation and (except
profile updates and manually reviewed reconciliations) an operation
ID. The desktop bridge rejects tunnel stop, public MCP lifecycle
mutation, arbitrary shell/URL arguments and automatic watchdog apply.
Core's existing authentication and local bind policy still apply.

**Critical:** The native UI requires the selected Core to be
running the updated lifecycle HTTP endpoint. If Core is offline or
using an older build, the panel reports its unavailability; it will
not silently use an unrelated Core or launch production processes.

## UI

The existing Runtime page shows service readiness, dependencies,
Tray release digest, the operation timeline and guarded recovery
policies. All status loads are read-only. The operator can:

1. Select Tray, Transport, Channel Host, Vision, Guardian, or Daemon.
2. Choose Start/Stop/Restart (or Tray Upgrade/Rollback) and the
   local service port, then select **Prepare Plan**.
3. Review service, operation ID, expected PID, build hash, and risk note.
4. Select **Confirm & Execute** and accept the native confirmation.

If the request times out, the UI retains the original operation ID
for operator review. It does **not** automatically send the mutation
again or create a second ID. A Core process may still finish an
in-flight operation after the Tray window exits (for example, when
upgrading the Tray itself). Verify the owner and timeline rather than
replaying blindly.

A separate Recovery Policy pane saves revisioned profiles only with
explicit confirmation. Saving a policy never starts a process. The
watchdog is advisory in the native UI: enabling actual recovery still
requires an independently approved watchdog worker with strict limits.

## Verification

```powershell
bun run build
cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml
cargo build --manifest-path apps/superagent-tray/src-tauri/Cargo.toml
bun --bun x vitest run tests/nativeTrayLifecycleBridge.test.ts tests/nativeTrayLifecycleUi.test.ts tests/nativeTrayLifecycleCoreHttp.test.ts
```

The Core HTTP test creates a disposable profile and isolated Core
Supervisor on an ephemeral loopback port. Native UI tests use a
WebView mock; Rust tests validate the native command. None of these
tests replace an installed Tray, kill an unowned process, rotate a
Cloudflare URL, or affect production sessions.

Existing Muse file manager, PDF tools, Chrome Delegate and Tray
connection logs remain independent. The new module is intentionally
scoped to lifecycle only.
