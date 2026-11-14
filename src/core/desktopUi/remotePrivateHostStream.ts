/**
 * Host-only continuous frame pump composing an independently authorized native
 * capture bridge with an already authenticated private mTLS viewer transport.
 *
 * No listener, route, public tunnel, secrets, recording or remote input.
 * Construct only after BOTH approvals. The host operator starts/stops this
 * explicitly; every frame independently passes both bridges' checks.
 */
import { RemoteLiveDenied } from "./remoteSessionPolicy.js";
import type { RemoteVerifiedJpegFrame } from "./remoteViewerFrames.js";

export const PRIVATE_HOST_STREAM_INTERVAL_MS = 500;

export interface RemotePrivateHostFrameProducer {
  capture(): Promise<RemoteVerifiedJpegFrame>;
  close(): void;
}

export interface RemotePrivateHostFrameSender {
  offerVerifiedFrame(frame: RemoteVerifiedJpegFrame): { sequence: number };
  close(): void;
}

export class RemotePrivateHostStream {
  private live = false;
  private stopped = false;
  private capturing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frames = 0;

  constructor(
    private readonly native: RemotePrivateHostFrameProducer,
    private readonly viewer: RemotePrivateHostFrameSender,
    private readonly intervalMs = PRIVATE_HOST_STREAM_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 5_000) {
      throw new RemoteLiveDenied("INVALID_REQUEST");
    }
  }

  /** Host/operator only. A viewer message must never call start(). */
  start(): void {
    if (this.stopped || this.live) throw new RemoteLiveDenied("SESSION_DENIED");
    this.live = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.live) return;
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, delay);
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    if (!this.live || this.capturing) return;
    this.capturing = true;
    try {
      const frame = await this.native.capture();
      if (!this.live) return; // Host revocation raced native screenshot.
      const receipt = this.viewer.offerVerifiedFrame(frame);
      if (!this.live || !Number.isSafeInteger(receipt.sequence) ||
          receipt.sequence < 1 || receipt.sequence <= this.frames) {
        this.stop();
        return;
      }
      this.frames = receipt.sequence;
    } catch (error) {
      // A pending ACK or rate budget is benign; all uncertain/identity/transport
      // failures are terminal. Never retry a revoked native permission.
      if (!(error instanceof RemoteLiveDenied) || error.code !== "BUSY") {
        this.stop();
      }
    } finally {
      this.capturing = false;
      if (this.live) this.schedule(this.intervalMs);
    }
  }

  /** Synchronous trusted human takeover or disconnect. Do not re-arm. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.live = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Close both independently; failure to close one must not keep the other.
    try { this.native.close(); } catch { /* Keep revocation irreversible. */ }
    try { this.viewer.close(); } catch { /* Keep revocation irreversible. */ }
  }

  humanTakeover(): void { this.stop(); }

  get isActive(): boolean { return this.live; }
  get isStopped(): boolean { return this.stopped; }
  get deliveredFrames(): number { return this.frames; }
}
