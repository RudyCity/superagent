# SuperAgent Tray — Unified Async Feedback, Loading & Toast Master Plan

**Date:** 2026-11-12
**Repository:** `D:\backup from pc asus\Documents Development\superagent`
**Audited baseline:** `main` at `d91ed395`
**Status:** **P0 implementation completed in source; P1 and major P2/P3 action coverage integrated; native desktop acceptance still pending.** No automatic runtime restart or deployment was performed.
**Owner intent:** Every meaningful user-triggered asynchronous operation must show visible work in progress and trustworthy outcome feedback. Prioritize **Create connect QR** and **Create APK download QR**.

## 1. Current-state findings (source inspection)

The Tray has nine main navigation destinations: Schedules & Reminders (`jobs`), Runtime Detection (`runtime`), Execution History (`history`), Connection Logs (`logs`), Chrome Delegate (`delegate`), Terminal Processes (`terminal`), Muse File Transfer (`muse-files`), LAN Devices (`lan-devices`), and Tray Settings (`settings`). Important embedded subflows include Runtime Create Connection, Unified Lifecycle/Global Recycle, CDP Multi-tab and private preview, LAN QR/pairing/file transfers/remote screen, and Muse settings.

- A single global `#toast` exists in `index.html` and `.toast`/ `.toast.error` in `styles.css`. Only `app.js` owns its timer/function; multiple feature scripts instead implement local notices, status text, or blocking `alert()` calls. There is no shared action-loading controller.
- `lan-devices.js` already guards concurrent operations through `state.busy`, disables QR buttons and maintains 5-second QR heartbeat. It shows local `#lan-banner`, `#lan-tunnel-status`, and `#lan-apk-status`, but not a spinner/visible loading label on the initiating QR button. An automatic refresh currently invokes a button `.click()`, so a naive global toast hook would incorrectly announce background refresh as a manual success.
- Native `lan_support_action` permits `tunnel_invite`, `apk_download_qr`, and `qr_heartbeat`. Its caller timeout is **75 seconds for either QR generation**, versus up to **125 seconds for pairing/open/file offer**, and up to **100 seconds for Create Connection**. Do not assert a completion before verified native responses.
- `settings.js` disables its Save button but writes success/error to inline text. `runtime.js` and `lifecycle.js` already guard expensive mutations and render distinct operator-review feedback. `delegate.js` and `terminal.js` still use blocking `alert()` for some errors. `muse-files.js` and `lan-file-transfer.js` already provide actual progress feedback; do not replace it with fabricated percentages.

## 2. Interaction state contract

| State | Button | Toast | Persistent inline UI |
| --- | --- | --- | --- |
| Idle | Original label and enablement | None | Current server state |
| Confirming | Keep original label until operator approval | None | Explain effect in existing confirmation dialog |
| Pending (user triggered) | Inline spinner + verb ("Generating QR…"), disabled, `aria-busy=true` | No premature success | Human-readable phase and elapsed/wait guidance when long |
| Awaiting external approval | "Awaiting approval…" or release initiating button when protocol supports it | Informational, not success | Explicit target-device approval state; may take 90–125 seconds |
| Verified success | Restore label and controls | Success toast *once* | Update QR card, status, result, or verified owner |
| Rejected/failed | Restore label and controls | Error toast with safe next step | Preserve enough context for recovery |
| Timeout / unknown after dispatch | Restore controls conservatively; lock unsafe retry path | Warning toast; **never label as failed or successful** | Original operation ID, read-only reconciliation instructions |
| Canceled/declined | Restore idle | Usually silent | Preserve earlier state |
| Background refresh/poll | Never hijack visible manual button | Silent on success | Quiet refresh status; error shown only if user action or sustained degradation |

**Semantics:** `QR ready` means a valid one-time ticket and rendered QR, **not** that a device connected or downloaded an APK. `Connection created` requires accepted owner response, not simply request submission. `File sent` requires protocol verification, not upload-start acknowledgment. `Restart succeeded` requires verified owner/health evidence.

## 3. Shared UI infrastructure (Phase P0)

Add `apps/superagent-tray/ui/feedback.js` (loaded before other feature scripts) and use existing `styles.css` and `index.html` for the feedback host. Do not introduce React, a second UI framework, or another state owner.

**Proposed public interface** (design contract, not yet code):

