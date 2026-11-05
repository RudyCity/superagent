# SuperAgent Tray — Tauri tray + cron manager

**Companion tray utility**, not the main SuperAgent desktop application. **T-Line remains the SuperAgent desktop app.** SuperAgent Tray manages runtime health, cronjobs and reminders through the existing Core; it is **not** another cron runner or database.

## Development (Windows first)

1. Run SuperAgent Core: `bun dist/cli.js --server 7888`. The daemon REST API is protected by the server's bearer token.
2. From `apps/superagent-tray`, run `cargo tauri dev` (Tauri CLI 2 and Rust/MSVC/WebView2 are required).
3. The desktop reads `~/.superagent-r/server-info.json` (or `SUPERAGENT_CONFIG_DIR/server-info.json`) **only in Rust**. It connects **only to 127.0.0.1**, never to a URL supplied by the webview. It does not send the token to JavaScript. Select **Start scheduler** once in the UI; the daemon only fires while the SuperAgent Core process is alive.
4. A native unsigned Windows debug executable was built and verified at `src-tauri/target/debug/superagent-tray.exe` using `CARGO_NET_OFFLINE=true cargo tauri build --no-bundle --debug --ci`. Use `cargo tauri build` from this folder to package. For real Windows toast notifications, install the signed/unpacked app; Windows notification plugin support in dev may vary.

Windows x64 **standalone setup and GitHub prerelease procedure**: see [Windows Standalone Installer](../../docs/guides/windows-standalone-installer.md). The bundled CLI, Core and Bun runtime are independent of a global Bun/Node install.

## Automatic startup with SuperAgent

On Windows, **SuperAgent Tray launches automatically and silently** when a real long-lived SuperAgent process starts: interactive CLI, REST/API server, Core Supervisor, MCP server, T-Line Transport, or Muse/Telegram Channel Host. Starting a second or third SuperAgent process will **not** create a second tray or a second reminder poller: the native `tauri-plugin-single-instance` instance guard handles it before the window starts.

The launcher is `src/core/runtime/trayAutoLauncher.ts`. It looks for a trusted local executable in this order: absolute `SUPERAGENT_TRAY_EXECUTABLE`, the installed per-user `~/.superagent-r/bin/superagent-tray.exe`, and the build's release/debug executable. For global SuperAgent installations, provision the per-user executable **once**:

```sh
cd apps/superagent-tray
cargo tauri build --no-bundle --debug --ci
cd ../..
bun scripts/install-superagent-tray.ts
```

The install script copies the verified Windows PE into the stable per-user binary directory; it does not start Core, register a logon task or restart any service. If replacing a running .exe is blocked on Windows, quit the tray manually first. A local smoke test on this machine confirmed the new installed binary started and a second launch retained **the same single PID**.

- **Manual launch** of `superagent-tray.exe` opens the manager window; **automatic launch** with `--background` stays in the notification area.
- **Opt out:** `SUPERAGENT_TRAY_AUTOSTART=0`. Launch remains disabled in test subprocesses, Core private worker subprocesses and known headless CI runners. A generic `CI=1` is **not** treated as headless by itself because the local SuperAgent connector sets it.
- Missing/broken executable is best-effort and never prevents the CLI or server from starting; set `SUPERAGENT_TRAY_DEBUG=1` to log launcher issues.
- Tray remains open after the launching SuperAgent process exits, so previously scheduled notifications can be inspected after Core returns. It does **not** automatically start or stop Core/daemon and is **not** a Windows logon-start service.
- This is a Windows-first automatic launch feature. macOS/Linux GUI launchers and installed package targets need their own platform implementation.

## Features

- Tray icon: open desktop manager, create reminder, **Runtime Detection**, quit. Closing the window hides it to tray, keeping native polling alive. Runtime Detection includes **+ New Connection** for MCP clients, MCP tunnel owners, Core HTTPS tunnel, and Muse WSS tunnel.
- Read/create/edit/delete/pause/resume cron jobs against authenticated `/api/daemon/jobs` REST routes.
- Run history and daemon health via `/api/daemon/status` and `/api/daemon/runs`.
- Reminder kind: deterministic text-only jobs, no model, agent, or tool invocation. Rust polls completed successful reminder runs every 15s and emits native notifications; dedupe is persisted in `desktop-notified-runs.json`.
- Recurrence: once (`maxRuns = previous runCount + 1` for an edited job), daily, weekly, custom five-field cron. Times use the local timezone of the SuperAgent Core machine, not a timezone stored in the job.
- Non-reminder AI agent tasks remain explicit and show their workspace and task prompt. CLI and TUI can create reminders via `superagent daemon add --reminder ...` and `/daemon add ... --reminder`.

