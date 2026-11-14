/**
 * Desktop Live host-operator boundary. Unlike a successful LOCAL preview, a
 * remote viewer needs a separately provisioned mTLS 1.3 server, a pinned
 * client certificate and fresh attended native approval. No such provisioning
 * is reachable through Core HTTP, the Tray WebView or a public tunnel.
 *
 * Current host build deliberately reports NOT_CONFIGURED instead of creating
 * a listener, distributing a viewer credential or claiming remote readiness.
 * The stop hook may be bound by trusted in-process integration only; it is
 * never a way to start, authorize or enumerate remote sessions.
 */
import type { RemotePrivateLiveRuntime } from "./remotePrivateLiveRuntime.js";

export const PRIVATE_OPERATOR_STATE = "NOT_CONFIGURED" as const;

export interface PrivateOperatorStatus {
  readonly state: typeof PRIVATE_OPERATOR_STATE;
  readonly viewAvailable: false;
  readonly inputAvailable: false;
  readonly viewerCertificateSha256: null;
  readonly activeViewer: false;
  readonly approvalAvailable: false;
  readonly leaseSeconds: 0;
  readonly blockers: readonly string[];
}

const BLOCKERS = Object.freeze([
  "Independent host mTLS 1.3 listener and private RFC1918 interface are not provisioned.",
  "Pinned viewer certificate and an independently verified private viewer are not provisioned.",
  "Separate native remote-viewer approval and credential handoff are not activated.",
] as const);

export class RemotePrivateHostOperator {
  private runtime: Pick<RemotePrivateLiveRuntime, "humanTakeover"> | null = null;

  /** Internal stop-only handoff; it must NOT carry certificates or preview tokens. */
  registerStopHook(runtime: Pick<RemotePrivateLiveRuntime, "humanTakeover">): void {
    if (!runtime || typeof runtime.humanTakeover !== "function" || this.runtime) {
      throw Error("PRIVATE_HOST_OPERATOR_UNAVAILABLE");
    }
    this.runtime = runtime;
  }

  status(): PrivateOperatorStatus {
    return {
      state: PRIVATE_OPERATOR_STATE,
      viewAvailable: false,
      inputAvailable: false,
      viewerCertificateSha256: null,
      activeViewer: false,
      approvalAvailable: false,
      leaseSeconds: 0,
      blockers: BLOCKERS,
    };
  }

  /** Local operator review is informational until native identity is provisioned. */
  review(): PrivateOperatorStatus { return this.status(); }

  /** Always revoke in-process capture/TLS first; never wait for WebView navigation. */
  humanTakeover(): PrivateOperatorStatus {
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      try { runtime.humanTakeover(); }
      catch { /* Terminal revocation; never restore a potentially live handle. */ }
    }
    return this.status();
  }
}

export const remotePrivateHostOperator = new RemotePrivateHostOperator();
