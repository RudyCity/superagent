/**
 * Node-only, view-only client for the native-approved private Desktop Live bridge.
 * No HTTP, browser exposure, proxy, discovery, reconnect, recording or input path.
 */
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  computeRemotePrivateViewerProof, encodeRemotePrivateControl,
  REMOTE_PRIVATE_ALPN, REMOTE_PRIVATE_HANDSHAKE_MS,
  REMOTE_PRIVATE_MAX_CONTROL_BYTES,
  type RemotePrivateViewerCredential,
} from "./remotePrivateTransport.js";
import {
  REMOTE_FRAME_ACK_TIMEOUT_MS, REMOTE_MAX_FRAME_BYTES,
} from "./remoteViewerFrames.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const CONNECTION_ID = /^tls-[a-f0-9]{40}$/;
const FRAME_HEADER_BYTES = 18;
const MAX_MESSAGE_BYTES = REMOTE_MAX_FRAME_BYTES + FRAME_HEADER_BYTES;
const FRAME_CONSUMER_TIMEOUT_MS = REMOTE_FRAME_ACK_TIMEOUT_MS - 500;

export interface RemotePrivateViewerFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly capturedAtMs: number;
  /** In-memory only. The consumer must not record or forward this JPEG. */
  readonly jpeg: Uint8Array;
}

export interface RemotePrivateViewerClientOptions {
  /** Numeric RFC1918/loopback/ULA destination. Never DNS or a public proxy. */
  privateAddress: string;
  port: number;
  /** Provisioned over separately authenticated private/native IPC. */
  credential: RemotePrivateViewerCredential;
  /** DER SHA-256 pin for the SERVER certificate (distinct from viewer pin). */
  pinnedServerCertSha256: string;
  /** Native/private mTLS identity, never a browser or tunnel bearer. */
  clientCert: Buffer | string;
  clientKey: Buffer | string;
  trustedCa: Buffer | string;
  /** Return/resolve only after the trusted display consumer has handled a frame. */
  onFrame: (frame: RemotePrivateViewerFrame) => void | Promise<void>;
  now?: () => number;
}

export class RemotePrivateViewerDenied extends Error {
  constructor() {
    super("Private desktop viewer connection denied.");
    this.name = "RemotePrivateViewerDenied";
  }
}

function deny(): never { throw new RemotePrivateViewerDenied(); }

function privateIp(value: string): boolean {
  const address = value.startsWith("::ffff:") ? value.slice(7) : value;
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  return lower === "::1" || /^(fc|fd)[0-9a-f]{2}:/.test(lower);
}

