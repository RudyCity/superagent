import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer as tlsServer, type TLSSocket } from "node:tls";
import {
  REMOTE_PRIVATE_ALPN, RemotePrivateTransportBridge,
  encodeRemotePrivateControl, type RemotePrivateViewerCredential,
} from "../../src/core/desktopUi/remotePrivateTransport.js";
import {
  connectRemotePrivateViewerClient,
  type RemotePrivateViewerClientOptions,
  type RemotePrivateViewerFrame,
} from "../../src/core/desktopUi/remotePrivateViewerClient.js";
import type { RemoteHostIntent } from "../../src/core/desktopUi/remoteSessionPolicy.js";

const origin = "https://viewer.private.test";
const intent: RemoteHostIntent = {
  hostId: "host-native-01", viewerId: "viewer-mtls-01",
  expectedOrigin: origin,
  window: {
    pid: 3210, nativeId: "hwnd:0x7744", title: "Approved single window",
    application: "Example editor",
    bounds: { x: 12, y: 20, width: 1200, height: 700 },
  },
};
const disposableJpeg = Uint8Array.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
let dir = "";
let ca: Buffer;
let serverCert: Buffer;
let serverKey: Buffer;
let clientCert: Buffer;
let clientKey: Buffer;
let viewerPin = "";
let serverPin = "";