## Frameless custom Windows title bar

The native Windows title bar is **disabled** in `src-tauri/tauri.conf.json` (`decorations: false`) while `resizable`, `minimizable`, and `maximizable` remain enabled. `ui/index.html`, `ui/titlebar.js` and `ui/styles.css` implement a 44px custom title strip with SuperAgent Tray branding and three real window buttons:

- **Minimize:** calls a narrowly scoped Rust `tray_window_action("minimize")`; it minimizes to the Windows taskbar rather than stopping the application.
- **Maximize / Restore:** uses native `window.maximize()` and `window.unmaximize()`. Button tooltip, icon, accessible label and `aria-pressed` follow actual native state on load, resize, focus and explicit action. Double-click in the title drag area also toggles maximize.
- **Close:** calls native `window.close()` and intentionally enters the existing `WindowEvent::CloseRequested` handler. The operator's **Close window to tray** setting determines whether the window hides and native reminders continue, or only SuperAgent Tray quits. Closing never stops SuperAgent Core, MCP, Muse, cloudflared, or any task.
- **Drag:** mouse-primary-button pointer movement over the header brand/empty region must exceed 5 CSS pixels before requesting native `window.start_dragging()`. Simple clicks, touch, right-click, double-click, window-control clicks and maximized windows do **not** start a drag. Restore maximized window before moving it.
- Controls are real `<button>` elements, usable by mouse, keyboard and screen reader. Keyboard-focus styling and native failure messages are included. The body/sidebar are offset to keep navigation and dialogs accessible under the custom strip.

The WebView gets **no general Tauri window-management permission**: a fixed native `tray_window_action` verifies the `main` window label and only accepts `minimize`, `toggle-maximize`, `start-drag`, `close`, and read-only `state`. Neither window controls nor dragging can invoke a shell, control Core, or manipulate other windows. `tests/desktopTitlebarUi.test.ts` exercises DOM wiring, drag threshold, double click, control actions, native state changes and frameless configuration. Windows native compile/build verification is required before installation.

## Tray Settings

Open **Tray Settings** from the left sidebar or the Windows tray icon context menu. Settings are **per-user Tray preferences**, not SuperAgent Core/daemon, T-Line, MCP, Muse or Cloudflare configurations. They persist in `~/.superagent-r/tray-settings.json` (or the directory named by `SUPERAGENT_CONFIG_DIR`), with an atomic bounded JSON write and strict schema validation. **Restore Defaults** only previews defaults until **Save Settings** is clicked.

| Preference | Default | Behavior |
| --- | --- | --- |
| **Auto-launch with SuperAgent** | On | Allows a future long-lived SuperAgent CLI/server/supervisor/transport startup to launch one Tray instance on Windows. This does **not** register Windows logon startup or start Core. `SUPERAGENT_TRAY_AUTOSTART=0` forces off; `=1` forces on regardless of the stored toggle. |
| **Close window to tray** | On | Keeps Tray running with its reminder listener when the manager window closes. Off makes Close **quit the Tray utility** (Core/MCP/Muse processes remain running). The tray's explicit Quit always exits. |
| **Native reminder notifications** | On | Shows Windows toast notifications for successful reminder jobs. Off silently records completed reminders as seen to avoid a catch-up notification storm when re-enabled. Does not disable the daemon's schedules. |
| **Notification check interval** | 15 seconds | Poll native reminder completion every 15/30/60/120s. Applied without a Core restart (at the next poll boundary). |
| **Runtime Detection scan** | 20 seconds | Refreshes the dashboard every 10/20/30/60/120s; **Scan Runtime** still works manually. The interval is replaced without creating additional timers. |
| **Schedules & History refresh** | 30 seconds | Refreshes daemon jobs/history every 15/30/60/120s. |
| **Startup page** | Schedules | Choose Schedules, Runtime Detection, or History. An explicit URL page selection wins; applied on next fresh window startup. |

