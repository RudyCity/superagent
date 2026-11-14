# Desktop Live — private Node.js viewer client (Task F)

**Scope:** SDK only. The client is not a GUI, capture implementation, installed native host, deployed listener or production-certified remote-desktop product.

## Native integration contract

The approved host first obtains a one-time viewer credential from `RemotePrivateTransportBridge.approveNative()` after independent attended native human approval for an exact window. Deliver that credential **only** through a separately authenticated private channel to the trusted native viewer process. Provision a separate mTLS client certificate/key and CA trust through native secure storage; provision the SHA-256 DER server certificate pin independently. Do not expose any of these values through Core HTTP, MCP, a web browser, a Cloudflare named/quick tunnel, logging, clipboard or storage intended for session recording.

The caller must supply a **numeric private/loopback destination IP** and port. The client uses `credential.expectedOrigin` solely for the **HTTPS origin hostname/SNI/certificate-name check**, not for HTTP requests or DNS resolution. It checks authenticated TLS 1.3, the dedicated ALPN protocol, the server's exact DER certificate SHA-256 pin and a private local/remote socket address. The provisioned client certificate must match `credential.pinnedViewerCertSha256`. There is no proxy, browser WebSocket, fallback, discovery, public IP routing, automatic reconnect or resumable session.

Example (trusted native Node.js process only):

```ts
import { connectRemotePrivateViewerClient } from "./src/core/desktopUi/remotePrivateViewerClient.js";

// All values come from verified private/native provisioning, never HTTP/MCP.
const viewer = await connectRemotePrivateViewerClient({
  privateAddress: privateHostIp,
  port: privateHostPort,
  credential: oneTimeViewerCredential,
  pinnedServerCertSha256: pinnedServerDerSha256,
  clientCert: clientCertificatePem,
  clientKey: clientPrivateKeyPem,
  trustedCa: privateCaPem,
  async onFrame(frame) {
    // Trusted, in-memory display consumer. Await actual acceptance before ACK.
    await nativeExactWindowDisplay.consume(frame.jpeg, frame.width, frame.height);
  },
});
// On native owner revocation, shutdown, or human takeover:
viewer.close();
```

There is no built-in frame history, screenshot output, file path API or recording. The caller must also guarantee the trusted consumer does **not** cache, log, forward or record JPEG bytes. The supplied credential and TLS private-key material remain owned by the caller; restrict their lifetime, memory and transfer privileges. Do not persist them.

## Protocol and resource bounds

- TLS 1.3 mTLS; ALPN `superagent-desktop-live/1`; separate pinned server/client identities; TLS and 5-second handshake deadline.
- Host-issued 160-bit random per-socket connection ID; a connection-bound HMAC proof covers the one-time viewer credential and exact approved host/viewer/origin identities.
- Length-prefixed, at most 512-byte handshake control. The client expects exactly `challenge`, then `ready`; no external control messages are exposed.
- One in-flight JPEG, maximum 512 KiB; binary header contains sequence, dimensions and capture timestamp. Client rejects invalid JPEG SOI/EOI, replay/out-of-order sequence, stale timestamps, dimensions outside 1920×1920, more than 2,073,600 pixels, malformed framing and bundled frames.
- Socket reads pause during trusted asynchronous display consumption; no application frame queue. The consumer has a deadline below the server's 3-second ACK timeout. **Only successful consumption triggers the single permitted ACK.** Any callback rejection, timeout, invalid message, backpressure, socket loss, session lease expiry or native host revocation closes the connection without retries.
- The server's host-side policy enforces exact-window capture, issuance, consent, takeover and revocation. The viewer cannot infer the source window from JPEG alone; it trusts the separately verified native host and server bridge.

## Verification and remaining gates

```sh
bun --bun x vitest run tests/desktop-live/remotePrivateViewerClient.test.ts tests/desktop-live/remotePrivateTransport.test.ts --maxWorkers=1
bun --bun x tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --esModuleInterop src/core/desktopUi/remotePrivateViewerClient.ts
```

The tests use a real ephemeral OpenSSL CA, separately signed server and viewer certificates and `tls.createServer` bound only to `127.0.0.1`. Keys and fixture files are confined to an OS temporary directory and deleted after testing. These are **not** proof of real network isolation, installed GUI usability, private certificate provisioning, attended native approval, OS firewall enforcement or R0–R7 release readiness. Any installed integration must verify that no OS-level proxy/tunnel exposes the listener; numeric private IP validation alone cannot prove that.
