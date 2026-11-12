# SuperAgent Delegate — isolated ChatGPT extension

## Direct MCP tools — backend integration (2026-11-04)

The **SuperAgent MCP connector** exposes these direct tools, independently
from agent-internal `delegate.*` names:

- `superagent_delegate_read_chat({connections:true})`: list connected Chrome profiles.
- `superagent_delegate_read_chat({clientId, tabId?})`: read the currently selected ChatGPT tab.
- `superagent_delegate_list_chats({clientId?, cursor?, limit?})`: paginate ChatGPT history titles + chat IDs.
- `superagent_delegate_read_chat_full({clientId?, chatId, cursor?, limit?})`: read a historical conversation including older/virtualized turns.
- `superagent_delegate_search_history({clientId?, query, limit?, maxChats?})`: search history titles and message content with snippets.
- `superagent_delegate_create_chat({clientId?, tabId?, newTab?})`: with `newTab:true`, open a separate ChatGPT tab and return its `tabId`; otherwise start New chat in the selected tab.
- `superagent_delegate_send_message({message, clientId?, tabId?})`: send exactly once.
- `superagent_delegate_stop_generation({clientId?, tabId?})`: Stop only on request.

The connector does **not** use OpenAI API keys or ChatGPT internal endpoints:
MCP → authenticated local SuperAgent HTTP `127.0.0.1:7888` →
existing host-owned Delegate WebSocket `127.0.0.1:17341` →
Chrome Extension → ChatGPT DOM.

Live read plus `list_chats`, `read_chat_full`, and `search_history` are available
with MCP read scope. History operations use a separate inactive worker tab and
never navigate the user's active ChatGPT tab. Create, send and stop require an
authorized MCP write scope plus local YOLO enablement. They are hidden in
read-only MCP catalogs. Gateway mode advertises authorized Delegate tools
directly rather than requiring a natural-language discovery query. An R1
safe-owner restricted catalog does not gain browser access.

**Activation:** Rebuild and restart the Core host before the new
`/api/delegate/mcp-dispatch` route is present; separately restart/reconnect
the MCP server/tunnel and refresh the ChatGPT connector's tool catalog.
**Important:** In default fileless pairing mode, a Core restart rotates
the Delegate secret and **requires the extension to pair again**. Avoid
restarting the live host without arranging re-pairing.

No MCP operation automatically reloads a ChatGPT page or replays the original
message after an RPC/network timeout. For ChatGPT's explicit visible
"Message delivery timed out. Please try again." UI state only, the content
script sends one distinct guarded continuation message, `continue until done`,
without clicking Retry. The activity journal stores redacted metadata only;
the requested chat text is returned only to the authenticated caller.

## Full ChatGPT history reader — v1.6.0

Delegate can now enumerate the ChatGPT history sidebar, read a selected
historical conversation beyond the currently rendered turn window, and search
conversation titles plus message content. All three history operations are
read-only from the user's perspective: the service worker creates one inactive
`#delegate-history-worker` tab, performs the requested scan/navigation there,
and closes that worker in a `finally` path. Historical conversations are opened
through the ChatGPT sidebar SPA link instead of a hard page reload. The active
chat, its draft, and its scroll position are never used as the history crawler.

`delegate.list_chats` returns stable `chat_id`, title, URL, and `next_cursor`.
Continue pagination until `next_cursor` is null. `delegate.read_chat_full`
accepts a `chatId` from that listing and returns message pages with
`next_cursor`, `total_message_count`, and `loaded_complete`. It walks upward
through a virtualized conversation to discover older turns before paging the
result. `delegate.search_history` first enumerates history, then checks titles
and, when needed, opens each candidate in the same disposable worker and
returns matching snippets. `maxChats` bounds the amount of history scanned in
a single search call.