- `TrayFeedback.notify({kind:'success'|'error'|'warning'|'info', message, scope, dedupeKey, sticky?})`: escaped text only, bounded queue, capped visible toasts (e.g. 3), close control, dedupe repeated polling messages; keyboard and screen-reader accessible. Success may dismiss after ~4 seconds; errors after ~6–8 seconds; outcomes marked *unknown* must remain discoverable inline.
- `TrayFeedback.run({key, button, label, scope, operation, verify, success, failure, uncertain, background?})`: acquire per-action lock, save original label/disabled/ARIA state, show a 14–16px spinner while busy, clear in `finally`, then surface verified outcome. Never count `invoke()` returning as proof when the action requires a server-side verification. Respect upstream refusal and user cancellation.
- `TrayFeedback.setPhase({scope, phase, detail})`: set plain-language progress with no false percentage, especially for 75–125 second native calls.
- `TrayFeedback.isPending(key)` / `withActionLock`: use existing module busy guards and a stable action key; prevent repeat clicks, Enter/submit re-entry, scheduled heartbeat collisions, and overlapping operations. Avoid disabling *all* UI just because one independent action is busy.
- `TrayFeedback.clearScope(scope)`: prevent stale messages after navigating to a new page or changing selected device/Core, but preserve persistent uncertainty records and valid QR leases.

**Accessibility & design:** keep existing dark academic console tokens; preserve button width and original label, focus after completion, do not steal focus for a toast. `aria-busy` on button/region; `role=status`/polite for neutral/success and assertive for actionable errors; `prefers-reduced-motion`; 320/390/768/1280 responsive layout; pointer/keyboard parity. Native title bar/window controls stay independent and do not need artificial spinners.

**Privacy & safety:** never display Core bearer, private tunnel setup URI, pairing code, secret QR contents, access tokens, certificate material or raw unsafe server errors inside toast, telemetry, or logs. Only copy sensitive setup details to clipboard through current guarded workflow.

## 4. Full action coverage map

| Surface / source | User-triggered actions to cover | Feedback tier | Priority |
| --- | --- | --- | --- |
| LAN device QR · `lan-devices.js` | **Create connect QR**, **Create APK download QR**, QR renewal/expiry/used state | Spinner on relevant button + status phases + one success/error toast, keep active QR TTL/heartbeat inline | **P0** |
| LAN discovery / pairing · `lan-devices.js` | Scan LAN, Refresh devices, Request pairing, Complete local pairing, Request session, Open/Close session, Revoke pairing, tunnel pair request/revoke, Run command, Android health/support snapshot | Per-action spinner + target approval state + toast; preserve fingerprints and consent | **P1** |
| Runtime / Create Connection · `runtime.js` | Scan Now, Select Core, Create Connection, start/stop/restart eligible services, regenerate token, apply Muse settings | Spinner + inline operation receipt/owner outcome + toast; never auto-retry unknown | **P1** |
| Unified Lifecycle / Global Recycle · `lifecycle.js` | Refresh Lifecycle, Analyze Recycle, Prepare Plan, Confirm & Execute, Reconcile, Save Recovery Policy, owner-bound plan/execution | Stage-specific spinner, plan expiry, persistent unknown-result warnings; success only after attested status | **P1** |
| LAN file transfer · `lan-file-transfer.js` | Send file, Send folder, Receive owner file, Cancel | Existing real byte/protocol progress + guarded initiating button + toast on confirmed outcome | **P2** |
| Muse file transfer · `muse-files.js` | Refresh, Choose file, Send, Pause, Resume, Cancel, Save settings | Preserve existing real bytes/%/rate/ETA; short toast for accepted/verified milestones, no false delivery completion | **P2** |
| Remote Android control · `lan-screen-viewer.js` | Start schema-first, single screenshot fallback, Stop, Back/Home/Recents, Send text, End remote session | Action-level spinner/status, consent waiting and timeout/unknown guidance; stop and revoke unconfirmed distinct | **P2** |
| Chrome Delegate · `delegate.js` | Refresh, Start/Stop listener, Renew pairing code, Copy code, Disconnect client | Spinner; toast; keep expiry countdown and device/connection state; replace blocking alerts | **P2** |
| CDP Multi-tab · `delegate-multitab.js` | Refresh, Open tab, Claim/Release, Queue task, Launch parallel, Acknowledge uncertain send, Aggregate, Follow agent, takeover/return, preview, approval/replay actions | Busy state per tab/task; toast for verified acknowledgments, permanent receipt for unknown writes | **P2** |
| Terminal Processes · `terminal.js` | Launch, Stop, Start, Pause/Resume, Kill All, Prune, Refresh, Copy logs, external owner actions | Spinner + confirmation + verified process-state feedback; replace relevant blocking alerts | **P2** |
| Schedules & Reminders · `app.js` | Refresh, Start Core/Scheduler, Create/Update, Run now, Pause/Resume, Delete | Adapt existing toast to shared host; spinner for actions; preserve confirm dialogs and scheduler state | **P3** |
| Execution History & Logs · `app.js`, `logs.js` | Refresh history/logs, live-tail toggle, filter/search, Export JSON, Copy JSON, pagination, clear inputs | Spinner only on async read/export/copy; lightweight silent state for local synchronous controls | **P3** |
| Tray & Muse Settings · `settings.js` | Save Settings, Restore Defaults (draft only), Save Muse, Test Telegram, Regenerate WS Token, Apply & Restart Muse | Spinner + toast for confirmed results; inline fields/validation; no toast claiming defaults saved | **P3** |
| Native window chrome · `titlebar.js` | Minimize, Maximize, Close | Keep immediate native UX; report errors only if native command fails. **No spinner for instantaneous navigation/window controls** | **Exempt** |