function openssl(...args: string[]) {
  // Git for Windows carries OpenSSL even when normal Windows PATH omits it.
  const gitOpenSsl = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const command = process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl";
  const result = spawnSync(command, args, {
    cwd: dir, windowsHide: true, encoding: "utf8", timeout: 20_000,
  });
  if (result.status !== 0) throw new Error("Test-only OpenSSL PKI generation failed: " +
    (result.error?.message || result.stderr || String(result.status)));
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "private-viewer-mtls-"));
  // An ephemeral test-only CA signs distinct server and client identities.
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Disposable Viewer Test CA");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
    "-out", "server.csr", "-subj", "/CN=viewer.private.test",
    "-addext", "subjectAltName=DNS:viewer.private.test");
  openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-days", "1", "-sha256", "-copy_extensions", "copy",
    "-out", "server.crt");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key",
    "-out", "client.csr", "-subj", "/CN=disposable-viewer");
  openssl("x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-days", "1", "-sha256", "-out", "client.crt");
  ca = readFileSync(join(dir, "ca.crt"));
  serverCert = readFileSync(join(dir, "server.crt"));
  serverKey = readFileSync(join(dir, "server.key"));
  clientCert = readFileSync(join(dir, "client.crt"));
  clientKey = readFileSync(join(dir, "client.key"));
  serverPin = createHash("sha256").update(new X509Certificate(serverCert).raw).digest("hex");
  viewerPin = createHash("sha256").update(new X509Certificate(clientCert).raw).digest("hex");
}, 30_000);
afterAll(() => {
  clientKey?.fill(0);
  serverKey?.fill(0);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function bridge() {
  return new RemotePrivateTransportBridge({
    expectedOrigin: origin, viewerId: intent.viewerId,
    pinnedViewerCertSha256: viewerPin,
    verifyNativeApproval: async proof =>
      proof.proof === "trusted-native-proof" && proof.window.nativeId === intent.window.nativeId,
  });
}
async function authorize(host: RemotePrivateTransportBridge) {
  const challenge = host.beginNativeApproval(intent);
  return host.approveNative({ nonce: challenge.nonce, proof: "trusted-native-proof" });
}
async function serve(host: RemotePrivateTransportBridge) {
  const server = tlsServer({
    key: serverKey, cert: serverCert, ca, requestCert: true,
    rejectUnauthorized: true, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    ALPNProtocols: [REMOTE_PRIVATE_ALPN],
  }, socket => {
    try { host.attachPrivateTlsSocket(socket); }
    catch { socket.destroy(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Not a TCP listener");
  return {
    port: address.port,
    close: async () => {
      host.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
function options(
  port: number, credential: RemotePrivateViewerCredential,
  onFrame: (frame: RemotePrivateViewerFrame) => Promise<void> | void = () => undefined,
): RemotePrivateViewerClientOptions {
  return {
    privateAddress: "127.0.0.1", port, credential, onFrame,
    pinnedServerCertSha256: serverPin, clientCert, clientKey, trustedCa: ca,
  };
}
function offer(host: RemotePrivateTransportBridge) {
  return host.offerVerifiedFrame({
    jpeg: disposableJpeg, width: 1200, height: 700,
    capturedAtMs: Date.now(), window: intent.window,
  });
}

describe("private viewer client (real mTLS 1.3 loopback, disposable CA)", () => {
  it("uses separate server/client certificates, challenge-bound proof and ACK after consumption", async () => {
    const host = bridge();
    const authorized = await authorize(host);
    const server = await serve(host);
    const seen: RemotePrivateViewerFrame[] = [];
    let release!: () => void;
    const consumerDone = new Promise<void>(resolve => { release = resolve; });
    let invocation = 0;
    const viewer = await connectRemotePrivateViewerClient(
      options(server.port, authorized.viewerCredential, async frame => {
        seen.push(frame);
        invocation++;
        if (invocation === 1) await consumerDone;
      }),
    );
    try {
      expect(viewer.isConnected).toBe(true);
      expect(offer(host)).toEqual({ sequence: 1 });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toMatchObject({ sequence: 1, width: 1200, height: 700 });
      expect(seen[0].jpeg).toEqual(disposableJpeg);
      await new Promise(resolve => setTimeout(resolve, 275));
      expect(() => offer(host)).toThrow(); // pending frame: ACK not sent yet
      expect(viewer.deliveredFrames).toBe(0);
      release();
      await vi.waitFor(() => expect(viewer.deliveredFrames).toBe(1));
      expect(offer(host)).toEqual({ sequence: 2 });
      await vi.waitFor(() => expect(viewer.deliveredFrames).toBe(2));
      expect(seen.map(f => f.sequence)).toEqual([1, 2]);
    } finally {
      release();
      viewer.close();
      await server.close();
    }
  }, 8_000);

  it("rejects viewer callback failure without ACK or recording/retry", async () => {
    const host = bridge();
    const authorized = await authorize(host);
    const server = await serve(host);
    const callback = vi.fn(() => { throw new Error("untrusted display failed"); });
    const viewer = await connectRemotePrivateViewerClient(
      options(server.port, authorized.viewerCredential, callback),
    );
    try {
      offer(host);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(viewer.isConnected).toBe(false));
      expect(viewer.deliveredFrames).toBe(0);
      expect(() => offer(host)).toThrow();
    } finally { viewer.close(); await server.close(); }
  });

  it("rejects public/DNS destinations, bad pins, expired credentials and mismatched client identity", async () => {
    const host = bridge();
    const authorized = await authorize(host);
    const server = await serve(host);
    try {
      const valid = options(server.port, authorized.viewerCredential);
      for (const bad of [
        { ...valid, privateAddress: "8.8.8.8" },
        { ...valid, privateAddress: "viewer.private.test" },
        { ...valid, privateAddress: "169.254.169.254" },
        { ...valid, clientCert: serverCert },
        { ...valid, credential: { ...valid.credential, expiresAt: Date.now() - 1 } },
      ]) await expect(connectRemotePrivateViewerClient(bad)).rejects.toThrow();

      await expect(connectRemotePrivateViewerClient({
        ...valid, pinnedServerCertSha256: "a".repeat(64),
      })).rejects.toThrow();
    } finally { await server.close(); }
  });

  it("invalid server frame dimensions or sequence revokes a real authenticated TLS socket", async () => {
    const host = bridge();
    const authorized = await authorize(host);
    const malicious = tlsServer({
      key: serverKey, cert: serverCert, ca, requestCert: true, rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      ALPNProtocols: [REMOTE_PRIVATE_ALPN],
    }, socket => {
      socket.write(encodeRemotePrivateControl({
        version: 1, type: "challenge", connectionId: "tls-" + "a".repeat(40),
      }));
      socket.once("data", () => {
        socket.write(encodeRemotePrivateControl({
          version: 1, type: "ready", expiresAt: authorized.viewerCredential.expiresAt,
        }));
        const raw = Buffer.alloc(4 + 18 + disposableJpeg.length);
        raw.writeUInt32BE(18 + disposableJpeg.length, 0);
        raw.writeUInt8(1, 4); raw.writeUInt8(1, 5);
        raw.writeUInt32BE(7, 6); // Must be sequence 1.
        raw.writeUInt16BE(0, 10); // Invalid dimensions.
        raw.writeUInt16BE(700, 12);
        raw.writeBigUInt64BE(BigInt(Date.now()), 14);
        raw.set(disposableJpeg, 22);
        socket.write(raw);
      });
    });
    malicious.listen(0, "127.0.0.1");
    await once(malicious, "listening");
    const address = malicious.address();
    if (!address || typeof address === "string") throw Error("No test TCP port");
    const callback = vi.fn();
    const viewer = await connectRemotePrivateViewerClient(
      options(address.port, authorized.viewerCredential, callback),
    );
    try {
      await vi.waitFor(() => expect(viewer.isConnected).toBe(false));
      expect(callback).not.toHaveBeenCalled();
      expect(viewer.deliveredFrames).toBe(0);
    } finally {
      viewer.close();
      await new Promise<void>(resolve => malicious.close(() => resolve()));
      host.close();
    }
  });

  it("rejects malformed JPEG markers, sequence, dimensions, and oversized length prefixes", async () => {
    for (const defect of ["sequence", "dimensions", "jpeg", "length", "control"] as const) {
      const host = bridge();
      const approved = await authorize(host);
      const server = tlsServer({
        key: serverKey, cert: serverCert, ca, requestCert: true, rejectUnauthorized: true,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
        ALPNProtocols: [REMOTE_PRIVATE_ALPN],
      }, socket => {
        socket.write(encodeRemotePrivateControl({
          version: 1, type: "challenge", connectionId: "tls-" + "b".repeat(40),
        }));
        socket.once("data", () => {
          socket.write(encodeRemotePrivateControl({
            version: 1, type: "ready", expiresAt: approved.viewerCredential.expiresAt,
          }));
          if (defect === "length") {
            const prefix = Buffer.alloc(4);
            prefix.writeUInt32BE(512 * 1024 + 18 + 1, 0);
            socket.write(prefix);
            return;
          }
          if (defect === "control") {
            socket.write(encodeRemotePrivateControl({ version: 1, type: "pointer", x: 1 }));
            return;
          }
          const raw = Buffer.alloc(4 + 18 + disposableJpeg.length);
          raw.writeUInt32BE(18 + disposableJpeg.length, 0);
          raw.writeUInt8(1, 4);
          raw.writeUInt8(1, 5);
          raw.writeUInt32BE(defect === "sequence" ? 2 : 1, 6);
          raw.writeUInt16BE(defect === "dimensions" ? 0 : 1200, 10);
          raw.writeUInt16BE(700, 12);
          raw.writeBigUInt64BE(BigInt(Date.now()), 14);
          raw.set(disposableJpeg, 22);
          if (defect === "jpeg") raw[22] = 0x00;
          socket.write(raw);
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("No test TCP port");
      const callback = vi.fn();
      const viewer = await connectRemotePrivateViewerClient(
        options(address.port, approved.viewerCredential, callback),
      );
      try {
        await vi.waitFor(() => expect(viewer.isConnected).toBe(false));
        expect(callback).not.toHaveBeenCalled();
        expect(viewer.deliveredFrames).toBe(0);
      } finally {
        viewer.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        host.close();
      }
    }
  });

  it("revokes promptly when the native host invokes human takeover", async () => {
    const host = bridge();
    const authorized = await authorize(host);
    const server = await serve(host);
    const callback = vi.fn();
    const viewer = await connectRemotePrivateViewerClient(
      options(server.port, authorized.viewerCredential, callback),
    );
    try {
      host.humanTakeover();
      await vi.waitFor(() => expect(viewer.isConnected).toBe(false));
      expect(callback).not.toHaveBeenCalled();
    } finally { viewer.close(); await server.close(); }
  });
});
