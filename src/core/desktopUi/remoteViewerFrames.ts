/**
 * Bounded, synchronous, one-viewer JPEG frame gate.
 * NO listener, input channel, screen capture, recording, frame queue,
 * public tunnel forwarding, automatic reconnect or monitor fallback.
 *
 * The trusted transport must close its connection and discard pending writes
 * on RemoteLiveSessionPolicy.onRevoke, and supply trusted TransportEvidence.
 */
import {
  exactRemoteWindow, RemoteLiveDenied, RemoteLiveSessionPolicy,
  type RemoteTransportEvidence, type RemoteWindowPin,
} from "./remoteSessionPolicy.js";

export const REMOTE_MAX_FRAME_BYTES = 512 * 1024;
export const REMOTE_MIN_FRAME_INTERVAL_MS = 250;
export const REMOTE_MAX_FRAMES_PER_MINUTE = 120;
export const REMOTE_FRAME_ACK_TIMEOUT_MS = 3_000;
export const REMOTE_MAX_SINK_BUFFERED_BYTES = 0;

export interface RemoteVerifiedJpegFrame {
  /** Must originate from approved native exact-window capture + JPEG encoder. */
  jpeg: Uint8Array;
  width: number;
  height: number;
  capturedAtMs: number;
  window: RemoteWindowPin;
}

export interface RemoteFramePacket {
  version: 1;
  type: "frame";
  sequence: number;
  format: "jpeg";
  width: number;
  height: number;
  capturedAtMs: number;
  jpeg: Uint8Array;
}

/**
 * sendBinary MUST be a synchronous, direct, non-broadcast write to the
 * viewer's authenticated private connection; false means backpressure.
 * Its implementation must not log/record the binary payload or queue copies.
 */
export interface RemotePrivateFrameSink {
  /** Transport-owned immutable socket identity, never a client-supplied label. */
  readonly connectionId: string;
  bufferedBytes(): number;
  sendBinary(packet: RemoteFramePacket): boolean;
}

export interface RemoteViewerAuthorization {
  sessionId: string;
  csrfToken: string;
  transport: RemoteTransportEvidence;
}

function frameDenied(): never {
  throw new RemoteLiveDenied("INVALID_REQUEST");
}
function isFrame(frame: RemoteVerifiedJpegFrame, now: number): boolean {
  if (!frame || !(frame.jpeg instanceof Uint8Array)) return false;
  const b = frame.jpeg;
  return b.byteLength >= 4 && b.byteLength <= REMOTE_MAX_FRAME_BYTES &&
    b[0] === 0xff && b[1] === 0xd8 &&
    b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 &&
    Number.isSafeInteger(frame.width) && frame.width >= 1 && frame.width <= 1920 &&
    Number.isSafeInteger(frame.height) && frame.height >= 1 && frame.height <= 1920 &&
    frame.width * frame.height <= 2_073_600 &&
    Number.isSafeInteger(frame.capturedAtMs) &&
    frame.capturedAtMs <= now + 1_000 && frame.capturedAtMs >= now - 5_000;
}

export class RemoteViewerFrameGate {
  private sessionId: string | null = null;
  private sink: RemotePrivateFrameSink | null = null;
  private sequence = 0;
  private pending: { sequence: number; sentAt: number } | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastCaptureAt = Number.NEGATIVE_INFINITY;
  private sentInWindow: number[] = [];

  constructor(
    private readonly sessions: RemoteLiveSessionPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  private synchronizeSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.sink = null;
    this.sequence = 0;
    this.pending = null;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.lastCaptureAt = Number.NEGATIVE_INFINITY;
    this.sentInWindow = [];
  }