Native Rust commands `get_tray_settings`/`set_tray_settings` read/write only this fixed structure; they cannot set a path, token, shell command, tunnel URL, or Core configuration. A malformed or symlinked settings file is rejected; auto-launch fails closed if its existing settings file is malformed. For safe, read-only installation verification, run `superagent-tray.exe --diagnose-settings`. The tray settings screen displays errors rather than falsely claiming a save. UI integration is covered by `tests/desktopTraySettingsUi.test.ts`, persisted auto-launch behavior by `tests/trayAutoLauncher.test.ts`, and native bounded persistence/validation by Rust unit tests.

## Runtime Detection

The **Runtime Detection** panel refreshes every 20 seconds and can operate even when the default Core is offline.

- Core/API: scans bounded `server-info.json` and `server-info-<port>.json` records, then verifies `GET /api/status` with each registered bearer token. It reports port, recorded PID, version, health evidence, scheduler state and gateway enabled state.
- CLI and MCP: reads the official `active-processes.json` journal and checks a matching OS PID, process birth time and a heartbeat within 20 seconds. Dead/PID-reused entries are shown as stale, never healthy. Only safe role, PID, shortened workspace name, status and heartbeat age reach the webview.
- Muse Watch, Telegram, MCP, Cloudflare tunnels and channel hosts: a new authenticated read-only Core endpoint, `GET /api/desktop/runtime-services`, returns a **redacted per-Core-process projection**. Services in another process are not implied by this report. No bot tokens, tunnel URLs, MCP tools or task IDs are exposed.
- Independent hosts: T-Line's **default** port 7891 is checked against `/_transport/health` and a live OS PID; `channel-host-<port>.json` entries are checked against `/_channel/health`, including exact instance ID + PID. A responding T-Line transport with an unavailable Core backend is shown **degraded**, not ready.
- Choose **Gunakan Core ini** on an authenticated online Core to switch the cron manager. Only registered, successfully authenticated local loopback servers may be selected, and the selection is process-local (not persisted).
- Independent **MCP HTTP** instances: reads bounded `mcp-<port>.json` records and verifies the owner PID/birth time plus a local, unauthenticated `GET /mcp` returning the expected Bearer challenge (no credentials or tools executed).
- Independent **Cloudflare tunnels**: reads bounded `tunnel-<port>.json` records; verifies cloudflared process identity and recent healthy heartbeat. Public URLs and secret metadata never enter the UI.
- Independent **Muse Watch**: a running watcher publishes a credential-free `muse-watch-<pid>-<nonce>.json` heartbeat every 10s. Tray requires matching live PID/birth time and a heartbeat no older than 30s; a listener not yet connected is shown as observed, not ready. Normal CLI stop removes this record; a tray-requested Stop retains the verified private owner and heartbeat so Restart remains available.
- These independent services appear in their own dashboard section, while the per-Core summary explicitly says `Core-local MCP`, `Core-local Muse Watch`, etc. **An older running Muse Watch does not publish the new heartbeat until that watcher is restarted through its normal stop/start flow**; the tray deliberately does not stop or replay live tasks.
- Read-only native diagnostic: `superagent-tray.exe --diagnose-services` prints sanitized cross-process MCP/tunnel/Muse states as JSON without initializing the window, opening a tunnel or reading credentials into the UI.
- Delegate's private WebSocket port is **not** actively probed because that protocol requires extension-origin authentication; a TCP-open check cannot prove a connected Delegate browser extension. Custom T-Line ports without a discovery record are also not enumerated automatically.

**Operational reminder:** Restart the running SuperAgent Core after updating this source for `/api/desktop/runtime-services` to be available. Older Core processes still report Core, scheduler and gateway status; the extra local services appear as unverified, not falsely offline.

## Create new MCP, HTTPS and Muse connections from Tray

Open **Runtime Detection → + New Connection**. Choose the **authenticated selected Core** first. The UI displays the fields relevant to each connection, asks for confirmation before creating a public endpoint, and shows the resulting endpoint/operation status. Creation does not stop, replace, or adopt an existing owner. The new fixed-shape native `create_connection` command invokes only the authenticated loopback Core route `POST /api/desktop/create-connection` (never arbitrary shell/URL requests).