The history worker disables delivery-timeout continuation recovery, so a stale
error banner encountered while browsing old chats can never send
`continue until done`. Arbitrary URLs are not accepted; historical navigation
is constructed only from validated ChatGPT conversation IDs.

## Delivery-timeout continuation recovery — v1.5.3

When ChatGPT renders the delivery-timeout banner together with a visible
Retry control, `delegate.read_chat` reports `status: "delivery_timeout"`,
`delivery_error: true`, `retry_available: true`, and the normalized error
message. The tab is protected from automatic duplicate-tab cleanup while the
error is present.

The content script does **not** click Retry and does **not** replay the
uncertain original prompt. If the composer is empty and ChatGPT is not
generating, it sends the separate follow-up `continue until done` exactly
once for that visible timeout episode. An unsent draft, active generation,
or an already-last `continue until done` message blocks duplicate recovery.
The recovery lock resets only after the timeout banner disappears, so a later
independent timeout can be recovered once as well.

## Current ChatGPT DOM compatibility — v1.5.2

The Delegate content script now accepts the current bare `aria-label="Send"`
and `aria-label="Stop"` controls in addition to the older Send/Stop labels.
Chat reading supports the current `data-chatgpt-search-unit-key` user and
assistant markers, strips the visible "ChatGPT said:" wrapper from returned
assistant text, and reports a cancelled current turn as `status: "stopped"`
when ChatGPT exposes `data-talvt-turn-state="cancelled"`.

## On-demand ChatGPT tab opening — v1.5.1

Delegate no longer requires a ChatGPT tab to be opened manually before the
first RPC. When a selected Chrome profile has zero chatgpt.com tabs and the
request does not specify tabId, the extension opens https://chatgpt.com/ in
that same profile, waits up to 15 seconds for the bundled content script to
become ready, and then continues the original create_chat, read_chat,
send_message, or explicit stop_generation request.

This fallback is intentionally strict. If the caller supplied an exact tabId
and that tab does not exist, Delegate still returns CHATGPT_TAB_NOT_FOUND
instead of opening or selecting another tab. Multiple existing ChatGPT tabs
also still require explicit selection. Automatic opening never retries a
mutation, never reloads a page, and never signs in on behalf of the user.

## Multi-tab mode — v1.9.0 (introduced in v1.8.1)

ChatGPT tabs are **never automatically closed** by the Delegate extension.
Different conversations, identical conversation URLs, drafts, pending responses,
and blank homepages all remain open. The popup lists tab IDs and has a
**Buka tab ChatGPT baru** button. The service worker maintains a read-only
`tabPolicy` snapshot (`mode: "multi-tab"`, `tabIds`, `activeTabId`,
`remainingTabs`); no cleanup means no reloads or implicit chat mutations.

To create a separate chat using MCP, call
`superagent_delegate_create_chat({newTab:true,clientId:"<profile>"})`,
then use the returned `tabId` with `superagent_delegate_send_message`,
`superagent_delegate_read_chat`, or `superagent_delegate_run_until_done`.
`newTab:true` and `tabId` are mutually exclusive. When two or more
ChatGPT tabs already exist, semantic operations without `tabId` fail with
`CHATGPT_MULTIPLE_TABS`; the extension never guesses. CDP can attach
to multiple explicit targets independently and retains per-tab controls.
History worker tabs remain temporary and are closed only by their owner
after an explicit history-read/search operation. v1.9.0 additionally supports
read-only `delegate.list_tabs`, returning up to 40 tab IDs, titles, URLs, readiness
and generating/idle signals without enabling chrome.debugger. Unverifiable
models and loading states are never guessed.

## Historical note: v1.5.0 single-tab mode

Versions before v1.8.1 included automatic closure of verified idle tabs.
That legacy behavior has been removed. Starting with v1.8.1, the extension
keeps every ChatGPT tab open, including idle tabs and duplicate URLs.


This extension is entirely separate from `chrome-extension/`. Its runtime consists of `manifest.json`, `background.js`,
`tabSingleton.js`, `content.js`, and popup files; the README documents installation and security.

