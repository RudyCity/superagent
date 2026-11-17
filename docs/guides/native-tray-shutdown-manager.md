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
- **Manual Kill · owner override** is a distinct OS-level action available
  only in the focused native Tray window. A human checks the **Kill PID** box
  beside each observed target, or presses **Select all eligible**, and types
  `KILL SELECTED`. A second native dialog lists the selected PIDs, executable
  names and services before consent. It can terminate an unverified Guardian,
  externally observed `cloudflared`, or a Core Supervisor without their
  graceful-stop protocol. This overrides missing application owner
  attestation, **not** OS permissions, process-birth checks, or critical-process
  exclusions. All selected PIDs are pinned to their OS birth time and name,
  rechecked after native approval and immediately before termination. Shared
  PIDs are killed only once; the process tree and current Tray are untouched.
  Results are reported separately per PID, including OS access denied, reused
  PID, timeout, exit verified, or a newly observed replacement. Preview shows
  the full OS executable path when available; every execution checks that
  path again as well as PID, birth time and name.
  If the authenticated Core inventory is unavailable, a regular, bounded
  `core-guardian-PORT.json` lease is checked against a live OS process to
  recover a Guardian candidate without guessing an arbitrary `bun` PID.
  This OS evidence does not authorize any graceful MCP action.
  Guardian is retired first, then related services, then Core Supervisor
  before a selected Core worker to avoid immediate in-process recovery.
  A bounded post-stop rescan reports replacement PIDs without taking them
  over or killing them under the original approval.
- **Quit Tray Only** leaves services untouched, and cannot interrupt an
  in-flight verified shutdown.

The native command uses a short-lived preview token, a single-flight guard,
exact PID/port pins and a fresh inventory after native approval. Graceful
managed-service shutdown additionally uses a new owner-specific operation
plan. Manual Kill uses the independently checked OS process identity and no
free-form PID inputs. Progress is emitted
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

**A full graceful exit is not universally available.** Core Supervisor has no
verified full-stop protocol, and active sessions or independent tunnels may
block graceful shutdown. Those appear as **Review** and keep the Tray open.
Force Stop All continues to require its verified owner contracts. Unlike that
owner-based operation, the separately approved **Manual Kill** can target
OS-observed Guardian, Cloudflare, MCP and Core Supervisor processes even
without application-level owner verification, if the operator selects their
exact PID. The app does not guess PIDs, adopt an unobserved process or claim
that killing one process prevents its supervisor or an external Windows
service/OS launchd/systemd job from restarting it. No global startup/service
configuration is silently changed or disabled. The OS may deny process
termination without administrator privileges. A replacement requires a fresh
preview and separate human approval. Normal graceful shutdown never rotates
the Cloudflare URL.

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
PID/port and OS process birth/executable path, bounded Guardian lease fallback
when Core is down, exact typed force-stop and manual-kill approval, reviewed
PID selection, critical-system-process exclusion, shared-PID deduplication,
Guardian-before-supervisor ordering, restart/replacement reporting, terminal
inventory refresh, partial progress, XSS-safe DOM rendering and full-exit
preconditions. Passing simulated or isolated tests is not the same as real
Windows operator certification. OS-level Windows installed-Tray
certification still requires a controlled, private test profile. Never
exercise stop-all against the active shared Core/MCP/Cloudflare runtime
as a CI shortcut.