# Desktop Live — private transport adapter (Task A)

**Status:** Implemented and loopback-tested; not deployed, production-certified, or wired to native capture/UI. The adapter is **view-only** and never creates a listener, HTTP/MCP route, public tunnel, capture worker, or input channel.

## Authentication and trusted host flow

1. A private native IPC (never a Core HTTP bearer) supplies a precisely pinned window to RemotePrivateTransportBridge.beginNativeApproval(). The independent native verifier must validate fresh attended human approval. Only the trusted host may call approveNative(), which returns a host token and a distinct per-session 256-bit viewer credential.
2. Deliver the viewer credential through a separately authenticated PRIVATE channel. Never serialize it to a browser, public tunnel, API, MCP, cookie, logs, or screen recording.
3. The host application separately creates an mTLS **TLS 1.3** listener on an authorized private interface with OS firewall protection. Configure requestCert=true, rejectUnauthorized=true, CA trust, and ALPNProtocols=[REMOTE_PRIVATE_ALPN]. In the secureConnection callback, pass the actual incoming TLSSocket to attachPrivateTlsSocket(). There is no listener by default.
4. The bridge checks server-side socket identity, authorized TLS peer, expected ALPN, expected SNI matching configured HTTPS origin, private local/peer addresses, and the configured SHA-256 pin of the viewer's DER certificate. Public or forwarded HTTP headers are never accepted as proof. A private IP alone cannot prove the absence of local proxies; native integration must prohibit any OS-level tunnel or proxy attachment and preserve direct socket ownership.
5. On socket accept, host sends a fresh 160-bit connectionId. Viewer computes computeRemotePrivateViewerProof(viewerCredential, connectionId). HMAC-SHA256 covers host/viewer IDs, session ID, viewer challenge, expected origin, pinned peer certificate hash, and exact connection ID. Challenge is single-use; 30-second viewer challenge and 120-second session lease from RemoteLiveSessionPolicy remain enforced.
6. Once attached, the only inbound operation is a strictly shaped ACK. Unexpected fields, input/control messages, wrong sequence, replay, invalid proof, forged certificate, stalled handshake, missing ACK, and changed exact-window frame revoke the session and immediately destroy the socket.

## Wire protocol

Every message starts with an unsigned 4-byte big-endian length. Host challenge is JSON with version=1, type=challenge, connectionId. Viewer replies with version=1, type=attach, sessionId and proof. After verification, host replies with version=1, type=ready, expiresAt. Host never sends CSRF or host token to the viewer.

A JPEG frame has an 18-byte binary payload header: version uint8=1 at offset 0, frame type uint8=1 at offset 1, sequence uint32BE at offset 2, width uint16BE at 6, height uint16BE at 8, capturedAtMs uint64BE at 10, then JPEG bytes at offset 18. The existing frame gate limits frame bytes to 512 KiB, dimension/age, exact approved window, rate and ACK order. Viewer ACK is JSON with version=1, type=ack, sequence. ACK envelope limit is 96 bytes. Pre-auth control limit is 512 bytes.

There is **no application-level frame queue**. A frame is written directly only with writableLength=0 and only one unacknowledged frame. Node TLS can transiently buffer its own in-flight encrypted record, so zero kernel/TLS buffering is not claimed. On backpressure write(false) the socket is destroyed without retry. Missing ACK independently triggers revocation after 3 seconds.

## Native integration contract and remaining gates

The native supervisor must call humanTakeover() on an actual trusted human takeover, revokeByHost() on owner revocation, and close() on shutdown. RemoteVerifiedJpegFrame must originate exclusively from the separately verified native capture/encoder of the **same** pinned window. No monitor fallback. No UI toggle or code in this adapter grants native consent, screen capture or automatic remote input.

Never connect this adapter to Core HTTP, an MCP bearer, a browser-facing WebSocket, a shared named/quick Cloudflare tunnel, or a public listener. Real installed-host verification, certificate provisioning, OS firewall/socket ownership, Wayland portal consent and R0-R7 production gates are separate and **not satisfied by loopback tests**.

Focused checks:

- bun --bun x vitest run tests/desktop-live/remotePrivateTransport.test.ts --maxWorkers=1
- bun --bun x tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --esModuleInterop src/core/desktopUi/remotePrivateTransport.ts

The loopback test creates an ephemeral OpenSSL self-signed test key in the OS temporary directory and deletes it afterward. This key is never a production identity. Workspace-wide TypeScript failures in concurrently owned files must be reported, not fixed outside Task A.