| Choice | Effect | After creation |
| --- | --- | --- |
| **External MCP server** | Registers a named HTTPS (or local loopback HTTP) MCP client in SuperAgent's existing `model-config.json`; OAuth optional. Duplicate names are refused and existing entries remain unchanged. | State **configured**; connection must be established or reloaded in an active MCP session before its tools are available. |
| **SuperAgent MCP tunnel** | Creates a new independent, managed MCP owner on a requested unused port. Cloudflare or a previously provisioned OpenAI Secure MCP Tunnel ID. Exposes **safe/read-only tools only**, with OAuth. | Owner startup is authenticated/verified. Public endpoint appears in result. Private OAuth one-time bootstrap setup is copied by Core directly to the **OS clipboard**, not returned through webview. If clipboard fails, run `superagent mcp tunnel token regenerate --port <port>` in a private local terminal. |
| **Core HTTPS tunnel** | Publishes the currently selected authenticated Core REST/SSE port through a Cloudflare quick tunnel. Only this Core's own port can be targeted. | The endpoint appears in results. **Existing Core Bearer auth remains required**. Avoid exposing the Core token. |
| **Muse WebSocket tunnel** | Starts a new Core-owned Muse watcher on an unused port and publishes WSS through Cloudflare, using a separate private `tray-muse-<port>.json` token/configuration. It uses the configured watched workspaces, does **not** overwrite Telegram config, and disallows auto-approving workspace permissions. | A private Muse connection prompt is copied to the local **OS clipboard**, not returned in webview. If copying fails, retrieve the protected token in the local `tray-muse-<port>.json` file. |

**Lifecycle and security:** all creation modes require an updated, healthy local Core and an explicit confirmation; `SUPERAGENT_CONFIG_DIR` overrides are honored by the model/Muse configs. On older running Core processes, creating a connection returns unsupported/404 until a **controlled Core restart** loads the new endpoint; the Tray update alone does not update a running Core. Public tunnels change URLs when restarted. The standard Registry/Runtime Detection panel continues to verify actual instances/heartbeat; an external MCP configuration is not misrepresented as a live tunnel. The Tray UI never receives bearer credentials, private Muse tokens, or OAuth bootstrap secrets. Muse creation expressly **does not abort an active remote task**; it fails safely if a task is in progress.

## Regenerate Token (verified service owners only)

Each compatible **Runtime Detection** card includes **Regenerate Token** and an explicit confirmation dialog. The button is disabled if its private control owner cannot be verified, if the owner is an unsupported legacy mode, or if a Muse task is active. Neither the new token nor an OAuth approval code is returned to the Tray WebView, runtime scan JSON, logs or audit payload.

- **Managed MCP Cloudflare / OAuth / reloadable owner:** regenerates only the one-time **OAuth bootstrap approval code**, not the public URL, access tokens, refresh grants, Cloudflare API credentials or an OpenAI Secure MCP Tunnel ID. The server checks the exact managed owner PID and authenticated owner contract. New private approval setup is copied to the operating system clipboard by Core. Existing paired OAuth clients and their grants remain intact. **Static-Bearer MCP, legacy owners and OpenAI-tunnel control-plane credentials are deliberately unsupported**; use their existing explicit operator migration/credential workflows.
- **Muse WebSocket:** a verified running watcher performs `MuseWsServerTransport.rotateToken("superagent_tray_operator")` in the original owner process, keeping a **5-minute previous-token grace period** and pushing an authenticated `token_refresh` event to an existing Muse connection. Rotation never stops Cloudflare or interrupts an active batch; active/queued tasks are rejected. A private bearer/setup prompt is copied to the OS clipboard (if copying fails, the protected local Muse configuration is the recovery source). Independent Muse CLI owners receive a new authenticated `/_muse/token/rotate` route, while Core-local Muse uses the authenticated `POST /api/desktop/regenerate-token` route.
- **Not applicable:** a Cloudflare Quick Tunnel URL has no rotating SuperAgent bearer of its own; the Core REST Bearer token, third-party MCP client credentials, OpenAI tunnel IDs and Telegram bot tokens are **not rotated through this generic button**. They have different lifecycle and safety contracts.
- **Compatibility:** independent Muse owners need to be running the updated code; MCP OAuth bootstrap rotation needs a reloadable managed owner plus updated Core API. Old Core currently responds HTTP 404 to new desktop routes until restarted during a safe maintenance window. The Tray will not restart it automatically.