## Production pairing directly from server console — v1.4.0

Use a single local SuperAgent agent host and the Delegate extension installed
in each Chrome profile on the **same computer**. No manual secret file or
environment variable is necessary:

```powershell
bun run build
bun dist/cli.js --server 7888
```

On startup the server generates a 256-bit in-memory secret and displays
an **8-character, one-time pairing code** in the server console, for example:

```text
[Delegate][PAIR] Kode: ABCD-EFGH | berlaku 10 menit, sekali pakai | masukkan di popup Delegate
```

This is an *illustrative* code, not a usable production value. Open
`chrome://extensions`, reload **SuperAgent Delegate**, click its popup,
turn it ON, enter the actual displayed code in **Kode pairing dari terminal**,
and press **Pair**. After a successful handshake, the extension receives a
random 256-bit **profile-specific token**, stores it in trusted
`chrome.storage.local`, and automatically reconnects without re-entering
the code for the rest of that server process's lifetime.

After one Chrome profile is paired, the server automatically displays a
**new** one-time code for the next profile. The old code cannot be reused.
Codes expire after 10 minutes, and the console displays a replacement.
Five invalid pairing attempts per minute trigger a temporary lockout.
The token and submitted code are **never written to the persistent connection
audit JSONL** or returned in status responses. Treat the server console as
private while a code is active.

**Restart behavior:** in the default fileless mode, the host intentionally
rotates its in-memory secret on restart, so each browser must pair again
using the *new* console code. Previously saved browser tokens no longer work.
This is a security trade-off for eliminating secret-file management.
To preserve pairing through restarts, an administrator can optionally
configure the existing 32–512 character token through
`SUPERAGENT_DELEGATE_AUTH_TOKEN` or
`SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE`; the same short-code pairing
workflow still works without copying the master secret into Chrome.
If an old, invalid `SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE` variable is set,
clear it from the shell before starting the fileless mode.

The terminal displays **only successfully connected Chrome profiles** as
`[Delegate][CONNECTED]` with full sanitized connection metadata, plus the
independent `[Delegate][PAIR] Kode: XXXX-XXXX` notice. At startup the code
appears as soon as Delegate port 17341 starts listening; after each
successful new pairing the next code appears **directly below** the
corresponding connection line. The terminal does **not** spam
`socket_open`, rejects or disconnects.

All connection lifecycle events (including `listener_started`,
`socket_open`, `pairing_accepted`, `handshake_rejected`,
`disconnected` and transport failures) are retained in daily private
audit files under
`~/.superagent-r/logs/delegate-connections-YYYY-MM-DD.jsonl`, including
UTC timestamp, connectionId, clientId, profile label, extension ID/version,
browser user agent, localhost remote address/port, pairing status, active
connection count, duration, close code and reason. No auth headers, cookies,
chat messages, pairing codes or long tokens are included.

Maximum 8 concurrent Chrome profiles; the extension's ON/OFF toggle is
per Chrome profile. If several profiles are online, select `clientId`
explicitly in every Delegate action. A second session with an already-live
`clientId` is denied instead of evicting the existing client.
The fixed WebSocket port `127.0.0.1:17341` must never be exposed publicly.

### Popup sizing hotfix (v1.10.1)

Chrome action popups negotiate their intrinsic width before displaying. The
old max-width 375px media query using 100vw on the body caused a feedback
loop on Chrome startup, collapsing the popup to approximately 56px and
stacking words vertically. The fixed popup uses intrinsic 392px width on
html and body, including min/max width, with independent vertical scrolling
for the contents. Do not reintroduce viewport-derived body widths.

Verified in isolated Chromium with startup viewports 56, 100, 320, 375 and
392 pixels, all yielding a 392px popup with normal title layout and no
JavaScript errors. Reload the extension once after updating the unpacked
source, then reopen the popup.