A complete implementation must enumerate both static buttons in `index.html` and dynamic row/card buttons created by feature scripts. Exempt pure synchronous navigation, input editing, filter changes, and open/close modal toggles from gratuitous success toasts.

## 5. QR detailed design — first deliverable

### Connect QR
1. On explicit click, acquire `lan:connect-qr` lock. Keep original label to restore; show spinner and `Creating connect QR…`.
2. Inline phase: `Checking Core and HTTPS tunnel…`; `Preparing one-time invitation…`; `Rendering and validating QR…` only when actual phase evidence exists; otherwise show a truthful generic phase plus elapsed time, **not** fabricated step advancement.
3. Invoke the existing `tunnel_invite` once. Native timeout may reach **75 seconds**. Never issue an automatic second create request after uncertain timeout.
4. Validate `inviteId`, expiry, setup type, and QR matrix before exposing card; safely retain a previously valid QR until new evidence is ready (unless revoked/expired). Keep QR countdown, heartbeat and used/expired status inline.
5. On confirmed creation: restore button; toast `Connection QR ready. Scan before it expires.`; inline `QR active · mm:ss remaining`. **Do not toast “device connected.”**
6. On verified pairing/enrollment: update device list and show separate confirmation. On failure show a bounded error and corrective action; preserve secure debug detail in authorized logs only.
7. Automatic heartbeat refresh is **silent** (no manual button click or repeated success toast). It must use a separate background lock and must not overwrite a newer QR result. Show inline recovery for sustained heartbeat failure.

### APK download QR
1. Acquire separate `lan:apk-qr` lock; button `Preparing APK QR…`.
2. Invoke `apk_download_qr` once and validate filename/size/SHA-256/heartbeat ID/expiry and QR matrix. Never claim APK already downloaded.
3. On verified ticket creation: toast `APK download QR ready.`; retain `filename · size · SHA-256` and remaining TTL in the card.
4. On unavailable APK, missing Core/tunnel, expired ticket, or native timeout: show readable error/warning; restore button; mark unverified outcomes accurately.
5. Heartbeat renewals do not emit repetitive toasts; ticket continuity must be checked before replacing the visible QR.

**Race cases:** double click; simultaneous connect/APK creation; auto-refresh colliding with manual refresh; response from previous selected Core; navigate away and back; Core tunnel rotates; old QR expiring during renewal; app background/foreground; clipboard unavailable; user uses QR while renewal is pending.

## 6. Staged implementation sequence

| Stage | Scope | Deliverables | Exit gate |
| --- | --- | --- | --- |
| P0-A Foundation | `feedback.js`, `index.html`, `styles.css` | Shared notify/run/phase API; success/error/warning; accessible loading/toast styles; bounded queue and dedupe | Unit tests for timers, locks, restoration, ARIA, sanitization |
| P0-B QR first | `lan-devices.js`, Tray LAN tests | Connect QR/APK QR loading, confirmed toasts, inline TTL, silent heartbeat, no duplicate generation | Manual and mocked tests for 75s, timeout, revoked, expired, double-click, stale response |
| P1 Lifecycle/Runtime | `runtime.js`, `lifecycle.js` | Create Connection, owner-bound operations; exact uncertain-operation receipt; no accidental retry | Verified owner and operation-ID tests; existing lifecycle gates intact |
| P1 LAN actions | `lan-devices.js` | Scan/pair/session/revoke/command per-action feedback | Physical approval/timeout and error states; no false connection claim |
| P2 Extended actions | `lan-file-transfer.js`, `lan-screen-viewer.js`, `muse-files.js`, `delegate.js`, `delegate-multitab.js`, `terminal.js` | Retain progress and consent UI; add button busy/verified toast; replace unnecessary alerts | Existing security/ownership/transfer/cancellation tests pass |
| P3 Polishing | `app.js`, `logs.js`, `settings.js` | Consistent schedules, settings, history/logs; avoid toast spam | No duplicate toasts; safe actions still usable at all widths |
| P4 Acceptance | Tests/docs, native Tray | End-to-end interaction matrix, visual QA, installed binary verification | No regressions; UI tested in native Tray, not merely a web mock |