function sameSha256(a: string, b: string): boolean {
  return HEX_SHA256.test(a) && HEX_SHA256.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

function verifyOptions(options: RemotePrivateViewerClientOptions): string {
  const c = options?.credential;
  if (!options || !privateIp(options.privateAddress) ||
      !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535 ||
      !HEX_SHA256.test(options.pinnedServerCertSha256) ||
      !c || !HEX_SHA256.test(c.viewerKey) || !HEX_SHA256.test(c.viewerChallenge) ||
      !HEX_SHA256.test(c.sessionId) || !HEX_SHA256.test(c.pinnedViewerCertSha256) ||
      typeof c.hostId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(c.hostId) ||
      typeof c.viewerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(c.viewerId) ||
      typeof options.onFrame !== "function" ||
      !options.clientCert || !options.clientKey || !options.trustedCa ||
      !Number.isSafeInteger(c.expiresAt)) deny();
  const now = (options.now || Date.now)();
  if (!Number.isSafeInteger(now) || c.expiresAt <= now || c.expiresAt > now + 120_000) deny();
  let hostname: string;
  try {
    const url = new URL(c.expectedOrigin);
    if (url.origin !== c.expectedOrigin || url.protocol !== "https:" ||
        url.username || url.password || url.hostname === "localhost" ||
        isIP(url.hostname) !== 0 || c.expectedOrigin.length > 256) deny();
    hostname = url.hostname;
  } catch { deny(); }
  try {
    const actualViewerPin = createHash("sha256")
      .update(new X509Certificate(options.clientCert).raw).digest("hex");
    if (!sameSha256(actualViewerPin, c.pinnedViewerCertSha256)) deny();
  } catch { deny(); }
  return hostname;
}

/**
 * Single-use session. Connect once and terminate on ANY ambiguity.
 * A fresh native approval and credential are required after disconnect.
 */
export class RemotePrivateViewerClient {
  private phase: "tls" | "challenge" | "awaiting-ready" | "ready" = "tls";
  private incoming = Buffer.alloc(0);
  private closed = false;
  private consuming = false;
  private sequence = 0;
  private lastCapturedAt = 0;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private consumeTimer?: ReturnType<typeof setTimeout>;
  private resolveConnect?: (client: RemotePrivateViewerClient) => void;
  private rejectConnect?: (error: Error) => void;
  private connectSettled = false;

  private constructor(
    private readonly socket: TLSSocket,
    private readonly options: RemotePrivateViewerClientOptions,
  ) {}

  static async connect(options: RemotePrivateViewerClientOptions): Promise<RemotePrivateViewerClient> {
    const hostname = verifyOptions(options);
    // Numeric private peer IP is deliberate: no DNS resolution, HTTP proxy or tunnel.
    const socket = tlsConnect({
      host: options.privateAddress, port: options.port, servername: hostname,
      cert: options.clientCert, key: options.clientKey, ca: options.trustedCa,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      ALPNProtocols: [REMOTE_PRIVATE_ALPN],
    });
    const client = new RemotePrivateViewerClient(socket, options);
    socket.setNoDelay(true);
    return new Promise((resolve, reject) => {
      client.resolveConnect = resolve;
      client.rejectConnect = reject;
      client.handshakeTimer = setTimeout(() => client.close(), REMOTE_PRIVATE_HANDSHAKE_MS);
      client.handshakeTimer.unref?.();
      client.leaseTimer = setTimeout(() => client.close(),
        Math.max(1, options.credential.expiresAt - (options.now || Date.now)()));
      client.leaseTimer.unref?.();
      socket.once("secureConnect", () => client.verifyPeer(hostname));
      socket.on("data", bytes => client.onData(bytes));
      socket.once("error", () => client.close());
      socket.once("end", () => client.close());
      socket.once("close", () => client.close());
    });
  }

  get isConnected(): boolean { return this.phase === "ready" && !this.closed; }
  get deliveredFrames(): number { return this.sequence; }

  /** Local revocation: destroys in-flight TLS data, no graceful retry/drain. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (this.consumeTimer) clearTimeout(this.consumeTimer);
    this.incoming.fill(0);
    this.incoming = Buffer.alloc(0);
    this.socket.destroy();
    if (!this.connectSettled) {
      this.connectSettled = true;
      this.rejectConnect?.(new RemotePrivateViewerDenied());
    }
  }

  private verifyPeer(hostname: string): void {
    try {
      const cert = this.socket.getPeerCertificate(true)?.raw;
      if (this.closed || this.socket.authorized !== true ||
          this.socket.getProtocol() !== "TLSv1.3" ||
          this.socket.alpnProtocol !== REMOTE_PRIVATE_ALPN ||
          this.socket.servername !== hostname ||
          !privateIp(this.socket.remoteAddress || "") ||
          !privateIp(this.socket.localAddress || "") || !cert ||
          !sameSha256(
            createHash("sha256").update(cert).digest("hex"),
            this.options.pinnedServerCertSha256,
          )) { this.close(); return; }
      this.phase = "challenge";
    } catch { this.close(); }
  }

  private send(message: Record<string, unknown>): boolean {
    if (this.closed || !this.socket.writable || this.socket.writableLength !== 0) {
      this.close(); return false;
    }
    try {
      if (!this.socket.write(encodeRemotePrivateControl(message))) {
        this.close(); return false;
      }
      return true;
    } catch { this.close(); return false; }
  }

  private onData(bytes: Buffer): void {
    if (this.closed) return;
    if (this.phase === "tls" || this.consuming) { this.close(); return; }
    const max = this.phase === "ready" ? MAX_MESSAGE_BYTES : REMOTE_PRIVATE_MAX_CONTROL_BYTES;
    if (bytes.length > max + 4 || this.incoming.length + bytes.length > max + 4) {
      this.close(); return;
    }
    this.incoming = Buffer.concat([this.incoming, bytes]);
    while (!this.closed && !this.consuming && this.incoming.length >= 4) {
      const size = this.incoming.readUInt32BE(0);
      const limit = this.phase === "ready" ? MAX_MESSAGE_BYTES : REMOTE_PRIVATE_MAX_CONTROL_BYTES;
      if (size < 1 || size > limit) { this.close(); return; }
      if (this.incoming.length < size + 4) return;
      const packet = Buffer.from(this.incoming.subarray(4, size + 4));
      const rest = Buffer.from(this.incoming.subarray(size + 4));
      this.incoming.fill(0);
      this.incoming = rest;
      if (this.phase === "ready") {
        // Server permits only one outstanding frame. Any piggybacked packet is forbidden.
        if (this.incoming.length !== 0) { packet.fill(0); this.close(); return; }
        this.onBinaryFrame(packet);
      } else {
        this.onControl(packet);
      }
      packet.fill(0);
    }
  }

  private onControl(packet: Buffer): void {
    let data: unknown;
    try { data = JSON.parse(packet.toString("utf8")); }
    catch { this.close(); return; }
    if (this.phase === "challenge") {
      if (!exactObject(data, ["version", "type", "connectionId"]) ||
          data.version !== 1 || data.type !== "challenge" ||
          typeof data.connectionId !== "string" ||
          !CONNECTION_ID.test(data.connectionId)) { this.close(); return; }
      const proof = computeRemotePrivateViewerProof(this.options.credential, data.connectionId);
      this.phase = "tls"; // Forbid any unsolicited bytes while attach is in flight.
      if (this.send({ version: 1, type: "attach",
        sessionId: this.options.credential.sessionId, proof })) {
        this.phase = "awaiting-ready";
      }
      return;
    }
    // A second challenge, forged ready fields, or unrecognized control revokes.
    if (!exactObject(data, ["version", "type", "expiresAt"]) ||
        data.version !== 1 || data.type !== "ready" ||
        data.expiresAt !== this.options.credential.expiresAt ||
        (this.options.now || Date.now)() >= this.options.credential.expiresAt) {
      this.close(); return;
    }
    this.phase = "ready";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (!this.connectSettled) {
      this.connectSettled = true;
      this.resolveConnect?.(this);
    }
  }

  private onBinaryFrame(packet: Buffer): void {
    const now = (this.options.now || Date.now)();
    if (packet.length < FRAME_HEADER_BYTES + 4 || packet.length > MAX_MESSAGE_BYTES ||
        packet[0] !== 1 || packet[1] !== 1) { this.close(); return; }
    const sequence = packet.readUInt32BE(2);
    const width = packet.readUInt16BE(6);
    const height = packet.readUInt16BE(8);
    const captured = packet.readBigUInt64BE(10);
    const jpeg = packet.subarray(FRAME_HEADER_BYTES);
    if (sequence !== this.sequence + 1 || sequence > 0xffffffff ||
        width < 1 || height < 1 || width > 1920 || height > 1920 ||
        width * height > 2_073_600 || captured > BigInt(Number.MAX_SAFE_INTEGER) ||
        Number(captured) <= this.lastCapturedAt ||
        Number(captured) < now - 5_000 || Number(captured) > now + 1_000 ||
        jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
      this.close(); return;
    }
    const frame: RemotePrivateViewerFrame = {
      sequence, width, height, capturedAtMs: Number(captured),
      jpeg: Uint8Array.from(jpeg),
    };
    this.consuming = true;
    this.socket.pause();
    this.consumeTimer = setTimeout(() => this.close(), FRAME_CONSUMER_TIMEOUT_MS);
    this.consumeTimer.unref?.();
    // A consumer failure never produces an ACK. Avoid retaining frame in a queue.
    void Promise.resolve().then(() => this.options.onFrame(frame)).then(() => {
      if (this.consumeTimer) clearTimeout(this.consumeTimer);
      if (this.closed || (this.options.now || Date.now)() >= this.options.credential.expiresAt) {
        this.close(); return;
      }
      this.lastCapturedAt = frame.capturedAtMs;
      this.sequence = sequence;
      if (!this.send({ version: 1, type: "ack", sequence })) return;
      this.consuming = false;
      this.socket.resume();
    }).catch(() => this.close());
  }
}

export function connectRemotePrivateViewerClient(
  options: RemotePrivateViewerClientOptions,
): Promise<RemotePrivateViewerClient> {
  return RemotePrivateViewerClient.connect(options);
}
