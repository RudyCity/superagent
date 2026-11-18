# Tray Notification Navigation Audit — 2026-11-18

## Scope

Audited all 17 native Notification Center sources declared in `apps/superagent-tray/ui/notifications.js`, their Rust producers in `src-tauri/src/main.rs`, and the actual page/tab entrypoints in `ui/app.js`, `ui/runtime.js`, `ui/access-manager.js`, `ui/delegate.js`, `ui/lan-devices.js` and `ui/settings.js`.

The Notification Center is a **read-only navigation surface**. A click must never approve project access, restart a process, retry a run, grant MCP capabilities, or invoke a destructive action. User-visible titles/bodies are not navigation instructions.

## Source routing inventory

| Source | Default destination | Contextual exception |
| --- | --- | --- |
| `core` | Runtime Detection → Core | Core health outage remains in Core |
| `security` | Security Approval | `mcp-pending:connections:<id>` → Connections + exact request; `mcp-pending:mcp:<id>` → MCP + exact request |
| `mcp` | Runtime Detection → MCP | Client loss and owner loss stay on MCP |
| `tunnel` | Runtime Detection → Cloudflare | Tunnel health loss stays on Cloudflare |
| `delegate` | Chrome Delegate → Bridge & Pairing | `health:delegate-listener` → Diagnostics |
| `runtime` | Runtime Detection → Core | `health:muse` → Runtime Muse; `health:telegram` → Settings Muse; `health:channel-hosts` → Runtime Hosts |
| `desktop-live` | Desktop Live | No stable per-session ID in current native incident contract |
| `terminal` | Terminal Processes | No stable per-process ID in current native incident contract |
| `lan-devices` | LAN Devices → Devices & Pairing | No stable pairing ID in current native incident contract |
| `reminder` | Schedules & Reminders | `reminder:<runId>` → Execution History + run highlight |
| `jobs` | Schedules & Reminders | `daemon-run:<runId>:Scheduled run needs attention` and `daemon-run:<runId>:Scheduled notification delivery failed` → History + run highlight |
| `updates` | Updates & Releases | No stable release ID in incident contract |
| `shutdown` | Overview | Lifecycle information is on Overview |
| `settings` | Settings → General | No trusted settings sub-tab in the incident identity |
| `muse-files` | Muse File Transfer | No stable transfer ID in incident contract |
| `overview` | Overview | — |
| `logs` | Connection Logs | No stable log ID in incident contract |

Legacy `mcp-pending:<id>` notifications remain supported: the native Access Manager obtains the exact tab from authenticated request inventory, not the notification text. If a referenced run/request is no longer available, no other run or permission card is selected. For scheduled runs, History displays an explicit unavailable message.

## Navigation contract

1. `navigateToPage` accepts fixed main pages plus allowlisted `page:tab` routes for Security Approval, Runtime Detection, Settings, Delegate and LAN Devices. Unknown routes fall back to Overview.
2. Tab selection occurs through the corresponding page's own UI controller after page selection. It does **not** rely on a `hashchange` event: `history.replaceState` does not dispatch that event.
3. MCP approval notifications carry only an opaque request ID and a fixed category from authenticated native inventory. Opening a card/CTA scrolls to the exact request when available; authorization remains a separate attended native action.
4. Scheduler notifications carry only the run ID already stored by the native ledger; no commands, prompts, secrets or paths are inserted into a URL or CSS selector. The target row is escaped and highlighted; no retry is executed.
5. Notification cards and their navigation CTA share the same destination; lifecycle buttons (mark read, resolve, archive) remain independent.
6. An OS banner remains generic on purpose: the private native inbox holds detail. **OS banner click-to-exact-event is not part of this implementation** because the current native notification payload does not carry an authenticated incident click token.

## Verification / gaps

- Added parameterized Vitest navigation coverage for all source categories, contextual health events and exact MCP/project request tabs in `tests/desktopTrayNotificationsUi.test.ts`.
- Added client-side navigation checks for fixed sub-tabs and run selection, and repaired earlier malformed test assertions.
- JavaScript syntax and route/card interactions can be verified without desktop privileges. Official Bun/Vitest/Cargo CI and live installed Tray click-through **must be run separately**; commits alone do not prove runtime readiness.
- Remaining possible future enhancement: first-party OS notification activation with authenticated incident IDs, plus native stable IDs for terminal, Desktop Live, LAN pairing, update, and Muse file transfer events. These must not be inferred from untrusted notification body/title.
