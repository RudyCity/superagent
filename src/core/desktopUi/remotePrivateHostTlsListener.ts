/**
 * Opt-in, in-process TLS listener for an already attended/approved exact-window
 * Desktop Live session. No listener is created until start() succeeds.
 *
 * This cannot be called from a browser, network route or MCP tool. A native
 * operator must provision private server key material and approve a distinct
 * remote viewer using the transport's independent host-approval verifier.
 */
import { createHash, X509Certificate } from "node:crypto";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { once } from "node:events";
import type { NativeWindowPreviewManager } from "./livePreview.js";
import { RemoteLiveDenied, type RemoteHostIntent } from "./remoteSessionPolicy.js";
import {
  REMOTE_PRIVATE_ALPN,
  RemotePrivateTransportBridge,
  type RemotePrivateViewerCredential,
} from "./remotePrivateTransport.js";
import { RemotePrivateLiveRuntime } from "./remotePrivateLiveRuntime.js";

export const PRIVATE_HOST_TLS_HANDSHAKE_TIMEOUT_MS = 5_000;
export const PRIVATE_HOST_ATTACH_POLL_MS = 50;
export const PRIVATE_HOST_ATTACH_TIMEOUT_MS = 5_000;

export interface PrivateHostTlsCertificateMaterial {
  /** Configured from a trusted OS-only provider; never accepted from web/MCP. */
  readonly serverCertificate: Buffer;
  readonly serverKey: Buffer;
  readonly viewerCa: Buffer;
  /** Numeric private host interface. Never wildcard, public IP, DNS or tunnel. */
  readonly privateAddress: string;
  /** 0 chooses a private, ephemeral port. */
  readonly port: number;
}
export interface PrivateHostStarted {
  readonly address: string;
  readonly port: number;
  readonly expiresAt: number;
  /** Caller MUST deliver using independent trusted out-of-band native UI. */
  readonly viewerCredential: RemotePrivateViewerCredential;
}

function privateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  return parts[0] === 127 && parts[1] === 0 && parts[2] === 0 && parts[3] === 1 ||
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}
function invalid(): never { throw new RemoteLiveDenied("TRANSPORT_DENIED"); }
function validateCertificate(config: PrivateHostTlsCertificateMaterial, expectedOrigin: string) {
  if (!config || !privateIpv4(config.privateAddress) ||
      !Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535 ||
      !Buffer.isBuffer(config.serverCertificate) ||
      !Buffer.isBuffer(config.serverKey) || !Buffer.isBuffer(config.viewerCa) ||
      config.serverCertificate.length < 128 || config.serverCertificate.length > 32_768 ||
      config.serverKey.length < 128 || config.serverKey.length > 32_768 ||
      config.viewerCa.length < 128 || config.viewerCa.length > 32_768) invalid();
  let hostname: string;
  try {
    const origin = new URL(expectedOrigin);
    if (origin.origin !== expectedOrigin || origin.protocol !== "https:" ||
        !origin.hostname || isIP(origin.hostname) !== 0) invalid();
    hostname = origin.hostname;
    const x509 = new X509Certificate(config.serverCertificate);
    if (x509.checkHost(hostname) !== hostname) invalid();
  } catch { invalid(); }
}

export class RemotePrivateHostTlsListener {
  private server: Server | null = null;
  private runtime: RemotePrivateLiveRuntime | null = null;
  private sockets = new Set<TLSSocket>();
  private attachTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private stopped = false;
  private accepted = false;

