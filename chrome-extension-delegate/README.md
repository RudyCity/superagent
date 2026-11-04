# SuperAgent Delegate — isolated ChatGPT extension

## Direct MCP tools — backend integration (2026-11-04)

The **SuperAgent MCP connector** exposes these direct tools, independently
from agent-internal `delegate.*` names:

- `superagent_delegate_read_chat({connections:true})`: list connected Chrome profiles.
- `superagent_delegate_read_chat({clientId, tabId?})`: read a ChatGPT tab through its DOM.
- `superagent_delegate_create_chat({clientId?, tabId?})`: one explicit New chat action.
- `superagent_delegate_send_message({message, clientId?, tabId?})`: send exactly once.
- `superagent_delegate_stop_generation({clientId?, tabId?})`: Stop only on request.

The connector does **not** use OpenAI API keys or ChatGPT internal endpoints:
MCP → authenticated local SuperAgent HTTP `127.0.0.1:7888` →
existing host-owned Delegate WebSocket `127.0.0.1:17341` →
Chrome Extension → ChatGPT DOM.

Read is available with MCP read scope. Create, send and stop require an
authorized MCP write scope plus local YOLO enablement. They are hidden
in read-only MCP catalogs. Gateway mode advertises authorized Delegate
tools directly rather than requiring a natural-language discovery query.
An R1 safe-owner restricted catalog does not gain browser access.

**Activation:** Rebuild and restart the Core host before the new
`/api/delegate/mcp-dispatch` route is present; separately restart/reconnect
the MCP server/tunnel and refresh the ChatGPT connector's tool catalog.
**Important:** In default fileless pairing mode, a Core restart rotates
the Delegate secret and **requires the extension to pair again**. Avoid
restarting the live host without arranging re-pairing.

No MCP operation automatically reloads a ChatGPT page, sends again after a
timeout, or logs message content. The activity journal stores redacted
metadata only; the requested chat text is returned only to the authenticated
caller.

## Automatic one-safe-tab mode — v1.5.0

After loading the extension, a single Chrome profile automatically keeps
**one verified ChatGPT tab**. When two or more `https://chatgpt.com/*`
tabs are present, the service worker chooses a deterministic primary
(favoring an actively generating chat, unsent draft, pinned tab, then
the currently active tab) and closes **only** redundant tabs that passed
a fresh content-script safety inspection. This includes distinct completed
ChatGPT conversations; completed chats remain in ChatGPT history.

The extension listens for tab creation, page completion, activation and
removal, and checks existing tabs at startup. Cleanup is sequential and
double-checks current URL, activation and DOM safety immediately before
closing. While a Delegate RPC is in flight or the extension is OFF, no
tabs are closed. It never reloads ChatGPT or sends/stops a chat to repair
tab counts.

**Exception, not silent data loss:** A generating chat, unsent draft,
pending attachment, open dialog, pinned/audible tab, incomplete page or
unavailable content script is protected. If any tab is still loading
or unverified, cleanup is deferred for that group until it is safe
to choose the primary. Up to eight short DOM-readiness retries and a
30-second alarm fallback handle pages whose composer appears late. When several tabs are protected,
more than one may remain open. The background status reports
`tabPolicy.remainingTabs`, `primaryTabId`, `lastClosedTabIds`,
`lastClosedAt` and `protectedTabs`. The popup shows recent safe closures
for five minutes, even after later one-tab checks. If multiple tabs remain, existing Delegate tools still
require an explicit `tabId` and never guess.

Only tabs inside **this Chrome profile** are managed. Separate Chrome
profiles and incognito contexts are isolated; the extension never closes
other extensions or browser profiles.


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

### Verification and packaging

```powershell
bun run verify:delegate
bun run release:delegate
```

The deterministic allowlisted ZIP and SHA-256 receipt are placed in
`build/releases/` (only seven extension runtime files, no secrets).
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
service worker (one `clientId`). v1.5.0 automatically consolidates
ChatGPT tabs when safe; see **Automatic one-safe-tab mode** above.
The popup still lists surviving tab IDs and performs read-only content-script
probes, showing **siap** (ready) or **belum siap** without reloading.
When multiple protected tabs remain, use an exact
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
2. Keep a logged-in `https://chatgpt.com/` tab open in the same Chrome profile.
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