  /** Single synchronous write, never retain a screenshot or buffer a frame. */
  offer(auth: RemoteViewerAuthorization, frame: RemoteVerifiedJpegFrame,
    sink: RemotePrivateFrameSink): { sequence: number } {
    const current = this.sessions.authorizeViewer(auth);
    this.synchronizeSession(auth.sessionId);
    if (!sink || sink.connectionId !== auth.transport.connectionId) frameDenied();
    if (this.sink && this.sink !== sink) frameDenied(); // No stream swapping.
    const now = this.now();
    if (this.pending && now - this.pending.sentAt >= REMOTE_FRAME_ACK_TIMEOUT_MS) {
      this.sessions.terminate();
      throw new RemoteLiveDenied("SESSION_DENIED");
    }
    if (this.pending || now - this.lastSentAt < REMOTE_MIN_FRAME_INTERVAL_MS) {
      throw new RemoteLiveDenied("BUSY");
    }
    this.sentInWindow = this.sentInWindow.filter(at => now - at < 60_000);
    if (this.sentInWindow.length >= REMOTE_MAX_FRAMES_PER_MINUTE) {
      throw new RemoteLiveDenied("BUSY");
    }
    if (!isFrame(frame, now) || !exactRemoteWindow(current.window, frame.window) ||
        frame.capturedAtMs <= this.lastCaptureAt) {
      this.sessions.terminate(); // Uncertain capture or target => fail closed.
      frameDenied();
    }
    let buffered: number;
    try { buffered = sink.bufferedBytes(); }
    catch {
      this.sessions.terminate();
      throw new RemoteLiveDenied("TRANSPORT_DENIED");
    }
    if (!Number.isSafeInteger(buffered) || buffered > REMOTE_MAX_SINK_BUFFERED_BYTES ||
        buffered < 0) {
      this.sessions.terminate(); // No buffering behind a slow/unknown viewer.
      throw new RemoteLiveDenied("TRANSPORT_DENIED");
    }
    const sequence = this.sequence + 1;
    const packet: RemoteFramePacket = {
      version: 1, type: "frame", sequence, format: "jpeg",
      width: frame.width, height: frame.height,
      capturedAtMs: frame.capturedAtMs, jpeg: frame.jpeg,
    };
    // Authorize immediately before the synchronous direct private write.
    this.sessions.authorizeViewer(auth);
    let written = false;
    try { written = sink.sendBinary(packet) === true; }
    catch { /* Transport implementation detail must not leave this boundary. */ }
    if (!written) {
      this.sessions.terminate();
      throw new RemoteLiveDenied("TRANSPORT_DENIED");
    }
    // The sink must not re-enter and revoke while writing.
    this.sessions.authorizeViewer(auth);
    this.sink = sink;
    this.sequence = sequence;
    this.pending = { sequence, sentAt: now };
    this.lastSentAt = now;
    this.lastCaptureAt = frame.capturedAtMs;
    this.sentInWindow.push(now);
    return { sequence };
  }

  /**
   * The ONLY accepted inbound wire message is an ACK. Unknown control,
   * pointer, keyboard, clipboard, file, or resize messages revoke the stream.
   */
  receiveViewerMessage(auth: RemoteViewerAuthorization, raw: unknown): { acknowledged: number } {
    this.sessions.authorizeViewer(auth);
    this.synchronizeSession(auth.sessionId);
    const input = raw as Record<string, unknown> | null;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 3 ||
        input.version !== 1 || input.type !== "ack" ||
        !Number.isSafeInteger(input.sequence) ||
        !this.pending || input.sequence !== this.pending.sequence) {
      this.sessions.terminate();
      frameDenied();
    }
    if (this.now() - this.pending.sentAt >= REMOTE_FRAME_ACK_TIMEOUT_MS) {
      this.sessions.terminate();
      throw new RemoteLiveDenied("SESSION_DENIED");
    }
    const sequence = this.pending.sequence;
    this.pending = null;
    return { acknowledged: sequence };
  }

  /** Trusted server-side disconnect handler; never route this from client JSON. */
  onTransportDisconnected(): void {
    this.sessions.terminate();
    this.pending = null;
    this.sink = null;
  }
}