  constructor(
    private readonly preview: NativeWindowPreviewManager,
    private readonly transport: RemotePrivateTransportBridge,
    private readonly material: PrivateHostTlsCertificateMaterial,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Only a trusted host native caller may invoke start(). Preview session
   * must already exist, and the separate remote host approval is mandatory.
   * No implicit reconnect or fallback. The returned viewer HMAC material is
   * never sent over this socket, HTTP, a public tunnel or a browser WebView.
   */
  async start(raw: {
    readonly nativeWindow: RemoteHostIntent;
    readonly nativeRemoteProof: string;
    readonly localPreviewToken: string;
  }): Promise<PrivateHostStarted> {
    if (this.server || this.starting || this.stopped || this.accepted ||
        !raw || typeof raw.localPreviewToken !== "string" ||
        !/^[a-f0-9]{64}$/.test(raw.localPreviewToken) ||
        typeof raw.nativeRemoteProof !== "string" ||
        raw.nativeRemoteProof.length < 1 || raw.nativeRemoteProof.length > 8192) {
      throw new RemoteLiveDenied("CONSENT_REQUIRED");
    }
    this.starting = true;
    try {
      validateCertificate(this.material, raw.nativeWindow.expectedOrigin);
      const challenge = this.transport.beginNativeApproval(raw.nativeWindow);
      const host = await this.transport.approveNative({
        nonce: challenge.nonce, proof: raw.nativeRemoteProof,
      });
      if (this.stopped || host.expiresAt <= this.now() ||
          host.expiresAt - this.now() > 5 * 60_000) invalid();

      // Constrain mTLS 1.3 and ALPN; an independently pinned viewer cert and
      // HMAC proof are checked a second time by RemotePrivateTransportBridge.
      const server = createServer({
        key: this.material.serverKey,
        cert: this.material.serverCertificate,
        ca: this.material.viewerCa,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
        ALPNProtocols: [REMOTE_PRIVATE_ALPN],
        handshakeTimeout: PRIVATE_HOST_TLS_HANDSHAKE_TIMEOUT_MS,
      });
      this.server = server;
      this.runtime = new RemotePrivateLiveRuntime(this.preview, this.transport, this.now);
      server.on("secureConnection", socket => this.onSecureConnection(socket, raw.localPreviewToken));
      server.on("tlsClientError", () => { /* TLS rejects without logging peer data. */ });
      server.on("error", () => this.stop());
      server.listen(this.material.port, this.material.privateAddress);
      await once(server, "listening");
      if (this.stopped || server.address() === null) invalid();
      const address = server.address();
      if (!address || typeof address === "string" ||
          address.address !== this.material.privateAddress ||
          !Number.isSafeInteger(address.port) || address.port < 1) invalid();
      this.expiryTimer = setTimeout(() => this.stop(),
        Math.max(1, host.expiresAt - this.now()));
      this.expiryTimer.unref?.();
      return {
        address: address.address,
        port: address.port,
        expiresAt: host.expiresAt,
        viewerCredential: host.viewerCredential,
      };
    } catch {
      this.stop();
      throw new RemoteLiveDenied("CONSENT_REQUIRED");
    } finally {
      this.starting = false;
    }
  }

  private onSecureConnection(socket: TLSSocket, localPreviewToken: string) {
    if (this.stopped || this.accepted || this.sockets.size > 0 ||
        !privateIpv4(socket.remoteAddress || "") ||
        !privateIpv4(socket.localAddress || "")) {
      socket.destroy();
      return;
    }
    this.accepted = true;
    this.sockets.add(socket);
    socket.once("close", () => this.stop());
    socket.once("error", () => this.stop());
    try { this.transport.attachPrivateTlsSocket(socket); }
    catch { this.stop(); return; }
    // The transport finishes viewer authentication asynchronously after
    // receiving its connection-bound viewer HMAC. Never capture before that.
    const started = this.now();
    this.attachTimer = setInterval(() => {
      if (this.stopped) return;
      if (this.now() - started >= PRIVATE_HOST_ATTACH_TIMEOUT_MS) {
        this.stop();
        return;
      }
      try {
        this.transport.withApprovedViewerAuthorization(() => true);
      } catch {
        return; // Not yet authenticated: bounded, no native capture.
      }
      if (this.attachTimer) clearInterval(this.attachTimer);
      this.attachTimer = null;
      try { this.runtime?.startAfterNativeAndViewerApproval(localPreviewToken); }
      catch { this.stop(); }
    }, PRIVATE_HOST_ATTACH_POLL_MS);
    this.attachTimer.unref?.();
  }

  /** Native host takeover and transport shutdown are final; never re-arm. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.attachTimer) clearInterval(this.attachTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.attachTimer = null;
    this.expiryTimer = null;
    try { this.runtime?.humanTakeover(); }
    catch { /* Revocation remains terminal. */ }
    this.runtime = null;
    try { this.transport.close(); }
    catch { /* Revocation remains terminal. */ }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    try { this.server?.close(); }
    catch { /* Existing socket already destroyed. */ }
    this.server = null;
  }

  humanTakeover(): void { this.stop(); }
  get isStopped(): boolean { return this.stopped; }
  get isViewing(): boolean { return !this.stopped && this.runtime?.isActive === true; }
}
