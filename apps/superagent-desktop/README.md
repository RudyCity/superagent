# SuperAgent Desktop — Tauri tray + cron manager

Native Tauri v2 desktop panel for the *existing* SuperAgent DaemonScheduler; it is **not** another cron runner or another database.

## Development (Windows first)

1. Run SuperAgent Core: `bun dist/cli.js --server 7888`. The daemon REST API is protected by the server's bearer token.
2. From `apps/superagent-desktop`, run `cargo tauri dev` (Tauri CLI 2 and Rust/MSVC/WebView2 are required).
3. The desktop reads `~/.superagent-r/server-info.json` (or `SUPERAGENT_CONFIG_DIR/server-info.json`) **only in Rust**. It connects **only to 127.0.0.1**, never to a URL supplied by the webview. It does not send the token to JavaScript. Select **Start scheduler** once in the UI; the daemon only fires while the SuperAgent Core process is alive.
4. A native unsigned Windows debug executable was built and verified at `src-tauri/target/debug/superagent-desktop.exe` using `CARGO_NET_OFFLINE=true cargo tauri build --no-bundle --debug --ci`. Use `cargo tauri build` from this folder to package. For real Windows toast notifications, install the signed/unpacked app; Windows notification plugin support in dev may vary.

## Features

- Tray icon: open desktop manager, create reminder, quit. Closing the window hides it to tray, keeping native polling alive.
- Read/create/edit/delete/pause/resume cron jobs against authenticated `/api/daemon/jobs` REST routes.
- Run history and daemon health via `/api/daemon/status` and `/api/daemon/runs`.
- Reminder kind: deterministic text-only jobs, no model, agent, or tool invocation. Rust polls completed successful reminder runs every 15s and emits native notifications; dedupe is persisted in `desktop-notified-runs.json`.
- Recurrence: once (`maxRuns = previous runCount + 1` for an edited job), daily, weekly, custom five-field cron. Times use the local timezone of the SuperAgent Core machine, not a timezone stored in the job.
- Non-reminder AI agent tasks remain explicit and show their workspace and task prompt. CLI and TUI can create reminders via `superagent daemon add --reminder ...` and `/daemon add ... --reminder`.

## Security and limitations

- **Never** read/write `daemon-jobs.json` directly from desktop: the daemon owns job creation, updates, runs, persistence and ledger.
- Native Rust commands expose a fixed allowlist of daemon operations and job properties. There is no arbitrary HTTP proxy, user-entered host, local shell, or generic filesystem access.
- A cron reminder is delivered as an OS notification only when (1) Core + scheduler are running and the task fires, (2) Desktop is running in the tray, (3) OS notifications work. If Desktop is temporarily offline, it searches recent successful runs (within 2 hours) on restart. Expired/offline reminders are not scheduled by Tauri itself.
- Avoid two independent daemon owners for the same `daemon-jobs.json`; the existing scheduler does not provide a multi-process ownership lock. Run desktop against the one authoritative Core daemon.
- A five-field cron expression cannot represent a year or seconds and DST handling follows the existing Core local-time cron parser. One-time entries use `maxRuns=1` and fail client-side validation if the selected date/time is not in the future.
- Startup/login auto-launch, Core process supervision, per-user multi-instance lock, installation signing, a separate offline reminder scheduler, and multi-device OS notification delivery remain for product approval.
- This prototype intentionally does **not** alter Muse Watch transport or auto-replay stalled Telegram batches.

See `docs/plans/2026-11-04-superagent-tauri-tray-cron-management.md` for decisions and release gates.