### Compact native popup redesign (v1.10.0)

The popup uses a 392px-wide dark navy / mint layout with three keyboard-
navigable views. Its connection status and manual reconnect control remain
visible above the tabs, while the content below scrolls independently.

- **Ringkasan:** Delegate and CDP enable switches, actual ready-tab count,
  attached-CDP count, and privacy explanation.
- **Tab:** ChatGPT tab titles, readiness, exact tab IDs, original per-tab
  repair actions, explicit new-tab action, and connected Chrome profiles.
- **Pengaturan:** Profile name, client ID, manual pairing, and diagnostics.

All actions retain their original permissions and backend message contracts.
The popup version is read from the installed Chrome manifest rather than
hardcoded. Tab changes have no browser/CDP side effects, keyboard left/right/
Home/End navigation is supported, and no external CSS/font dependency is added.
Layout tested in isolated Chromium at 320px, 375px and 392px widths.

To activate an unpacked extension update, reload SuperAgent Delegate from
chrome://extensions in each Chrome profile and reopen the popup. This can
briefly reconnect Delegate; it never needs uninstalling or deleting pairing.
Do not interrupt an in-flight CDP operation solely to refresh appearance.

### Visual CDP tab indicators (v1.9.3)

When SuperAgent attaches its own debugger to a normal Chrome tab, the tab
title gains a visible **🔴 CDP ·** prefix and the Delegate extension icon
shows a per-tab CDP badge. Only the exact attached tab is marked.
Original tab titles are restored on detach, and the marker has a two-minute
safety expiry if the debugger is lost unexpectedly. The existing Delegate
heartbeat refreshes the indicator while the debugger is still attached.
Page navigation and single-page-app title updates retain the marker.

A marker is informational, **not** permission to control a tab. Chrome
debugger ownership and agent-session authorization remain unchanged; protected
Chrome pages are never marked. The extension does not request broader host
permissions or change favicons, focus, user inputs or page data.

For managed CDP (without Delegate extension), the marker is installed when
an agent explicitly claims a target and removed on release. The marker
expires with that owner's lease unless renewed via session heartbeat.

### Verification and packaging

```powershell
bun run verify:delegate
bun run release:delegate
```

The deterministic allowlisted ZIP and SHA-256 receipt are placed in
`build/releases/` (nine extension runtime files, no secrets).
Chrome Web Store publication and full real-browser send/stop production
acceptance are **separate steps**, not claimed by these checks.

## Two extensions and multiple Chrome profiles — v1.2.0

SuperAgent's original `chrome-extension/` and this
`chrome-extension-delegate/` are **different extensions**. They can be
installed together; the original browser extension, its tools and its
remote bridge are unchanged. This popup toggles **Delegate only**.

To use several Chrome profiles or separate Chrome installations on the
**same computer**, install Delegate in each. Click the Delegate icon in each
profile, turn **Koneksi Delegate** ON and give each profile a distinctive
name (for example, `Chrome Kerja` or `Chrome Personal`).
Every installation stores its own persistent random `clientId` in
`chrome.storage.local` and connects to the same
`ws://127.0.0.1:17341` backend. Turning one OFF closes only its socket;
it does **not** stop ChatGPT generation, close tabs, turn off the other
extension, or disable another Chrome profile. The ON/OFF setting survives
Chrome restarts. If there is an operation in flight, OFF returns
`DELEGATE_BUSY` until that operation finishes.

The popup lists connected Chrome profiles with a copyable **clientId**.
The four original Delegate tools remain the only tools; no extra
tool name is required. List all connected profiles by asking SuperAgent to
run:

```json
{"tool":"delegate.read_chat","args":{"connections":true}}
```

Choose a specific profile for subsequent operations:

