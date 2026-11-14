/**
 * Trusted host-only lifecycle adapter for a native-approved Desktop Live window
 * and a separately verified private mTLS viewer connection.
 *
 * NO network listener, HTTP/MCP registration, auto-connect or input dispatch.
 * Viewer authentication is handed off synchronously in-process, never sent to
 * browser JavaScript or over the wire. A live, freshly approved Tray preview
 * and a bound private TLS viewer must BOTH already exist.
 */
import { NativeWindowPreviewManager } from "./livePreview.js";
import { RemoteHostCaptureBridge } from "./remoteHostCapture.js";
import { RemotePrivateTransportBridge } from "./remotePrivateTransport.js";
import { RemotePrivateHostStream } from "./remotePrivateHostStream.js";
import { RemoteLiveDenied } from "./remoteSessionPolicy.js";

export class RemotePrivateLiveRuntime {
  private active: RemotePrivateHostStream | null = null;
  private stopped = false;

  constructor(
    private readonly preview: NativeWindowPreviewManager,
    private readonly transport: RemotePrivateTransportBridge,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * PRIVATE native operator action only, after separate host and viewer proof.
   * The localPreviewToken is not passed to the network or returned to a caller.
   * On a claim failure, revoke both scopes rather than retry with a fallback.
   */
  startAfterNativeAndViewerApproval(localPreviewToken: string): void {
    if (this.stopped || this.active) throw new RemoteLiveDenied("SESSION_DENIED");
    if (typeof localPreviewToken !== "string" || !/^[a-f0-9]{64}$/.test(localPreviewToken)) {
      throw new RemoteLiveDenied("CONSENT_REQUIRED");
    }
    let capture: RemoteHostCaptureBridge;
    try {
      capture = this.transport.claimNativeCapture(
        this.preview, localPreviewToken, this.now,
      );
    } catch {
      this.stop();
      throw new RemoteLiveDenied("CONSENT_REQUIRED");
    }
    try {
      this.active = new RemotePrivateHostStream(capture, this.transport);
      this.active.start();
    } catch {
      try { capture.close(); } finally { this.stop(); }
      throw new RemoteLiveDenied("SESSION_DENIED");
    }
  }

  /** Native host-only stop, applied immediately even with an in-flight frame. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const stream = this.active;
    this.active = null;
    if (stream) {
      stream.stop(); // closes capture and TLS transport
    } else {
      this.transport.close(); // revoke even before capture was claimed
    }
  }

  /** Host user takes back control and invalidates all viewer access. */
  humanTakeover(): void { this.stop(); }

  /** Host-owned callback for a private TLS connection closing. */
  transportDisconnected(): void { this.stop(); }

  get isActive(): boolean { return !this.stopped && this.active?.isActive === true; }
  get isStopped(): boolean { return this.stopped; }
}
