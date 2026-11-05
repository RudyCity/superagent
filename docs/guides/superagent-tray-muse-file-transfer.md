# Muse File Transfer Manager — SuperAgent Tray

The **Muse File Transfer** page is embedded in the existing Tauri SuperAgent Tray. It is not a separate application. The tray menu also exposes **Muse File Transfer** and the page is available as the startup page.

## Sending a file

1. Open Tray → **Muse File Transfer**.
2. Inspect **Muse WebSocket** status. The page checks a watcher inside the **selected authenticated Core process**, not merely whether a Cloudflare tunnel process exists.
3. Click **Browse Files**. The Rust native file dialog chooses a local regular file, checks its size (maximum 8 MiB), refuses known secret filenames and symbolic links, and keeps the absolute path outside the WebView. The one-use ticket expires upon submission.
4. Choose **Muse WebSocket** for SHA-256-acknowledged delivery or **Telegram** for Bot API document attachment. Telegram success is only Bot API acceptance, **not** proof Muse downloaded the file.
5. Click **Send File**. Watch the current transfer and the history ledger.

The Core manager is implemented in `src/core/runtime/desktopMuseFileManager.ts`. Rust native commands are in `apps/superagent-tray/src-tauri/src/muse_file_transfer.rs`, and the UI is in `apps/superagent-tray/ui/muse-files.js`, `muse-files.css` and `index.html`.

## Controls and semantics

- **Pause:** WebSocket only. Stops the currently running sender via its cancellation hook while preserving the durable sender/receiver checkpoints. This is a cooperative pause, not TCP socket suspension.
- **Resume:** WebSocket only. The sender reopens the same local file, reuses the checkpoint if SHA-256 matches, asks the receiver for `next_index`, and continues. It is available for paused, cancelled and failed uploads. Resume requires a live authorized Muse watcher in the same Core process. No background retries on operator's behalf.
- **Cancel:** Stops active WebSocket delivery but retains the checkpoint. The transfer is recorded as cancelled; Retry can be used later. Telegram multipart submissions cannot be cancelled/resumed safely after acceptance is ambiguous.
- **History:** At most 80 recent entries are persisted in the SuperAgent configuration directory under `muse-desktop-file-history.json`. The file contains the local source path for retries, but API responses and WebView DOM **never reveal absolute paths**. Pruning obeys 1/7/14/30 day local retention and does not automatically delete original source documents.
- **Progress:** Percent and bytes come from actual authenticated file transfer acknowledgements. Rate and ETA are UI estimates from successive polls, shown only when there is measurable progress. Telegram does not publish chunk-by-chunk progress.
- **Settings:** Max upload 1/2/4/6/8 MiB (protocol hard cap 8 MiB); local history retention; polling interval 1/2/5/10 seconds; default channel. Saved to `muse-desktop-file-settings.json` outside the app. Changes to remote Muse's receiving directory, maximum incoming storage and incoming retention are **not controlled** from this Tray.

## Architecture and security

WebView → allowlisted Tauri invoke → Rust native one-use selection, using tauri-plugin-dialog → Core API via authenticated loopback (with proxy disabled and forwarded/Origin headers refused) → in-process `MuseWatcher` / `MuseClient` → authenticated receiver.

- The WebView is not granted filesystem, shell, or HTTP permissions.
- Rust chooses the file and prevents reuse of its one-use selection ticket; the WebView cannot submit arbitrary local paths.
- The Core rechecks symlinks, forbidden secret filenames, regular file requirements and size before sending.
- Core transfer endpoints are fixed-action and fixed-shape, with an authenticated loopback guard.
- If the local Core is not the watcher owner, Tray displays the disconnected condition and refuses upload; it does not silently launch another Muse watcher or take over an existing one.
- A successful local WebSocket integration test is not proof of a deployed Muse peer. The remote Muse runtime still needs to configure the compatible receiver and send verified acknowledgements.

## Concurrency and disconnected-socket safeguards (2026-11-04)

- The Core manager serializes asynchronous Start and Resume requests so repeated button clicks or simultaneous IPC calls cannot start two uploads against the same watcher.
- Pause/Cancel can abort an in-flight ACK wait even if WebSocket connectivity was lost after the upload started; they do not require a *currently connected* socket. Resume remains gated on an authenticated, reconnected watcher.
- The Core manager exposes waitForIdle() for graceful shutdown/tests, ensuring its final history write completes before temporary storage is removed.
- Numeric settings now require actual JSON numeric values rather than coercible strings; settings and sensitive file paths remain inaccessible to arbitrary WebView scripts.
- New tests exercise simultaneous Start requests, duplicate Resume requests, offline Pause, and malformed numeric settings.

**Deployment status:** Running tunnel is not equivalent to an authenticated Muse session. The last read-only status check showed a Cloudflare tunnel owner on port 9225 but **no authenticated Muse session and an inactive watcher**. Therefore external file delivery remains unverified; do not present local ACK simulations as evidence that a separate Muse device received a file. Source modifications on \`main\` are not automatically loaded into an existing Tray executable or Core process; a supervised build/reload and actual Muse peer connection are required. Do not interrupt unrelated live tunnels or Core sessions just to activate this feature.

## Tests and build

- `bun --bun x vitest run tests/desktopMuseFileManager.test.ts tests/desktopMuseFileUi.test.ts`
- `bun --bun x tsc --noEmit`
- `cargo check --offline --manifest-path apps/superagent-tray/src-tauri/Cargo.toml`
- `cargo test --offline --manifest-path apps/superagent-tray/src-tauri/Cargo.toml muse_file_transfer::tests`
- Re-run existing `tests/museFileResumePersistence.test.ts` and `tests/museFileReceiverIntegration.test.ts` to ensure backward compatibility.

Native executable reinstallation or controlled Tauri/Core process restart is a **separate operational deployment step**. Editing the source and passing tests do not activate this UI in an already running Tray binary. Avoid replacing another developer's live tray and other owners without explicit coordination.
