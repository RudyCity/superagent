# Desktop Live — Private viewer-machine browser UI

This is a **manual, view-only** developer/operator tool. Run it on the **remote
viewer's machine**, not the remotely viewed host. It serves **only**
`http://127.0.0.1:<ephemeral-port>`. It does not auto-launch a browser, manage
a Windows service, install a tunnel, grant remote permission, or expose HTTP
on the approved host.

## Prerequisites and provisioning

1. On the host, an **attended native human** must approve the **exact window /
   HWND** through the existing remote policy. A viewer browser cannot grant or
   expand that scope. Monitor fallback, clipboard, keyboard, mouse, file transfer
   and recording are not part of this UI.
2. Out of band on the viewer machine, securely provision a single-use
   `RemotePrivateViewerCredential`, the expected server TLS DER SHA-256 pin,
   the mTLS client cert/key, and CA. They must correspond to the host's existing
   private TLS listener, not to a Cloudflare/Public HTTP tunnel or MCP bearer.
3. The destination must be a numeric RFC1918, loopback or supported private ULA
   IP. The existing Node SDK independently enforces peer address, pinned server
   and client certificates, TLS 1.3, ALPN, server hostname, handshake challenge,
   signed grant and frame sequence. Grants expire within 120 seconds.
4. Protect the viewer-side configuration with a user-only OS ACL/permissions.
   Never put the key, credential, or access secret in command-line arguments,
   an environment variable, HTTP request, chat, URL, browser storage or logs.
   Do not provision these files on a shared drive.

### Viewer-side input pipe

Prepare a **private** JSON document on the viewer machine using separately
issued values. The following is a **shape**, not valid credentials:

```json
{
  "privateAddress": "192.168.1.50",
  "port": 39421,
  "pinnedServerCertSha256": "<64 lowercase hex characters>",
  "credential": {
    "sessionId": "<64 lowercase hex characters>",
    "viewerChallenge": "<64 lowercase hex characters>",
    "viewerKey": "<64 lowercase hex characters>",
    "hostId": "<issued host ID>",
    "viewerId": "<issued viewer ID>",
    "expectedOrigin": "https://approved-private-host.example",
    "pinnedViewerCertSha256": "<64 lowercase hex characters>",
    "expiresAt": 1794646000000
  },
  "clientCertPem": "-----BEGIN CERTIFICATE-----\\n...\\n-----END CERTIFICATE-----",
  "clientKeyPem": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----",
  "trustedCaPem": "-----BEGIN CERTIFICATE-----\\n...\\n-----END CERTIFICATE-----"
}
```

`expiresAt` must be the **currently issued** Unix epoch in milliseconds
within the next two minutes, not the illustrative value above. Supply the
complete PEM strings with JSON-escaped newlines.

From the checkout on the viewer machine, use PowerShell:

```powershell
Get-Content -Raw -Encoding UTF8 -LiteralPath "$env:USERPROFILE\private-viewer-config.json" |
  bun scripts/desktop-live-private-viewer.ts --config-stdin
```

Or any equivalent **local private pipe** on Linux/macOS:

```sh
bun scripts/desktop-live-private-viewer.ts --config-stdin < "$HOME/.config/superagent/private-viewer.json"
```

There are **no secret CLI flags** and no startup connection to the host.
The CLI displays a loopback URL and a fresh random **local browser access
secret in the operator terminal only**. Manually open that URL on the same
viewer machine, enter the access secret, then explicitly select **Start view**
after native approval has been verified. Do not paste either the grant or
secret into a browser URL. The access secret is not the native viewer grant.

## Browser behavior

- Local session cookie: derived from a process-random 256-bit browser secret;
  `HttpOnly; SameSite=Strict; Path=/`; short lease and no persistent storage.
  The secret is entered with POST only and is never embedded in page source,
  JavaScript, query strings or other URLs.
- HTTP: exact Host `127.0.0.1:<port>`, same-origin POST Origin, strict Referer
  and Fetch Metadata, no-store, CSP without inline script or unsafe-eval,
  `frame-ancestors 'none'`, anti-MIME sniffing, and no external asset loads.
  `Referrer-Policy: same-origin` deliberately allows Chrome's same-origin
  unlock form to send a valid Origin; no credentials are ever in paths.
- Viewing: one outstanding long-poll frame request, monotonic sequence, MIME
  signature, pixel/dimension bounds, SHA-256 header checked in browser before
  decoding, current image only, and fresh/stale overlays. The source SDK emits
  JPEG; the local rendering sink additionally supports verified PNG. It holds
  at most one queued frame plus one in-flight transfer, never a recording.
- Session closure: **Stop session** revokes the local viewer immediately.
  Browser navigation aborts its frame request and attempts an explicit stop.
  Disconnect, invalid frame, expired grant, missing mTLS approval or peer
  rejection all fail closed without automatic reconnection. The native SDK
  owns the authoritative host approval and disconnection behavior.
- Terminal **Ctrl+C** closes the loopback listener and zeroizes PEM Buffer
  copies. Secrets in immutable JavaScript strings cannot be guaranteed to be
  scrubbed from process memory; the entire viewer process should be terminated
  after use.

## Verification boundaries

```sh
bun --bun x vitest run tests/desktop-live/remotePrivateViewerLocalUi.test.ts tests/desktop-live/remotePrivateViewerLocalUiBrowser.test.ts --maxWorkers=1
bun --bun x vitest run tests/desktop-live/remotePrivateViewerClient.test.ts tests/desktop-live/remotePrivateTransport.test.ts --maxWorkers=1
bun --bun x tsc --noEmit
```

The browser test uses a **fresh headless Chrome** instance only if the standard
Windows Chrome binary already exists; it does not touch the user's active
Chrome profile. All HTTP tests use an actual ephemeral `127.0.0.1` listener
and injected synthetic approved-frame data. These tests do **not** claim a
real remote host was connected, or that a deployed native host is approved.
