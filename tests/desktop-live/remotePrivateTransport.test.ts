import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createServer as tlsServer, type TLSSocket } from "node:tls";
import { once } from "node:events";
import {
  RemotePrivateTransportBridge, REMOTE_PRIVATE_ALPN,
  REMOTE_PRIVATE_MAX_CONTROL_BYTES, computeRemotePrivateViewerProof,
  encodeRemotePrivateControl, type RemotePrivateViewerCredential,
} from "../../src/core/desktopUi/remotePrivateTransport.js";
import { REMOTE_MAX_FRAME_BYTES } from "../../src/core/desktopUi/remoteViewerFrames.js";
import type { RemoteHostIntent } from "../../src/core/desktopUi/remoteSessionPolicy.js";

const origin = "https://viewer.private.test";
const intent: RemoteHostIntent = {
  hostId: "host-native-01",
  viewerId: "viewer-mtls-01",
  expectedOrigin: origin,
  window: {
    pid: 3210, nativeId: "hwnd:0x7744", title: "Approved single window",
    application: "Example editor",
    bounds: { x: 12, y: 20, width: 1200, height: 700 },
  },
};

let key: Buffer;
let cert: Buffer;
let fingerprint: string;
let fixtureDir: string;

beforeAll(() => {
  // Test-only self-signed fixture, generated outside the checkout and deleted in afterAll.
  fixtureDir = mkdtempSync(join(tmpdir(), "desktop-live-mtls-test-"));
  // Windows Git bundles OpenSSL even when missing from the ordinary PATH.
  const gitOpenSsl = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const openssl = process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl";
  const result = spawnSync(openssl, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(fixtureDir, "peer.key"),
    "-out", join(fixtureDir, "peer.crt"),
    "-days", "1", "-subj", "/CN=viewer.private.test",
    "-addext", "subjectAltName=DNS:viewer.private.test",
    "-addext", "extendedKeyUsage=serverAuth,clientAuth",
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (result.status !== 0) throw Error("OpenSSL fixture generation unavailable: " + (result.error?.message || result.status));
  key = readFileSync(join(fixtureDir, "peer.key"));
  cert = readFileSync(join(fixtureDir, "peer.crt"));
  fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
});
afterAll(() => {
  key?.fill(0);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

function makeBridge(overrides: { pinnedViewerCertSha256?: string; nativeApproval?: boolean } = {}) {
  return new RemotePrivateTransportBridge({
    expectedOrigin: origin, viewerId: intent.viewerId,
    pinnedViewerCertSha256: overrides.pinnedViewerCertSha256 ?? fingerprint,
    verifyNativeApproval: async proof =>
      overrides.nativeApproval !== false &&
      proof.proof === "trusted-native-proof" && proof.window.nativeId === intent.window.nativeId,
  });
}
async function approved(bridge: RemotePrivateTransportBridge) {
  const request = bridge.beginNativeApproval(intent);
  return bridge.approveNative({ nonce: request.nonce, proof: "trusted-native-proof" });
}

class WireReader {
  private buffer = Buffer.alloc(0);
  private pending: Buffer[] = [];
  private waiting: Array<(value: Buffer) => void> = [];
  private closed = false;
  constructor(private readonly socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > REMOTE_MAX_FRAME_BYTES + 4096) {
        throw Error("Test received an unexpectedly large frame.");
      }
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (length > REMOTE_MAX_FRAME_BYTES + 64) throw Error("Invalid frame length.");
        if (this.buffer.length < length + 4) return;
        const frame = Buffer.from(this.buffer.subarray(4, 4 + length));
        this.buffer = this.buffer.subarray(4 + length);
        const waiter = this.waiting.shift();
        if (waiter) waiter(frame);
        else this.pending.push(frame);
      }
    });
    socket.once("close", () => { this.closed = true; });
  }
  next(): Promise<Buffer> {
    if (this.pending.length) return Promise.resolve(this.pending.shift()!);
    if (this.closed) return Promise.reject(new Error("Socket already closed"));
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out reading TLS wire")), 2_000);
      timer.unref?.();
      this.waiting.push(value => { clearTimeout(timer); resolve(value); });
    });
  }
  async json(): Promise<Record<string, unknown>> {
    return JSON.parse((await this.next()).toString("utf8")) as Record<string, unknown>;
  }
}
interface ServerHarness {
  server: ReturnType<typeof tlsServer>;
  port: number;
  acceptedSocket(): TLSSocket | null;
  close(): Promise<void>;
}
async function listen(bridge: RemotePrivateTransportBridge): Promise<ServerHarness> {
  let liveSocket: TLSSocket | null = null;
  const server = tlsServer({
    key, cert, ca: cert, requestCert: true, rejectUnauthorized: true,
    minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    ALPNProtocols: [REMOTE_PRIVATE_ALPN],
  }, socket => {
    try { bridge.attachPrivateTlsSocket(socket); liveSocket = socket; }
    catch { socket.destroy(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("Test listener did not bind IPv4.");
  return {
    server, port: addr.port,
    acceptedSocket: () => liveSocket,
    close: async () => {
      bridge.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
async function connectViewer(port: number, opts: { alpn?: string; peerCert?: Buffer; peerKey?: Buffer } = {}) {
  const socket = tlsConnect({
    host: "127.0.0.1", port, cert: opts.peerCert ?? cert,
    key: opts.peerKey ?? key, ca: cert, rejectUnauthorized: true,
    servername: "viewer.private.test",
    ALPNProtocols: [opts.alpn ?? REMOTE_PRIVATE_ALPN],
    minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
  });
  await once(socket, "secureConnect");
  return { socket, reader: new WireReader(socket) };
}
function send(socket: TLSSocket, message: Record<string, unknown>) {
  socket.write(encodeRemotePrivateControl(message));
}
async function attached(port: number, credential: RemotePrivateViewerCredential) {
  const { socket, reader } = await connectViewer(port);
  const hello = await reader.json();
  expect(hello).toEqual({
    version: 1, type: "challenge", connectionId: expect.stringMatching(/^tls-[a-f0-9]{40}$/),
  });
  send(socket, {
    version: 1, type: "attach", sessionId: credential.sessionId,
    proof: computeRemotePrivateViewerProof(credential, hello.connectionId as string),
  });
  expect(await reader.json()).toMatchObject({ version: 1, type: "ready" });
  return { socket, reader, connectionId: hello.connectionId as string };
}
async function expectClosed(socket: TLSSocket, timeoutMs = 1_000) {
  if (socket.destroyed) return;
  await Promise.race([
    once(socket, "close"),
    new Promise((_resolve, reject) => setTimeout(() => reject(Error("Socket was not closed")), timeoutMs)),
  ]);
}

describe("private Desktop Live socket adapter (actual mTLS loopback)", () => {
  it("has no default listener and requires native approval before a socket", async () => {
    const bridge = makeBridge();
    expect("listen" in bridge).toBe(false);
    expect(() => bridge.beginNativeApproval({ ...intent, viewerId: "spoofed-viewer" })).toThrow();
    await expect(bridge.approveNative({ nonce: "0".repeat(64), proof: "forged-native-proof" })).rejects.toThrow();
    const badBridge = makeBridge({ nativeApproval: false });
    const challenge = badBridge.beginNativeApproval(intent);
    await expect(badBridge.approveNative({ nonce: challenge.nonce, proof: "trusted-native-proof" })).rejects.toThrow();
    bridge.close();
    badBridge.close();
  });

  it("exchanges a separately signed session proof, sends one exact-window JPEG and accepts ACK", async () => {
    const bridge = makeBridge();
    const host = await approved(bridge);
    const server = await listen(bridge);
    try {
      expect(() => bridge.withApprovedViewerAuthorization(() => true)).toThrow();
      const { socket, reader } = await attached(server.port, host.viewerCredential);
      expect(bridge.withApprovedViewerAuthorization(auth => {
        expect(bridge.sessions.authorizeViewer(auth).window).toEqual(intent.window);
        return "native-host-only";
      })).toBe("native-host-only");
      const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
      const capturedAtMs = Date.now();
      expect(bridge.offerVerifiedFrame({
        jpeg, width: 1200, height: 700,
        capturedAtMs, window: intent.window,
      })).toEqual({ sequence: 1 });
      const packet = await reader.next();
      expect(packet.length).toBe(18 + jpeg.length);
      expect(packet[0]).toBe(1);
      expect(packet[1]).toBe(1);
      expect(packet.readUInt32BE(2)).toBe(1);
      expect(packet.readUInt16BE(6)).toBe(1200);
      expect(packet.readUInt16BE(8)).toBe(700);
      expect(Number(packet.readBigUInt64BE(10))).toBe(capturedAtMs);
      expect(packet.subarray(18)).toEqual(Buffer.from(jpeg));
      send(socket, { version: 1, type: "ack", sequence: 1 });
      await new Promise(resolve => setTimeout(resolve, 280));
      expect(() => bridge.offerVerifiedFrame({
        jpeg, width: 1200, height: 700,
        capturedAtMs, window: intent.window,
      })).toThrow(); // Captures must advance; no still replay.
      await expectClosed(socket);
      expect(() => bridge.offerVerifiedFrame({
        jpeg, width: 1200, height: 700,
        capturedAtMs: Date.now(), window: intent.window,
      })).toThrow();
    } finally { await server.close(); }
  });

  it("fails closed on queued TLS bytes rather than buffering a JPEG behind a slow viewer", async () => {
    const bridge = makeBridge();
    const host = await approved(bridge);
    const server = await listen(bridge);
    try {
      const { socket } = await attached(server.port, host.viewerCredential);
      const serverSocket = server.acceptedSocket();
      expect(serverSocket).not.toBeNull();
      serverSocket!.cork();
      serverSocket!.write(Buffer.from("queued-test-only-control"));
      expect(serverSocket!.writableLength).toBeGreaterThan(0);
      expect(() => bridge.offerVerifiedFrame({
        jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 1200, height: 700, capturedAtMs: Date.now(), window: intent.window,
      })).toThrow();
      await expectClosed(socket);
    } finally { await server.close(); }
  });

  it("rejects replay of a revoked session on a new connection", async () => {
    const bridge = makeBridge();
    const first = await approved(bridge);
    const server = await listen(bridge);
    try {
      const live = await attached(server.port, first.viewerCredential);
      bridge.revokeByHost({ sessionId: first.sessionId, hostToken: first.hostToken });
      await expectClosed(live.socket);
      const fresh = await approved(bridge);
      expect(fresh.sessionId).not.toBe(first.sessionId);
      const { socket, reader } = await connectViewer(server.port);
      const hello = await reader.json();
      send(socket, {
        version: 1, type: "attach", sessionId: first.sessionId,
        proof: computeRemotePrivateViewerProof(first.viewerCredential, hello.connectionId as string),
      });
      await expectClosed(socket);
      const replacement = await approved(bridge); // failed proof burned fresh session
      expect(replacement.sessionId).not.toBe(fresh.sessionId);
      const ready = await attached(server.port, replacement.viewerCredential);
      bridge.humanTakeover();
      await expectClosed(ready.socket);
    } finally { await server.close(); }
  });

  it("denies a certificate pin mismatch despite a successful TLS handshake", async () => {
    const bridge = makeBridge({ pinnedViewerCertSha256: "a".repeat(64) });
    await approved(bridge);
    const server = await listen(bridge);
    try {
      const { socket } = await connectViewer(server.port);
      await expectClosed(socket);
    } finally { await server.close(); }
  });

  it("rejects a mismatched ALPN before any challenge is delivered", async () => {
    const bridge = makeBridge();
    await approved(bridge);
    const server = await listen(bridge);
    try {
      await expect(connectViewer(server.port, { alpn: "http/1.1" }))
        .rejects.toThrow(/APPLICATION_PROTOCOL|application protocol/i);
    } finally { await server.close(); }
  });

  it("rejects forged proof, extra forwarded metadata and replayed credentials", async () => {
    for (const change of ["proof", "forwarded", "session"]) {
      const bridge = makeBridge();
      const host = await approved(bridge);
      const server = await listen(bridge);
      try {
        const { socket, reader } = await connectViewer(server.port);
        const hello = await reader.json();
        const payload: Record<string, unknown> = {
          version: 1, type: "attach", sessionId: host.sessionId,
          proof: computeRemotePrivateViewerProof(host.viewerCredential, hello.connectionId as string),
        };
        if (change === "proof") payload.proof = "a".repeat(64);
        if (change === "forwarded") payload.forwardedFor = "127.0.0.1";
        if (change === "session") payload.sessionId = "b".repeat(64);
        send(socket, payload);
        await expectClosed(socket);
        const other = await connectViewer(server.port);
        await expectClosed(other.socket);
      } finally { await server.close(); }
    }
  });

  it("denies pointer/keyboard/clipboard and oversized inbound requests, closing the approved session", async () => {
    for (const bad of [
      { version: 1, type: "pointer", x: 0.1, y: 0.1 },
      { version: 1, type: "keyboard", key: "A" },
      { version: 1, type: "clipboard", data: "secret" },
      { version: 1, type: "ack", sequence: 999 },
    ]) {
      const bridge = makeBridge();
      const host = await approved(bridge);
      const server = await listen(bridge);
      try {
        const { socket } = await attached(server.port, host.viewerCredential);
        send(socket, bad);
        await expectClosed(socket);
      } finally { await server.close(); }
    }
    const bridge = makeBridge();
    const host = await approved(bridge);
    const server = await listen(bridge);
    try {
      const { socket } = await attached(server.port, host.viewerCredential);
      const oversize = Buffer.alloc(4);
      oversize.writeUInt32BE(REMOTE_PRIVATE_MAX_CONTROL_BYTES + 1, 0);
      socket.write(oversize);
      await expectClosed(socket);
    } finally { await server.close(); }
  });

  it("permits only one socket and revokes on host revoke, disconnect and human takeover", async () => {
    const bridge = makeBridge();
    const host = await approved(bridge);
    const server = await listen(bridge);
    try {
      const main = await attached(server.port, host.viewerCredential);
      const duplicate = await connectViewer(server.port);
      await expectClosed(duplicate.socket);
      expect(main.socket.destroyed).toBe(false);
      expect(() => bridge.revokeByHost({ sessionId: host.sessionId,
        hostToken: host.viewerCredential.viewerKey })).toThrow();
      bridge.revokeByHost({ sessionId: host.sessionId, hostToken: host.hostToken });
      await expectClosed(main.socket);
      const fresh = await approved(bridge);
      expect(fresh.viewerCredential.viewerKey).not.toBe(host.viewerCredential.viewerKey);
      const active = await attached(server.port, fresh.viewerCredential);
      bridge.humanTakeover();
      await expectClosed(active.socket);
      const next = await approved(bridge);
      const dropped = await attached(server.port, next.viewerCredential);
      dropped.socket.destroy();
      await expectClosed(dropped.socket);
      await vi.waitFor(() => expect(() => bridge.offerVerifiedFrame({
        jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 1200, height: 700, capturedAtMs: Date.now(), window: intent.window,
      })).toThrow(), { interval: 20, timeout: 1_000 });
    } finally { await server.close(); }
  });

  it("enforces the exact window and oversize JPEG with immediate revocation", async () => {
    for (const frame of [
      { jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), window: { ...intent.window, pid: 45 } },
      { jpeg: new Uint8Array(REMOTE_MAX_FRAME_BYTES + 1), window: intent.window },
    ]) {
      const bridge = makeBridge();
      const host = await approved(bridge);
      const server = await listen(bridge);
      try {
        const { socket } = await attached(server.port, host.viewerCredential);
        expect(() => bridge.offerVerifiedFrame({
          ...frame, width: 1200, height: 700, capturedAtMs: Date.now(),
        })).toThrow();
        await expectClosed(socket);
      } finally { await server.close(); }
    }
  });

  it("revokes an unacknowledged frame after the bounded ACK lease", async () => {
    const bridge = makeBridge();
    const host = await approved(bridge);
    const server = await listen(bridge);
    try {
      const { socket, reader } = await attached(server.port, host.viewerCredential);
      bridge.offerVerifiedFrame({
        jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 1200, height: 700, capturedAtMs: Date.now(), window: intent.window,
      });
      await reader.next();
      await expectClosed(socket, 4_500);
    } finally { await server.close(); }
  }, 7_000);
});
