# SuperAgent Desktop Tray & Cron Manager — Implementation / Decisions
Date: 2026-11-04
Repository: RudyCity/superagent, branch main
Commit/push: **not authorized**; all changes remain in the working tree.

## Goal and architecture

Add a compact Windows-first Tauri v2 desktop app and system tray for existing SuperAgent daemon cronjobs and reminders. This is a management surface, **not an independent cron runner**.

```text
Tauri webview (static HTML/CSS/JS, no secrets / shell / HTTP permission)
    │ specific Tauri IPC action, with limited request fields
    ▼
Tauri Rust backend (local server-info.json, private bearer token)
    │ HTTP only to 127.0.0.1:<recorded Core port>, no redirects
    ▼
SuperAgent Core daemon REST API (existing auth + DaemonScheduler)
    │ owns job state, cron parsing, run ledger, safety rules
    ▼
daemon-jobs.json + daemon run ledger
    │ successful text-only reminder runs
    ▼
Tauri native 15s poll + OS notification + persistent run-ID dedup
```

Tauri code: `apps/superagent-desktop/src-tauri`, static UI `apps/superagent-desktop/ui`. Existing scheduler extended in `src/core/daemon/daemonScheduler.ts` / `daemonTypes.ts`. Existing REST authorization is not bypassed, changed, or widened.

## Implemented

- Tauri v2 tray: open manager, new reminder, quit. Close hides window rather than killing native reminder polling.
- Desktop Cron Manager: list/read, create, edit (name/content/schedule), pause/resume, delete with confirmation, manually run with confirmation, ledger history, scheduler status/start button.
- Schedule presets: one-time (five-field cron + maxRuns=1), daily, weekly, advanced cron; client rejects one-time dates in the past.
- Reminder kind: deterministic text-only, no AI agent/model/tools/skill, no retries or multi-agent mode. Execution appears in the same daemon ledger, preserving audit records and runtime policy. Existing agent/system maintenance jobs remain separate.
- Updated daemon PATCH to permit `maxRuns: null` to convert one-shot to repeating. The persisted field becomes undefined; an invalid positive limit remains rejected.
- Tauri Rust calls only fixed authenticated loopback daemon routes. Auth token read from owner config directory; JavaScript cannot call arbitrary URLs or read token. CLI shell execution is not exposed to webview.
- Native plugin notifications for successful reminder runs, 15-second poll even when window hidden, dedupe with `desktop-notified-runs.json` bounded at 500 run IDs, stale runs older than two hours ignored.
- Included tray icons for Windows/macOS and Tauri config. Tauri build can be run from desktop folder.

## Existing system and constraints

- Core uses one `DaemonScheduler` in memory and persists `~/.superagent-r/daemon-jobs.json`. Independent scheduler processes operating concurrently can overwrite state; Tauri **never** edits this file directly.
- Core REST endpoints `/api/daemon/status`, `/api/daemon/start`, `/api/daemon/jobs`, `/api/daemon/jobs/run`, `/api/daemon/runs` already exist. Tauri only allows these fixed actions.
- The frontend does not start Core itself. Core must be running and the daemon scheduler must be started by the operator; otherwise desktop clearly reports disconnected or stopped.
- Native Windows notifications require an installed app and notification permission/support; `cargo check` alone does not establish toast delivery.
- Cron is minute-resolution and interpreted by Core in **system-local time**; DST/ambiguous hours are not independently handled by Tauri.
- The dashboard reuses existing Core data; no second desktop database of jobs, no new agent grants.

## Test and release gates

1. TypeScript `bun --bun x tsc --noEmit` and Vitest `tests/daemonScheduler.test.ts`, `tests/cronParser.test.ts`, Muse watcher regression suites.
2. `node --check apps/superagent-desktop/ui/app.js`; `cargo check --offline` and `cargo test --offline` inside `apps/superagent-desktop/src-tauri`.
3. **Passed on this Windows development host:** `CARGO_NET_OFFLINE=true cargo tauri build --no-bundle --debug --ci` produced `apps/superagent-desktop/src-tauri/target/debug/superagent-desktop.exe`. This is an unsigned **debug executable**, not an installer. `cargo test --offline` also passed three Rust unit tests.
4. **Passed in an isolated config directory:** `bun src/cli.tsx daemon add ... --reminder --max-runs 1` persists a text-only reminder with zero tool grants. The default `DaemonScheduler` constructor now honors `SUPERAGENT_CONFIG_DIR`, consistent with Core and Tauri, and a new regression test guards this.
5. **Pending manual acceptance**: run Core using dedicated test config, start scheduler, launch Tauri, create a one-minute reminder, verify one native toast and persisted ledger, pause/edit/delete, close-to-tray, reopen, restart, verify no duplicate notification.
5. **Pending cross-platform signoff**: installed Windows 10/11 notifications, tray click behavior, installer signing, macOS/Linux packaged builds. No claim of production readiness without evidence.

## Rudy decisions required

1. **Placement:** keep a separate `superagent-desktop` Tauri tray app vs integrate tray UI into existing T-Line native desktop project (outside this repository).
2. **Lifecycle:** start SuperAgent Core automatically on sign-in and manage one daemon owner via supervisor, or require manual Core startup? Autostart could have security/CPU/billing implications.
3. **Notification channels:** OS only vs also Telegram/Discord/Slack for reminders; any default for `notifyGateway`; user consent for external delivery.
4. **Time semantics:** system local zone only vs explicit per-job IANA timezone/DST/recovery policies; missed reminders after sleep/offline (two-hour catchup window in this version); once-only semantics when a scheduled minute is missed.
5. **Security:** Windows installer signing, per-user encrypted token storage/ACL verification, desktop single-instance policy, multi-profile/project isolation.
6. **Agent jobs:** should the desktop surface allow new agent jobs at all, or restrict creation to safe reminders and offer agent jobs view-only? In this prototype, agent creation is explicit with workspace and existing Core headless safety policy.

## Muse Watch

Muse Watch fixes from the immediately preceding scope remain uncommitted, including Telegram default on `/muse watch start`, ingress health reporting, Telegram polling error visibility, and regression tests. No live Telegram `task_batch` has been replayed, and this desktop feature does not alter Muse transport.
