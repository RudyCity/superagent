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
import type { RemotePrivateControllerTlsHost } from "./remotePrivateControllerTls.js";

export interface AttendedPrivateHostComponents {
  readonly listener: RemotePrivateHostTlsListener;
  readonly controller: AttendedNativeControllerSession;
  readonly operator: RemotePrivateHostOperator;
  /** Installed native-host-only factory, not callable from remote messages. */
  readonly createControllerTlsHost?: (approvedViewer: PrivateHostStarted) => RemotePrivateControllerTlsHost;
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
  private approvedViewer: PrivateHostStarted | null = null;
  private controlHost: RemotePrivateControllerTlsHost | null = null;
  private readonly createControllerTlsHost:
    ((approvedViewer: PrivateHostStarted) => RemotePrivateControllerTlsHost) | null;

  constructor(components: AttendedPrivateHostComponents) {
    if (!components) throw Error("PRIVATE_DESKTOP_HOST_NOT_ATTESTED");
    const {listener, controller, operator} = components;
    if (!listener || !controller || !operator ||
        typeof listener.registerControllerEndHook !== "function" ||
        typeof listener.start !== "function" ||
        typeof listener.stop !== "function" ||
        typeof controller.humanTakeover !== "function" ||
        typeof controller.viewerDisconnected !== "function" ||
        typeof operator.registerNativeHost !== "function" ||
        listener.isStopped || controller.isClosed) {
      throw Error("PRIVATE_DESKTOP_HOST_NOT_ATTESTED");
    }
    this.listener=listener;
    this.controller=controller;
    this.operator=operator;
    this.createControllerTlsHost=components.createControllerTlsHost??null;
    if(this.createControllerTlsHost && typeof this.createControllerTlsHost!=="function")
      throw Error("PRIVATE_DESKTOP_HOST_INVALID_CONTROLLER_FACTORY");
    try {
      // Register all terminal revocations before opening ANY mTLS socket.
      // Physical takeover calls input before viewer. A viewer-side socket
      // close calls input revocation even when no operator UI is visible.
      listener.registerControllerEndHook({
        viewerDisconnected:()=>{
          // A vanished viewer invalidates native input *and* the separately
          // provisioned control socket before any further OS action.
          try {controller.viewerDisconnected();}
          finally{this.controlHost?.stop();}
        },
      });
      operator.registerNativeHost(listener, controller);
    } catch {
      // Listener has never started. Stop only this rejected candidate; never
      // revoke an unrelated host already registered with the operator.
      try { controller.humanTakeover(); } finally { listener.stop(); }
      this.ended = true;
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
      this.approvedViewer = result;
      return result;
    } catch {
      this.terminate();
      throw Error("PRIVATE_DESKTOP_HOST_START_FAILED");
    } finally { this.starting = false; }
  }

  /** Host-only opt-in, only AFTER the independently approved viewer is
   * actively authenticated and receiving its exact-window stream. Never
   * start an input listener just because a preview token exists.
   */
  async startController():Promise<{address:string;port:number;expiresAt:number}>{
    if(!this.approvedViewer||!this.started||this.isStopped||
       !this.listener.isViewing||!this.createControllerTlsHost||
       this.controlHost)throw Error("PRIVATE_DESKTOP_CONTROLLER_NOT_READY");
    let host:RemotePrivateControllerTlsHost|null=null;
    try{
      host=this.createControllerTlsHost(this.approvedViewer);
      if(!host||typeof host.start!=="function"||typeof host.stop!=="function")
        throw Error("PRIVATE_DESKTOP_CONTROLLER_INVALID_HOST");
      this.controlHost=host;
      const started=await host.start();
      if(this.isStopped||!this.listener.isViewing)throw Error("VIEWER_DISCONNECTED_DURING_CONTROLLER_START");
      return started;
    }catch{
      try{host?.stop();}catch{}
      this.terminate();
      throw Error("PRIVATE_DESKTOP_CONTROLLER_START_FAILED");
    }
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
    try {
      // The atomic operator registration already revokes the native input
      // controller BEFORE terminating the viewer, exactly once.
      this.operator.humanTakeover();
    } catch {
      // Defensive fallback for an unexpected operator implementation failure.
      try { this.controller.humanTakeover(); }
      finally { try{this.controlHost?.stop();}finally{this.listener.stop();} }
    }
  }
}
