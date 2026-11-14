/**
 * Private Desktop Live: an ATTACH-ONLY, mTLS-authenticated socket adapter.
 *
 * This module never listens, discovers, captures, forwards input, or publishes
 * HTTP/MCP endpoints. The native host must independently approve an exact
 * window and pass in an already-accepted, direct, private TLS server socket.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import type { NativeWindowPreviewManager } from "./livePreview.js";
import { RemoteHostCaptureBridge } from "./remoteHostCapture.js";
import {
  RemoteLiveDenied, RemoteLiveSessionPolicy,
  type RemoteHostApprovalEvidence, type RemoteHostIntent,
  type RemoteTransportEvidence, type RemoteViewerProofEvidence,
} from "./remoteSessionPolicy.js";
import {
  RemoteViewerFrameGate, REMOTE_FRAME_ACK_TIMEOUT_MS, REMOTE_MAX_FRAME_BYTES,
  type RemoteFramePacket, type RemotePrivateFrameSink,
  type RemoteVerifiedJpegFrame, type RemoteViewerAuthorization,
} from "./remoteViewerFrames.js";

export const REMOTE_PRIVATE_ALPN = "superagent-desktop-live/1";
export const REMOTE_PRIVATE_HANDSHAKE_MS = 5_000;
export const REMOTE_PRIVATE_MAX_CONTROL_BYTES = 512;
const MAX_ACK_BYTES = 96;
const FRAME_HEADER_BYTES = 18;
const TLS_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export interface RemotePrivateTransportOptions {
  /** Server-side expectation, NOT an Origin or X-Forwarded header. */
  expectedOrigin: string;
  viewerId: string;
  /** SHA-256 of the client's DER certificate, provisioned outside HTTP/MCP. */
  pinnedViewerCertSha256: string;
  /** Host approval must be verified through attended native IPC only. */
  verifyNativeApproval: (evidence: RemoteHostApprovalEvidence) => Promise<boolean>;
  now?: () => number;
}

export interface RemotePrivateViewerCredential {
  readonly sessionId: string;
  readonly viewerChallenge: string;
  readonly viewerKey: string;
  readonly hostId: string;
  readonly viewerId: string;
  readonly expectedOrigin: string;
  readonly pinnedViewerCertSha256: string;
  readonly expiresAt: number;
}

interface Grant {
  sessionId: string;
  challenge: string;
  key: Buffer;
  hostId: string;
  expiresAt: number;
}

type Phase = "hello" | "attaching" | "ready";
interface Connection {
  socket: TLSSocket;
  connectionId: string;
  evidence: RemoteTransportEvidence;
  phase: Phase;
  inbound: Buffer;
  auth?: RemoteViewerAuthorization;
  sink?: RemotePrivateFrameSink;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  ackTimer?: ReturnType<typeof setTimeout>;
}

function deny(): never {
  throw new RemoteLiveDenied("TRANSPORT_DENIED");
}

function privateAddress(value: string | undefined): boolean {
  if (!value) return false;
  const addr = value.startsWith("::ffff:") ? value.slice(7) : value;
  if (isIP(addr) === 4) {
    const v = addr.split(".").map(Number);
    return v[0] === 10 || v[0] === 127 ||
      (v[0] === 172 && v[1] >= 16 && v[1] <= 31) ||
      (v[0] === 192 && v[1] === 168);
  }
  if (isIP(addr) !== 6) return false;
  const normalized = addr.toLowerCase();
  return normalized === "::1" || /^(fc|fd)[0-9a-f]{2}:/.test(normalized);
}