**Change governance:** no new branch/worktree; begin every implementation slice with `git status --short --branch`; preserve concurrent changes; stage only owned paths. For implementation, update version/changelog and commit only scope-approved changes. No implicit Core/MCP restart, tunnel rotation, privileged install, or public ingress creation beyond current explicit action flow.

## 7. Acceptance criteria and test matrix

- Every covered asynchronous action: (a) immediately visible spinner/label; (b) duplicate clicks blocked; (c) button restored through `finally`; (d) actionable error; (e) verified success toast once; (f) relevant details persist inline.
- QR paths: manual click, expired QR, automatic heartbeat, QR used, Core unavailable, HTTPS tunnel startup, slow 75-second native call, stale response, invalid matrix, missing APK, scanner opens from phone, recovery after app focus. Success toast **only** on new manually initiated QR; no secrets/tokens in toast.
- Lifecycle: plan-only not success of execution; scheduled recycle not success of supervised startup; uncertainty retains original operation ID; no automatic retry/second tunnel; independent MCP never implicitly interrupted.
- Data transfer: progress derived only from actual bytes; percent not fabricated; accepted transfer is not confirmed recipient delivery; cancellation feedback reflects server acceptance.
- Accessibility: aria-live behavior tested by type; keyboard Enter/Space; focus after completion; disabled/busy screen reader state; reduced-motion; color contrast; responsive 320/390/768/1280.
- Native desktop: verify actual Tauri `invoke` states and Rust command error paths. Script-only mocks are **not** sufficient proof for production. Preserve existing owner authorization/guardrails and compare supported live UI with current behavior.

**Suggested targeted test files:** `tests/desktopTrayFeedback.test.ts`, `tests/desktopTrayQrFeedback.test.ts`, alongside existing `tests/desktopTrayLanUi.test.ts`, `tests/desktopTrayLanFilesUi.test.ts`, `tests/nativeTrayLifecycleUi.test.ts`, `tests/nativeTrayRecycleUi.test.ts`, `tests/desktopTraySettingsUi.test.ts`, `tests/desktopRuntimeUi.test.ts`, and relevant Chrome Delegate/Terminal/Muse tests.

## 8. Implementation progress (2026-11-12)

**Implemented in source (verification via targeted automated tests, not installed native Tray certification):**
- Shared `TrayFeedback` notification queue, dismissals, dedupe, per-action locks, spinner labels, and accessible busy states (`feedback.js`, `index.html`, `styles.css`); existing schedules migrated to shared toast.
- Connect QR and APK QR manual loading/status/toast with original QR validations intact; quiet heartbeat/background refresh no longer simulates manual `.click()`; double-click and unknown-timeout tests included.
- Runtime scan, Create Connection, verified service commands, Lifecycle/Global Recycle plan/execution uncertainty feedback; safeguards/operation IDs preserved.
- LAN discovery, pairing and device actions, LAN and Muse file-transfer controls; real byte/protocol progress preserved. Screenshot fallback and remote input/stop signals surface truthful result messages.
- Tray/Muse settings, Terminal Process actions, Chrome Delegate, Multi-tab task actions, and Connection Logs manual feedback.

**Remaining release gates:** native Tauri visual/keyboard/screen-reader validation at 320/390/768/1280; physical Android end-to-end QR setup/download/installation and long timeout checks; finish per-row long-lived progress/uncertain receipt UX in advanced lifecycle/CDP/terminal actions; review remaining native `alert()` use case by case. Build success is not proof of installed desktop behavior. This plan is a tracked implementation roadmap, not a finished native-release certificate.

## 9. Definition of done

The Tray should always answer: **“Is the action running?”**, **“What was actually confirmed?”**, and **“What should I do if it fails or times out?”** without guesswork. Done means implemented coverage in the map, all targeted tests passing, native visual/accessibility verification, and an explicit list of deferred unsupported statuses. This plan is not implementation evidence.