```json
{"tool":"delegate.create_chat","args":{"clientId":"<copy actual ID from popup>"}}
{"tool":"delegate.read_chat","args":{"clientId":"<same ID>"}}
{"tool":"delegate.send_message","args":{"clientId":"<same ID>","message":"Hello"}}
```

**Safety:** When two or more Delegate connections are online, every
normal action without a `clientId` fails with
`DELEGATE_MULTIPLE_CLIENTS`; it never guesses a profile or broadcasts
a message. An offline or unknown `clientId` fails rather than falling
back to another Chrome profile. No timeout, disconnect, or profile change
automatically resends ChatGPT messages. Stop is explicit only.

Several Chrome **windows of the same profile** share one extension
service worker (one `clientId`). v1.8.1 preserves all
ChatGPT tabs; see **Multi-tab mode** above.
The popup lists open tab IDs and performs read-only content-script
probes, showing **siap** (ready) or **belum siap** without reloading.
When multiple tabs are open, use an exact
`{"clientId":"...","tabId":12345}`; requests without `tabId` return
`CHATGPT_MULTIPLE_TABS` rather than arbitrarily choosing a tab.

After installing this version, **restart the rebuilt SuperAgent server**
to load the multi-client bridge, and reload this extension in
`chrome://extensions`. The backend and browser should be on the same
machine; loopback is never exposed to the network.

If `SUPERAGENT_DELEGATE_EXTENSION_ID` is configured, the bridge allows
only that extension ID. Multiple Chrome *profiles* using that same ID
are allowed. Different extension IDs cannot all connect while this
single-ID pin is enabled; on a trusted local machine, leave the
environment variable unset to allow multiple extension origins.
A future multi-ID allowlist would be preferable for high-trust production use.

## Setup

1. In Chrome, open `chrome://extensions`, enable Developer mode, and
   **Load unpacked** from `chrome-extension-delegate/`.
2. Sign in to `https://chatgpt.com/` in that Chrome profile. A tab does not
   need to remain open; Delegate opens one automatically on the first RPC.
3. Start or restart the rebuilt SuperAgent backend **before** testing the
   extension. A supported CLI or server startup creates the listener at
   `127.0.0.1:17341` (no need to call a delegate tool first). For a
   direct server launch, use `bun dist/cli.js --server 7888` from the
   SuperAgent workspace. Keep the process running. For a standalone CLI,
   start it normally with `bun dist/cli.js`.
4. In `chrome://extensions`, reload the unpacked Delegate extension after
   changing its files. The service worker reconnects automatically.
5. Open a **single-agent** T-Line or extension-chat session.
6. Run `list_tools({query:"delegate"})` and
   `describe_tool({names:["delegate.create_chat","delegate.read_chat","delegate.send_message","delegate.stop_generation"]})`.
7. Optional defense in depth: find this unpacked extension's ID on
   `chrome://extensions` and start the server with
   `SUPERAGENT_DELEGATE_EXTENSION_ID=<id>`; the bridge then rejects other
   extension origins.


## Status koneksi di ikon extension (v1.1.0)

Buka `chrome://extensions` lalu klik **Reload** pada *SuperAgent
Delegate* setelah memperbarui file. Pin extension di toolbar Chrome untuk
melihat badge dan klik ikonnya untuk membuka panel status.

- **ON** (hijau): WebSocket terhubung **dan** SuperAgent sudah membalas
  handshake `hello_ack`.
- **...** (biru): koneksi atau handshake sedang berlangsung.
- **OFF** (kuning): belum terhubung, sedang mencoba kembali dengan backoff.
- **OFF** (merah): status offline jika tidak ada koneksi/retry aktif.

Panel menampilkan alamat server, kapan terakhir terhubung, jumlah tab
`chatgpt.com` yang terdeteksi, jumlah permintaan aktif, dan keterangan
error saat putus. Panel memeriksa status sekitar setiap 1,5 detik saat
terbuka. Tombol **Sambungkan ulang** hanya membuka ulang koneksi
WebSocket ketika tidak sedang connected/connecting. Tidak pernah
menjalankan `delegate.send_message` maupun `delegate.stop_generation`.