Safety details: tokens pass only through authenticated private loopback channels and the owning process' OS clipboard helper; the clipboard helper now checks actual command exit status rather than assuming success. No production MCP/Muse tokens were regenerated during development; tests use isolated mock servers, token strings and temporary directories.

## Stop and Restart from Runtime Detection

The **Stop** and **Restart** buttons are present on service cards and enabled **only** when the application has a currently verified private owner control channel. Every operation requires an explicit confirmation dialog. Native Rust rechecks registration, owner PID/process birth, authenticated owner status, permitted operation and safety gates; public URLs and private bearer tokens are never passed to JavaScript. Disabled controls carry an explanation.

- **Managed MCP server — Stop:** graceful `status → drain → stop`, only when **no active sessions or in-flight requests**. Never sends `force=1`, OS `SIGKILL`, or arbitrary process commands. The associated managed Cloudflare tunnel stops through its owner. Stop is terminal; a new MCP service must be started by its authorized CLI/operator.
- **Managed MCP server — Restart:** owner-supported `reload` of its backend generation, with the **same owner PID and pinned public URL** verified afterwards. Legacy MCP owners without `reloadable: true` do not offer this button. This is **not** a Cloudflare URL rotation.
- **Core Supervisor — Restart:** authenticated supervisor control endpoint creates a new Core worker generation while retaining previous session ownership; respects the existing generation limit. Ordinary Core servers and direct **Core Stop** remain unsupported until a safe owner/drain lifecycle exists.
- **Muse Watch — Stop / Restart:** independently launched CLI watchers expose `127.0.0.1` private lifecycle ownership through `muse-owner-<pid>-<nonce>.json` (mode 0600) and a token-free presence heartbeat. The owner verifies an authenticated request and refuses active or queued task batches. Stop keeps only the owner listener to permit Restart; Restart uses the existing watcher instance/options, never replays started work. Watchers owning a Cloudflare tunnel **cannot Restart** through this shortcut because it could rotate the public URL. An authenticated **Core-local** Muse Watch can also be stopped/restarted via `POST /api/desktop/muse-lifecycle`; it checks the exact Core PID and existing tasks.
- **Cloudflare tunnel, T-Line transport, independent channel-host and unsupervised Core:** no guessed Stop/Restart buttons; controls remain disabled until their respective owners support safe lifecycle operations. Stopping a tunnel directly by PID is deliberately forbidden.
- **After an upgrade:** an already-running Core/CLI/Muse process still uses its original code. Restart each owner **only during a safe maintenance window**, after verifying no in-flight tasks. The tray itself will not restart it automatically.
- **Testing:** owner-mocked TCP lifecycle tests and browser UI confirmation/denial tests are not proof that stopping the user's live MCP tunnel or Muse instance is safe. No live production service was stopped or reloaded during development.

## Security and limitations

- **Never** read/write `daemon-jobs.json` directly from desktop: the daemon owns job creation, updates, runs, persistence and ledger.
- Native Rust commands expose fixed allowlists for daemon and verified service-owner operations. No arbitrary HTTP proxy, user-entered host, shell, PID termination, or generic filesystem access is exposed to the WebView.
- A cron reminder is delivered as an OS notification only when (1) Core + scheduler are running and the task fires, (2) Desktop is running in the tray, (3) OS notifications work. If Desktop is temporarily offline, it searches recent successful runs (within 2 hours) on restart. Expired/offline reminders are not scheduled by Tauri itself.
- Avoid two independent daemon owners for the same `daemon-jobs.json`; the existing scheduler does not provide a multi-process ownership lock. Run desktop against the one authoritative Core daemon.
- A five-field cron expression cannot represent a year or seconds and DST handling follows the existing Core local-time cron parser. One-time entries use `maxRuns=1` and fail client-side validation if the selected date/time is not in the future.
- Automatic launch when a SuperAgent CLI/server/transport owner starts and a native single-instance guard are implemented. Windows logon startup, Core process supervision, installation signing, a separate offline reminder scheduler and multi-device notification delivery remain for product approval.
- This prototype intentionally does **not** alter Muse Watch transport or auto-replay stalled Telegram batches.

See `docs/plans/2026-11-04-superagent-tauri-tray-cron-management.md` for decisions and release gates.
