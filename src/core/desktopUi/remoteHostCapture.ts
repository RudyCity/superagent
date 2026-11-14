/**
 * Private host-to-viewer capture bridge. Not a network handler or a new
 * approval path: the Tray must already have started a native-proof-guarded
 * local preview, and RemoteLiveSessionPolicy must already have verified both
 * attended host consent and the independently authenticated viewer.
 *
 * Integration: construct only in trusted host code, passing the local preview
 * token in-process. Never serialize the bridge, token or viewer authorization,
 * and never forward the local preview bearer through a browser or tunnel.
 * Pass capture() results directly to RemoteViewerFrameGate.offer(), whose
 * authenticated private sink enforces ACK, backpressure and per-frame checks.
 */
import { NativeWindowPreviewManager, type NativeRemotePreviewLease } from "./livePreview.js";
import { exactRemoteWindow, RemoteLiveDenied, RemoteLiveSessionPolicy } from "./remoteSessionPolicy.js";
import {
  REMOTE_MAX_FRAME_BYTES, REMOTE_MAX_FRAMES_PER_MINUTE, REMOTE_MIN_FRAME_INTERVAL_MS,
  type RemoteVerifiedJpegFrame, type RemoteViewerAuthorization,
} from "./remoteViewerFrames.js";

const MAX_BASE64_JPEG_LENGTH = Math.ceil(REMOTE_MAX_FRAME_BYTES / 3) * 4;
const REMOTE_CAPTURE_MAX_AGE_MS = 5_000;

function deny(): never {
  throw new RemoteLiveDenied("SESSION_DENIED");
}

/** One host-only lease per local preview; no bearer or capture source escapes. */
export class RemoteHostCaptureBridge {
  #closed = false;
  #capturing = false;
  #lastCaptureStart = Number.NEGATIVE_INFINITY;
  #lastTimestamp = Number.NEGATIVE_INFINITY;
  #recentCaptures: number[] = [];

  #lease: NativeRemotePreviewLease;
  #sessions: RemoteLiveSessionPolicy;
  #viewer: RemoteViewerAuthorization;
  #now: () => number;

  private constructor(
    lease: NativeRemotePreviewLease,
    sessions: RemoteLiveSessionPolicy,
    viewer: RemoteViewerAuthorization,
    now: () => number,
  ) {
    this.#lease = lease;
    this.#sessions = sessions;
    this.#viewer = viewer;
    this.#now = now;
  }

  /**
   * Call only after the existing private Tray native-preview challenge has
   * been consumed and RemoteLiveSessionPolicy.attachViewer() has succeeded.
   * The policy, not caller-supplied identity fields, supplies the exact pin.
   */
  static claim(
    manager: NativeWindowPreviewManager,
    localPreviewToken: string,
    sessions: RemoteLiveSessionPolicy,
    viewer: RemoteViewerAuthorization,
    now: () => number = Date.now,
  ): RemoteHostCaptureBridge {
    const approved = sessions.authorizeViewer(viewer);
    if (!Number.isSafeInteger(approved.expiresAt) || now() >= approved.expiresAt) deny();
    try {
      const lease = manager.claimRemoteHostCapture(localPreviewToken, approved.window);
      return new RemoteHostCaptureBridge(lease, sessions, viewer, now);
    } catch {
      sessions.terminate();
      return deny();
    }
  }

  private verifyOwnership(): void {
    if (this.#closed) deny();
    const active = this.#sessions.authorizeViewer(this.#viewer);
    if (!exactRemoteWindow(active.window, this.#lease.window) ||
        !Number.isSafeInteger(active.expiresAt) || this.#now() >= active.expiresAt) deny();
  }

  async capture(): Promise<RemoteVerifiedJpegFrame> {
    // A denied/busy caller must not consume the native capture budget.
    try { this.verifyOwnership(); }
    catch {
      this.close();
      return deny();
    }
    const startedAt = this.#now();
    if (this.#capturing || startedAt - this.#lastCaptureStart < REMOTE_MIN_FRAME_INTERVAL_MS) {
      throw new RemoteLiveDenied("BUSY");
    }
    const recent = this.#recentCaptures.filter(at => startedAt - at < 60_000);
    if (recent.length >= REMOTE_MAX_FRAMES_PER_MINUTE) {
      throw new RemoteLiveDenied("BUSY");
    }
    this.#capturing = true;
    this.#lastCaptureStart = startedAt;
    this.#recentCaptures = recent;
    try {
      // The lease delegates to the existing exact-window native worker and
      // preview encoder. No screenshot, window or monitor fallback exists here.
      const raw = await this.#lease.captureJpeg();
      this.verifyOwnership(); // Host stop/revocation can race asynchronous capture/encode.
      if (!raw || typeof raw.jpeg !== "string" ||
          raw.jpeg.length < 8 || raw.jpeg.length > MAX_BASE64_JPEG_LENGTH ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.jpeg) ||
          !Number.isSafeInteger(raw.width) || !Number.isSafeInteger(raw.height) ||
          raw.width < 1 || raw.height < 1 || raw.width > 1920 || raw.height > 1920 ||
          raw.width * raw.height > 2_073_600) deny();
      const jpeg = Buffer.from(raw.jpeg, "base64");
      if (jpeg.byteLength < 4 || jpeg.byteLength > REMOTE_MAX_FRAME_BYTES ||
          jpeg.toString("base64") !== raw.jpeg ||
          jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
          jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) deny();
      const capturedAtMs = Date.parse(raw.capturedAt);
      const releasedAt = this.#now();
      if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs <= this.#lastTimestamp ||
          capturedAtMs < releasedAt - REMOTE_CAPTURE_MAX_AGE_MS ||
          capturedAtMs > releasedAt + 1_000) deny();
      this.verifyOwnership();
      this.#lastTimestamp = capturedAtMs;
      this.#recentCaptures.push(startedAt);
      return { jpeg, width: raw.width, height: raw.height, capturedAtMs,
        window: { ...this.#lease.window, bounds: { ...this.#lease.window.bounds } } };
    } catch {
      // Any uncertain native identity, source, permission, age or revocation
      // closes the approved remote session, not the unrelated local preview.
      this.close();
      return deny();
    } finally {
      this.#capturing = false;
    }
  }

  /** Host-only stop/disconnect/revoke handler; idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#lease.close(); }
    catch { /* Closing a native source is best-effort, never block revocation. */ }
    finally { this.#sessions.terminate(); }
  }
}