function sameDigest(a: string, b: string): boolean {
  if (!TLS_FINGERPRINT_PATTERN.test(a) || !TLS_FINGERPRINT_PATTERN.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function proofData(c: Omit<RemotePrivateViewerCredential, "viewerKey" | "expiresAt">,
  connectionId: string): string {
  return JSON.stringify([
    "desktop-live-private-v1", c.sessionId, c.viewerChallenge,
    c.hostId, c.viewerId, c.expectedOrigin, c.pinnedViewerCertSha256,
    connectionId,
  ]);
}

/** Used by a separately authenticated PRIVATE viewer; never send its key to a browser/tunnel. */
export function computeRemotePrivateViewerProof(
  credential: RemotePrivateViewerCredential, connectionId: string,
): string {
  if (!TLS_FINGERPRINT_PATTERN.test(credential.viewerKey)) deny();
  return createHmac("sha256", Buffer.from(credential.viewerKey, "hex"))
    .update(proofData(credential, connectionId)).digest("hex");
}

function exactMessage(value: unknown, kind: "attach" | "ack"): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = kind === "attach"
    ? ["version", "type", "sessionId", "proof"]
    : ["version", "type", "sequence"];
  return Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k)) &&
    obj.version === 1 && obj.type === kind;
}

/** Wire: uint32BE payload length, then bounded JSON for control or fixed binary JPEG frame. */
export function encodeRemotePrivateControl(message: Record<string, unknown>): Buffer {
  const data = Buffer.from(JSON.stringify(message), "utf8");
  if (data.length < 1 || data.length > REMOTE_PRIVATE_MAX_CONTROL_BYTES) deny();
  const wire = Buffer.allocUnsafe(4 + data.length);
  wire.writeUInt32BE(data.length, 0);
  data.copy(wire, 4);
  return wire;
}

function encodeFrame(frame: RemoteFramePacket): Buffer {
  if (frame.version !== 1 || frame.type !== "frame" || frame.format !== "jpeg" ||
      !Number.isSafeInteger(frame.sequence) || frame.sequence < 1 ||
      frame.sequence > 0xffffffff || frame.jpeg.byteLength > REMOTE_MAX_FRAME_BYTES ||
      frame.jpeg.byteLength < 4) deny();
  const payloadLength = FRAME_HEADER_BYTES + frame.jpeg.byteLength;
  const wire = Buffer.allocUnsafe(4 + payloadLength); // Single bounded copy, no queue.
  wire.writeUInt32BE(payloadLength, 0);
  wire.writeUInt8(1, 4);
  wire.writeUInt8(1, 5); // binary frame
  wire.writeUInt32BE(frame.sequence, 6);
  wire.writeUInt16BE(frame.width, 10);
  wire.writeUInt16BE(frame.height, 12);
  wire.writeBigUInt64BE(BigInt(frame.capturedAtMs), 14);
  wire.set(frame.jpeg, 22);
  return wire;
}

/** Immutable host-side connection evidence comes from TLS engine and bound config. */
function trustedEvidence(socket: TLSSocket, expectedOrigin: string, viewerId: string,
  pinnedViewerCertSha256: string): RemoteTransportEvidence {
  const host = new URL(expectedOrigin).hostname;
  const peer = socket.getPeerCertificate(true)?.raw;
  if ((socket as TLSSocket & { isServer?: boolean }).isServer !== true || !socket.encrypted || socket.destroyed ||
      socket.authorized !== true || socket.getProtocol() !== "TLSv1.3" ||
      socket.alpnProtocol !== REMOTE_PRIVATE_ALPN ||
      (typeof socket.servername !== "string" || socket.servername.toLowerCase() !== host.toLowerCase()) ||
      !privateAddress(socket.remoteAddress) || !privateAddress(socket.localAddress) ||
      !peer || !sameDigest(createHash("sha256").update(peer).digest("hex"), pinnedViewerCertSha256)) {
    deny();
  }
  return {
    connectionId: "tls-" + randomBytes(20).toString("hex"),
    authenticatedViewerId: viewerId,
    origin: expectedOrigin,
    tlsVerified: true,
    privateIngressVerified: true,
    publicTunnelDetected: false,
    forwardedHeadersPresent: false,
  };
}