**Catatan:** status ON membuktikan koneksi RPC ke SuperAgent, bukan
membuktikan bahwa pengguna sudah login ChatGPT atau bahwa semua selector
DOM masih kompatibel. Status tab ChatGPT hanya memeriksa keberadaan
tab, bukan autentikasi.

## Troubleshooting localhost connection refused

`net::ERR_CONNECTION_REFUSED` means no process was listening at the
browser machine's `127.0.0.1:17341` when Chrome tried connecting.
The extension cannot start SuperAgent or its WebSocket server by itself.
Run the backend first, and inspect it on the **same computer as Chrome**:

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17341 -State Listen
```

If nothing is listening, verify SuperAgent has been rebuilt/restarted
and check its startup warnings. If the backend is intentionally offline,
Chrome may still log occasional connection-refused errors. The service
worker uses backoff (1, 2, 4, 8, 16, then max 30 seconds) and a
30-second MV3 wake alarm. Those errors cannot be suppressed from the
browser network console; no user chat message will be resent.

**Important:** `127.0.0.1` belongs to the machine executing Chrome. If
Chrome is on another machine than the SuperAgent server, the two will
not connect using this loopback design; this extension does not expose
a network-accessible bridge. Do not bind port 17341 to a public interface.

For deployments where the Delegate listener should be disabled, set
`SUPERAGENT_DELEGATE_BRIDGE=0` before launching SuperAgent.
Only one process can own the fixed port. If multiple SuperAgent processes
race to bind it, their startup warnings report the conflict rather than
silently claiming connectivity.

## Behavior and boundaries

- The only site-specific content script runs on **chatgpt.com**.
- The bridge uses a fixed RPC allowlist. It never executes arbitrary JavaScript
  or accesses cookies, credentials, or non-ChatGPT tabs.
- **create_chat** returns `already_new_chat:true` without clicking on a verified empty homepage. On an existing chat, it waits for the composer, preserves unsent drafts, clicks New chat once and verifies the transition. Missing or loading tabs fail without pretending success.
- **read_chat** returns visible turn text, latest assistant response, and status.
- **send_message** clicks Send exactly once. After a timeout, network loss or
  unknown delivery it never resends; call read_chat before a new explicit send.
- **stop_generation** is only available by an explicit tool call. A timed-out,
  disconnected, or aborted request does not stop generation.
- No DOM reload recovery, scripting into page contexts, or modification of
  `chrome-extension/`.
- ChatGPT may change its DOM. The selectors should be maintained against the
  actual UI; selectors are heuristic and not a public API.
- Local origin restrictions are not cryptographic authentication. For shared
  machines, set the extension ID restriction and block untrusted local clients.
- Model providers may reject dotted tool names; test your selected provider
  before relying on native function calling.


## Verification

Run from the SuperAgent workspace root:

```powershell
bun --bun x tsc --noEmit
bun run verify:extension-js
bun --bun x vitest run tests/delegate.test.ts tests/delegateMultiClient.test.ts tests/delegateContent.test.ts tests/delegateStatus.test.ts tests/extensionChatToolFilter.test.ts
bun scripts/verify-delegate-discovery.ts
```

The discovery smoke script verifies all four delegate tools in single-agent
T-Line and Chrome-extension chat and confirms they are absent from
T-Line Master mode. The 12 existing Chrome-extension-only tools remain
filtered in T-Line. Tests do not open a browser or send a ChatGPT message.

A live end-to-end check requires a running Chrome instance with the
unpacked extension installed and a logged-in ChatGPT tab. DOM selector
compatibility cannot be claimed from simulated-DOM tests alone.

If the composer contains an unsent draft, delegate.send_message returns
CHATGPT_DRAFT_PRESENT instead of overwriting it.
