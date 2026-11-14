/**
 * Host-owned binding between an approved native exact-window frame source and
 * a separately authenticated private viewer. No HTTP route, socket listener,
 * token minting, native approval bypass, or input functionality lives here.
 *
 * Lifecycle owner MUST call humanTakeover/hostStop/transportDisconnected and
 * construct a new orchestrator for every independently approved host session.
 */
import { RemoteLiveDenied, RemoteLiveSessionPolicy, exactRemoteWindow,
  type RemoteWindowPin } from "./remoteSessionPolicy.js";
import { RemoteViewerFrameGate, type RemotePrivateFrameSink,
  type RemoteVerifiedJpegFrame, type RemoteViewerAuthorization } from "./remoteViewerFrames.js";

export interface RemoteApprovedHostFrameSource {
  /** Must perform fresh OS-level identity checks immediately around capture. */
  captureExactWindow(pinned: Readonly<RemoteWindowPin>): Promise<RemoteVerifiedJpegFrame>;
  /** Idempotent, synchronous best-effort shutdown of the native capture worker. */
  close(): void;
}

export class RemoteLiveFrameOrchestrator {
  private stopped = false;
  private capturing = false;

  constructor(
    private readonly sessions: RemoteLiveSessionPolicy,
    private readonly gate: RemoteViewerFrameGate,
    private readonly host: RemoteApprovedHostFrameSource,
  ) {}

  private stopNative(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.host.close(); } catch { /* A revoked session must remain closed. */ }
  }

  private revoke(): void {
    this.stopNative();
    this.sessions.terminate();
  }

  /**
   * Once the host has separately approved its exact window and the viewer
   * has completed its TLS-bound proof, send at most one unqueued JPEG.
   * Capture is always private-host initiated, never a remote screenshot API.
   */
  async offerNextFrame(
    auth: Readonly<RemoteViewerAuthorization>,
    sink: RemotePrivateFrameSink,
  ): Promise<{ sequence: number }> {
    if (this.stopped) throw new RemoteLiveDenied("SESSION_DENIED");
    if (this.capturing) throw new RemoteLiveDenied("BUSY");
    const { window } = this.sessions.authorizeViewer(auth);
    if (!sink || sink.connectionId !== auth.transport.connectionId)
      throw new RemoteLiveDenied("TRANSPORT_DENIED");

    this.capturing = true;
    try {
      let frame: RemoteVerifiedJpegFrame;
      try {
        frame = await this.host.captureExactWindow(window);
      } catch {
        // Do not leak OS window names or screenshot/capture exceptions.
        this.revoke();
        throw new RemoteLiveDenied("SESSION_DENIED");
      }
      if (this.stopped) throw new RemoteLiveDenied("SESSION_DENIED");
      // Revocation, takeover, timeout, or TLS disconnect during await must
      // prevent a screenshot from escaping the host.
      const current = this.sessions.authorizeViewer(auth);
      if (!exactRemoteWindow(current.window, window) ||
          !frame || !exactRemoteWindow(window, frame.window)) {
        this.revoke();
        throw new RemoteLiveDenied("SESSION_DENIED");
      }
      try {
        return this.gate.offer(auth, frame, sink);
      } catch (error) {
        // BUSY is the expected backpressure/rate-limit result; all other
        // failures mean a potentially unsafe or revoked session.
        if (!(error instanceof RemoteLiveDenied) || error.code !== "BUSY")
          this.revoke();
        throw error;
      }
    } finally {
      this.capturing = false;
    }
  }

  /** Private socket ACK only; never accepts click/keyboard/clipboard input. */
  receiveViewerAck(auth: Readonly<RemoteViewerAuthorization>, raw: unknown): { acknowledged: number } {
    if (this.stopped) throw new RemoteLiveDenied("SESSION_DENIED");
    try {
      return this.gate.receiveViewerMessage(auth, raw);
    } catch (error) {
      this.revoke();
      throw error;
    }
  }

  /** Host-only authenticated stop. Does not accept a remote JSON command. */
  hostStop(receipt: { sessionId: string; hostToken: string }): void {
    if (this.stopped) throw new RemoteLiveDenied("SESSION_DENIED");
    this.sessions.revokeByHost(receipt);
    this.stopNative();
  }

  /** Trusted socket close or network-loss callback, never inferred from client JSON. */
  transportDisconnected(): void {
    this.stopNative();
    this.gate.onTransportDisconnected();
  }

  /** Synchronous host user takeover revokes view as well as future frame calls. */
  humanTakeover(): void {
    this.revoke();
  }

  get isStopped(): boolean { return this.stopped; }
}
