/**
 * Native-host-only composition for a private Desktop Live viewer and its
 * separately approved semantic controller.
 *
 * No HTTP, MCP, Tray WebView, public tunnel, generic screen/control endpoint,
 * process launch or implicit certificate provisioning. Construct this only
 * inside the attended OS host after independently verifying exact-window
 * capture, native approval proofs, a pinned mTLS viewer and a nativeRef-only
 * accessibility binding. The host must deliver viewer credentials out-of-band.
 */
import {
  RemotePrivateHostTlsListener,
  type PrivateHostStarted,
} from "./remotePrivateHostTlsListener.js";
import type { RemoteHostIntent } from "./remoteSessionPolicy.js";
import { AttendedNativeControllerSession } from "./attendedNativeControllerSession.js";
import { RemotePrivateHostOperator } from "./remotePrivateOperator.js";

export interface AttendedPrivateHostComponents {
  readonly listener: RemotePrivateHostTlsListener;
  readonly controller: AttendedNativeControllerSession;
  readonly operator: RemotePrivateHostOperator;
}
export interface AttendedPrivateHostStart {
  readonly nativeWindow: RemoteHostIntent;
  readonly nativeRemoteProof: string;
  readonly localPreviewToken: string;
}

/** One installed native window: a failed start, TLS close, stop or physical
 * takeover makes the entire composition terminal. Never auto-reconnect.
 */
export class AttendedPrivateDesktopHostSession {
  private readonly listener: RemotePrivateHostTlsListener;
  private readonly controller: AttendedNativeControllerSession;
  private readonly operator: RemotePrivateHostOperator;
  private starting = false;
  private started = false;
  private ended = false;

  constructor(components: AttendedPrivateHostComponents) {
    const {listener, controller, operator} = components || {};
    if (!listener || !controller || !operator ||
        typeof listener.registerControllerEndHook !== "function" ||
        typeof listener.start !== "function" ||
        typeof listener.stop !== "function" ||
        typeof controller.humanTakeover !== "function" ||
        typeof controller.viewerDisconnected !== "function" ||
        typeof operator.registerStopHook !== "function" ||
        typeof operator.registerControllerStopHook !== "function" ||
        listener.isStopped || controller.isClosed) {
      throw Error("PRIVATE_DESKTOP_HOST_NOT_ATTESTED");
    }
    this.listener=listener;
    this.controller=controller;
    this.operator=operator;
    try {
      // Register all terminal revocations before opening ANY mTLS socket.
      // Physical takeover calls input before viewer. A viewer-side socket
      // close calls input revocation even when no operator UI is visible.
      operator.registerControllerStopHook(controller);
      operator.registerStopHook(listener);
      listener.registerControllerEndHook(controller);
    } catch {
      // A partially wired host must never be allowed to start a private
      // viewer or native controller. Operator hooks are one-shot only.
      this.terminate();
      throw Error("PRIVATE_DESKTOP_HOST_REGISTRATION_FAILED");
    }
  }

  /** Host IPC only, with independently attended viewer consent. */
  async start(raw: AttendedPrivateHostStart): Promise<PrivateHostStarted> {
    if (this.starting || this.started || this.isStopped)
      throw Error("PRIVATE_DESKTOP_HOST_START_DENIED");
    this.starting = true;
    try {
      const result = await this.listener.start(raw);
      if (this.isStopped) throw Error("PRIVATE_DESKTOP_HOST_STOPPED_DURING_START");
      this.started = true;
      return result;
    } catch {
      this.terminate();
      throw Error("PRIVATE_DESKTOP_HOST_START_FAILED");
    } finally { this.starting = false; }
  }

  /** Native user can end the exact window session without killing the app.
   * Both permission families are cancelled before any private viewer drain.
   */
  humanTakeover(): void { this.terminate(); }
  stop(): void { this.terminate(); }

  get isStopped(): boolean {
    return this.ended || this.controller.isClosed || this.listener.isStopped;
  }
  get isViewing(): boolean { return !this.isStopped && this.listener.isViewing; }

  private terminate(): void {
    if (this.ended) return;
    this.ended=true;
    try { this.operator.humanTakeover(); }
    finally {
      // Even an unexpected hook failure cannot leave native control active.
      try { this.controller.humanTakeover(); }
      finally { this.listener.stop(); }
    }
  }
}