export class RemotePrivateTransportBridge {
  private readonly sessions: RemoteLiveSessionPolicy;
  private readonly frames: RemoteViewerFrameGate;
  private readonly now: () => number;
  private grant: Grant | null = null;
  private bound: Connection | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RemotePrivateTransportOptions) {
    if (!TLS_FINGERPRINT_PATTERN.test(options.pinnedViewerCertSha256) ||
        typeof options.viewerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(options.viewerId) ||
        typeof options.verifyNativeApproval !== "function") deny();
    try {
      const origin = new URL(options.expectedOrigin);
      if (origin.origin !== options.expectedOrigin || origin.protocol !== "https:" ||
          origin.hostname === "localhost" || isIP(origin.hostname) !== 0) deny();
    } catch { deny(); }
    this.now = options.now || Date.now;
    this.sessions = new RemoteLiveSessionPolicy({
      verifyHostApproval: evidence => options.verifyNativeApproval(evidence),
      verifyViewerProof: evidence => this.verifyProof(evidence),
    }, this.now, () => this.revokeSocketAndSecret());
    this.frames = new RemoteViewerFrameGate(this.sessions, this.now);
  }

  beginNativeApproval(intent: RemoteHostIntent): { nonce: string; expiresAt: number } {
    if (intent?.viewerId !== this.options.viewerId ||
        intent.expectedOrigin !== this.options.expectedOrigin) deny();
    const challenge = this.sessions.beginNativeApproval(intent);
    this.currentHostId = intent.hostId;
    return challenge;
  }

  /** Host/native IPC only. Return the credential ONLY through separately trusted delivery. */
  async approveNative(raw: { nonce: string; proof: string }): Promise<{
    sessionId: string; hostToken: string; viewerCredential: RemotePrivateViewerCredential;
    expiresAt: number;
  }> {
    const approved = await this.sessions.approveNative(raw);
    const secret = randomBytes(32);
    this.grant = {
      sessionId: approved.sessionId, challenge: approved.viewerChallenge,
      key: secret, hostId: this.currentHostId,
      expiresAt: approved.expiresAt,
    };
    // Native challenge and approved host identity are retained only through
    // beginNativeApproval, never sourced from an incoming remote message.
    const viewerCredential: RemotePrivateViewerCredential = {
      sessionId: approved.sessionId, viewerChallenge: approved.viewerChallenge,
      viewerKey: secret.toString("hex"), hostId: this.currentHostId,
      viewerId: this.options.viewerId, expectedOrigin: this.options.expectedOrigin,
      pinnedViewerCertSha256: this.options.pinnedViewerCertSha256, expiresAt: approved.expiresAt,
    };
    this.leaseTimer = setTimeout(() => this.sessions.terminate(),
      Math.max(1, approved.expiresAt - this.now()));
    this.leaseTimer.unref?.();
    return {
      sessionId: approved.sessionId, hostToken: approved.hostToken,
      viewerCredential, expiresAt: approved.expiresAt,
    };
  }

  private currentHostId = "";
  // Called only through the native host approval verifier's trusted intent.
  private async verifyProof(evidence: RemoteViewerProofEvidence): Promise<boolean> {
    const g = this.grant;
    if (!g || g.sessionId !== evidence.sessionId ||
        g.challenge !== evidence.nonce || g.hostId !== evidence.hostId ||
        evidence.viewerId !== this.options.viewerId ||
        evidence.expectedOrigin !== this.options.expectedOrigin ||
        !TLS_FINGERPRINT_PATTERN.test(evidence.proof) || this.now() >= g.expiresAt) return false;
    const expected = createHmac("sha256", g.key).update(proofData({
      sessionId: g.sessionId, viewerChallenge: g.challenge, hostId: g.hostId,
      viewerId: this.options.viewerId, expectedOrigin: this.options.expectedOrigin,
      pinnedViewerCertSha256: this.options.pinnedViewerCertSha256,
    }, evidence.connectionId)).digest("hex");
    return sameDigest(expected, evidence.proof);
  }

  /** Must be called on an mTLS server's secureConnection callback, NOT on a proxy's socket. */
  attachPrivateTlsSocket(socket: TLSSocket): string {
    if (this.bound || !this.grant || this.now() >= this.grant.expiresAt) {
      socket.destroy();
      deny();
    }
    let evidence: RemoteTransportEvidence;
    try {
      evidence = trustedEvidence(socket, this.options.expectedOrigin,
        this.options.viewerId, this.options.pinnedViewerCertSha256);
    } catch {
      socket.destroy();
      throw new RemoteLiveDenied("TRANSPORT_DENIED");
    }
    const bound: Connection = {
      socket, connectionId: evidence.connectionId, evidence, phase: "hello",
      inbound: Buffer.alloc(0),
    };
    this.bound = bound;
    socket.setNoDelay(true);
    socket.on("data", chunk => this.receive(bound, chunk));
    socket.once("close", () => this.disconnected(bound));
    socket.once("end", () => this.disconnected(bound));
    socket.on("error", () => this.disconnected(bound)); // Never log bytes or peer metadata.
    bound.handshakeTimer = setTimeout(() => this.sessions.terminate(),
      Math.min(REMOTE_PRIVATE_HANDSHAKE_MS, Math.max(1, this.grant.expiresAt - this.now())));
    bound.handshakeTimer.unref?.();
    if (!this.writeControl(bound, { version: 1, type: "challenge",
      connectionId: bound.connectionId })) this.sessions.terminate();
    return bound.connectionId;
  }

  /** Native verified exact-window frame only. No general screenshot/capture API. */
  offerVerifiedFrame(frame: RemoteVerifiedJpegFrame): { sequence: number } {
    const c = this.bound;
    if (!c || c.phase !== "ready" || !c.auth || !c.sink || c.socket.destroyed) {
      throw new RemoteLiveDenied("SESSION_DENIED");
    }
    const receipt = this.frames.offer(c.auth, frame, c.sink);
    if (this.bound !== c || c.socket.destroyed) throw new RemoteLiveDenied("SESSION_DENIED");
    if (c.ackTimer) clearTimeout(c.ackTimer);
    c.ackTimer = setTimeout(() => this.sessions.terminate(), REMOTE_FRAME_ACK_TIMEOUT_MS);
    c.ackTimer.unref?.();
    return receipt;
  }

  /**
   * PRIVATE HOST-ONLY synchronous handoff. The viewer CSRF never crosses TLS,
   * IPC or HTTP, and the callback must not escape this invocation. This is
   * solely for claiming the existing native-approved capture lease.
   */
  withApprovedViewerAuthorization<T>(handler: (auth: Readonly<RemoteViewerAuthorization>) => T): T {
    const connection = this.bound;
    if (!connection || connection.phase !== "ready" || connection.socket.destroyed ||
        !connection.auth || typeof handler !== "function") deny();
    this.sessions.authorizeViewer(connection.auth);
    const auth: Readonly<RemoteViewerAuthorization> = Object.freeze({
      sessionId: connection.auth.sessionId, csrfToken: connection.auth.csrfToken,
      transport: Object.freeze({ ...connection.auth.transport }),
    });
    const result = handler(auth);
    if (result && typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function") deny();
    if (this.bound !== connection || connection.socket.destroyed) deny();
    this.sessions.authorizeViewer(connection.auth);
    return result;
  }

  /**
   * Host-only native capture claim: keep viewer CSRF and the session policy
   * inaccessible to network peers. Never forward the local preview token.
   */
  claimNativeCapture(manager: NativeWindowPreviewManager, localPreviewToken: string,
    now: () => number = Date.now): RemoteHostCaptureBridge {
    return this.withApprovedViewerAuthorization(auth =>
      RemoteHostCaptureBridge.claim(manager, localPreviewToken, this.sessions, auth, now));
  }

  /** Native human-takeover/supervisor callback: revoke both viewing and future frames. */
  humanTakeover(): void {
    this.sessions.terminate();
  }

  revokeByHost(raw: { sessionId: string; hostToken: string }): void {
    this.sessions.revokeByHost(raw);
  }

  close(): void {
    this.sessions.terminate();
    this.revokeSocketAndSecret();
  }

  private writeControl(c: Connection, data: Record<string, unknown>): boolean {
    if (this.bound !== c || c.socket.destroyed || !c.socket.writable ||
        c.socket.writableLength !== 0) return false;
    try { return c.socket.write(encodeRemotePrivateControl(data)); }
    catch { return false; }
  }

  private disconnected(c: Connection): void {
    if (this.bound !== c) return;
    this.frames.onTransportDisconnected();
    this.revokeSocketAndSecret();
  }

  private revokeSocketAndSecret(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    const c = this.bound;
    this.bound = null;
    if (c) {
      if (c.ackTimer) clearTimeout(c.ackTimer);
      if (c.handshakeTimer) clearTimeout(c.handshakeTimer);
      c.inbound.fill(0);
      c.inbound = Buffer.alloc(0);
      c.socket.destroy(); // Discard Node TLS write buffer, never graceful drain.
    }
    if (this.grant) this.grant.key.fill(0);
    this.grant = null;
    this.currentHostId = "";
  }

  private receive(c: Connection, raw: Buffer | Uint8Array): void {
    if (this.bound !== c || c.socket.destroyed || c.phase === "attaching") {
      this.sessions.terminate();
      return;
    }
    const bytes = Buffer.from(raw);
    const max = c.phase === "hello" ? REMOTE_PRIVATE_MAX_CONTROL_BYTES : MAX_ACK_BYTES;
    if (bytes.length > max + 4 || c.inbound.length + bytes.length > max + 4) {
      this.sessions.terminate();
      return;
    }
    c.inbound = Buffer.concat([c.inbound, bytes]);
    if (c.inbound.length < 4) return;
    const size = c.inbound.readUInt32BE(0);
    if (size < 1 || size > max || c.inbound.length > size + 4) {
      this.sessions.terminate();
      return;
    }
    if (c.inbound.length < size + 4) return;
    let payload: unknown;
    try { payload = JSON.parse(c.inbound.subarray(4).toString("utf8")); }
    catch { this.sessions.terminate(); return; }
    c.inbound.fill(0);
    c.inbound = Buffer.alloc(0);
    if (c.phase === "hello") {
      if (!exactMessage(payload, "attach") ||
          typeof payload.sessionId !== "string" || !/^[a-f0-9]{64}$/.test(payload.sessionId) ||
          typeof payload.proof !== "string" || !TLS_FINGERPRINT_PATTERN.test(payload.proof)) {
        this.sessions.terminate();
        return;
      }
      c.phase = "attaching";
      void this.finishAttach(c, payload.sessionId, payload.proof);
      return;
    }
    if (!exactMessage(payload, "ack") || !c.auth) {
      this.sessions.terminate();
      return;
    }
    try {
      this.frames.receiveViewerMessage(c.auth, payload);
      if (c.ackTimer) clearTimeout(c.ackTimer);
      c.ackTimer = undefined;
    } catch { this.sessions.terminate(); }
  }

  private async finishAttach(c: Connection, sessionId: string, proof: string): Promise<void> {
    try {
      const result = await this.sessions.attachViewer({ sessionId, proof, transport: c.evidence });
      if (this.bound !== c || c.socket.destroyed) return;
      const auth: RemoteViewerAuthorization = {
        sessionId, csrfToken: result.csrfToken, transport: c.evidence,
      };
      // No asynchronous sink queue, broadcasts, client-provided CSRF, or input path.
      const sink: RemotePrivateFrameSink = {
        connectionId: c.connectionId,
        bufferedBytes: () => c.socket.destroyed ? -1 : c.socket.writableLength,
        sendBinary: packet => {
          if (this.bound !== c || c.socket.destroyed || !c.socket.writable ||
              c.phase !== "ready" || c.socket.writableLength !== 0) return false;
          try {
            const wire = encodeFrame(packet);
            // No application queue: a direct write only when pre-write
            // writableLength is zero. Node TLS may transiently buffer its
            // in-flight encrypted record even for a successful write.
            if (!c.socket.write(wire)) {
              c.socket.destroy(); // Backpressure: discard the TLS write buffer.
              return false;
            }
            return true;
          } catch { c.socket.destroy(); return false; }
        },
      };
      c.auth = auth;
      c.sink = sink;
      c.phase = "ready";
      if (c.handshakeTimer) clearTimeout(c.handshakeTimer);
      c.handshakeTimer = undefined;
      if (!this.writeControl(c, { version: 1, type: "ready", expiresAt: result.expiresAt })) {
        this.sessions.terminate();
      }
    } catch { this.sessions.terminate(); }
  }

}
