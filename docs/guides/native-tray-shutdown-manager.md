# Native Tray Shutdown Manager

## Operator workflow

Right-click **SuperAgent Tray** and select **Shutdown Manager · Exit App**.
The Tray opens a native modal and reads an authenticated owner inventory.
No process is stopped during this preview. Each row reports its exact
owner PID/port when available, readiness, active job/session count when
reported, and a blocker when it cannot be stopped safely.

- **Stop selected** stops only checked and owner-verified services, in
  dependency order; it never exits the Tray.
- **Stop all & exit** requires *every active observed owner* to be
  stoppable and selected. A busy, foreign, or unverifiable owner disables
  this action. A final native confirmation is mandatory.
- **Force Stop All** is a separate *destructive* action. Type `FORCE STOP ALL`
  into the native Tray panel, then approve the OS-native confirmation dialog.
  It operates only on independently authenticated SuperAgent MCP owners,
  privately registered / process-birth-pinned Cloudflare tunnel owners, and
  services with an existing verified owner stop protocol. It can interrupt
  sessions or drop a Cloudflare tunnel and rotate its Quick Tunnel URL.
  The Tray stays open for the result; it **never claims universal shutdown**
  when foreign/unverified owners remain.
- **Quit Tray Only** leaves services untouched, and cannot interrupt an
  in-flight verified shutdown.

The native command uses a short-lived preview token, a single-flight guard,
exact PID/port pins, a fresh inventory after native approval, and a new
owner-specific operation plan for every managed service. Progress is emitted
as `shutdown-manager-progress` and can be recovered with the read-only
`shutdown_manager_action({action:"status"})` command after the dialog closes.

## Safety and current limitations

Normal graceful shutdown provides no generic process killer, shell command,
PID-file deletion, or foreign process adoption. The separate Force Stop All
path uses the authenticated owner's private `stop?force=1` route for MCP and,
only for an independently registry-verified Cloudflare process, a native OS
force signal after exact process-birth revalidation. It never signals a
Cloudflare process discovered only through OS enumeration. All actions recheck
ownership before executing. Graceful stop uses:

- Reloadable managed MCP owners: zero-session precheck, authenticated graceful
  drain and stop, exact process exit verification.
- Guardian, daemon scheduler, transport, channel host and independently
  managed Vision: service-specific plan/execute through the authenticated
  lifecycle manager; active jobs or unknown owners block.
- Direct Core: selected authenticated owner only, guarded against an
  existing supervisor registry, stopped **last** and checked for process exit.

**A full exit is not universally available.** Core Supervisor has no verified
full-stop protocol; public Cloudflare tunnels require separate intentional
public-disruption approval; some Muse/Telegram watch owners, active CLI agents,
and other externally launched owners cannot be safely adopted. Those appear
as **Review** and keep the Tray open. Force Stop All cannot override an
unknown/foreign owner's missing evidence (including an unverified Guardian)
and will report remaining owners instead of silently killing them. Normal
graceful shutdown never rotates the Cloudflare URL.

Stopping a scheduler preserves persisted reminders; it does not delete jobs.
In-flight operations are not force-cancelled. An ambiguous timeout leaves the
original operation un-replayed and reports a partial result. Refresh the
preview after manual reconciliation rather than reusing a prior selection.

## Verification

From a clean developer checkout:

```sh
bun --bun x vitest run tests/trayShutdownManagerUi.test.ts
cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml shutdown_manager
cargo check --manifest-path apps/superagent-tray/src-tauri/Cargo.toml
bun run build
```

Tests cover native owner-plan projection, selection constraints, matching
PID/port and OS process birth, exact typed force-stop approval, blocked/foreign
owner exclusion, preview/selection UI behavior, partial progress, XSS-safe DOM
rendering and full-exit preconditions. OS-level Windows installed-Tray
certification still requires a controlled, private test profile. Never
exercise stop-all against the active shared Core/MCP/Cloudflare runtime
as a CI shortcut.