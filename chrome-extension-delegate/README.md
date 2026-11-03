# SuperAgent Delegate — isolated ChatGPT extension

This extension is entirely separate from `chrome-extension/`. Its runtime consists of `manifest.json`, `background.js`, `content.js`, and popup files; the README documents installation and security.

## Production deployment and pairing — v1.3.0

**Supported deployment:** one local SuperAgent agent-host process with a
private loopback WebSocket listener on `127.0.0.1:17341`; multiple Chrome
profiles may connect to that single host. This is **not** a public
Internet-facing or multi-worker broker.

Production mode refuses to start the Delegate listener without a random
pairing key. Run these steps on the **same Windows user account as
SuperAgent** (never commit, email, or paste the key into an AI conversation):

```powershell
bun run build
bun scripts/delegate-auth.mjs init
bun scripts/delegate-auth.mjs status
# Prints the secret ONLY when the operator deliberately needs to pair a profile:
bun scripts/delegate-auth.mjs show

# Restart the single SuperAgent agent host with this environment:
$env:NODE_ENV = "production"
$env:SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE = Join-Path $HOME ".superagent-r\delegate-auth-token"
bun dist/cli.js --server 7888
```

`init` creates `~/.superagent-r/delegate-auth-token` with a random
256-bit key using exclusive-create; it never replaces an existing key.
On POSIX the file must have mode 0600. On Windows protect this user
profile folder with OS account permissions and avoid sharing the key.
The environment variable `SUPERAGENT_DELEGATE_AUTH_TOKEN` is also
accepted, but environment values may be exposed to process diagnostics;
the private file is preferable.

Open each Chrome profile, reload the unpacked Delegate extension,
open its popup, and paste the same secret into **Kunci pairing produksi**
then **Simpan**. The secret is stored only in that Chrome profile's
extension-local storage, with content-script access disabled via
`TRUSTED_CONTEXTS`; it is not included in status responses or logs.
Reconnection never resends a chat message. For a release rollback, switch
the server and extension back to a previously verified matching pair,
not to an unauthenticated production bridge.

A second or copied Chrome installation with the **same active clientId**
is rejected rather than evicting the first. Maximum eight authenticated
Delegate profiles and 2 MB incoming RPC frames are supported per bridge.
If `SUPERAGENT_DELEGATE_EXTENSION_ID` is set, the supplied Chrome extension
origin must match it as an extra restriction. Origin headers alone are
not authentication.

To activate an already-open ChatGPT tab whose popup says **belum siap**,
click **Aktifkan** in its tab row. This requires the `scripting`
permission and inserts only the packaged `content.js` on a verified
`https://chatgpt.com/*` tab. It never navigates, reloads, runs arbitrary
scripts, or submits any message. No repair is attempted automatically
on a mutating RPC.

```powershell
bun run verify:delegate
bun run release:delegate
```

The release script writes a deterministic, allowlisted ZIP and a SHA-256
receipt to `build/releases/`. Only six extension runtime files go into
the ZIP, never workspace files, secrets or Chrome user data. The ZIP
is an unpacked/testing artifact; **Chrome Web Store publication is a
separate distribution process and has not been performed.**

**Acceptance limitation:** full production authorization requires a
real Chrome end-to-end test of `send_message` and `stop_generation`,
verification of existing-chat-to-new-chat, and explicit validation of any
supervised multi-process runtime. Unit tests, packaging and an ON badge
are not sufficient proof.

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
service worker (one `clientId`). If that profile has several ChatGPT
tabs, the tool requires an explicit `tabId`. The Delegate popup lists those tab IDs and performs read-only content-script
probes, showing **siap** (ready) or **belum siap** for each tab. This
helps diagnose `CHATGPT_TAB_NOT_READY` without reloading the page or
submitting a message; e.g., use `{"clientId":"...","tabId":12345}`.
If more than one tab exists without `tabId`, the extension returns
`CHATGPT_MULTIPLE_TABS` without touching the page.

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
