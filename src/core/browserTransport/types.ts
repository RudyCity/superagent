export type BrowserTransportKind = "managed" | "delegate";
export type BrowserTransportSelection = BrowserTransportKind | "auto";

export interface BrowserConnectionRef {
  kind: BrowserTransportKind;
  connectionId: string;
}

export interface BrowserTargetRef {
  kind: BrowserTransportKind;
  connectionId: string;
  targetId: string;
  tabId?: number;
  title?: string;
  url?: string;
}

export interface BrowserTransportCapabilities {
  commands: readonly string[];
  rawCdp: boolean;
  cookies: boolean;
  privilegedUrls: boolean;
}

export interface BrowserTransportHealth {
  ok: boolean;
  kind: BrowserTransportKind;
  connectionId: string;
  detail?: string;
}

export class BrowserTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserTransportError";
  }
}

export interface BrowserTransport {
  readonly kind: BrowserTransportKind;
  listTargets(connectionId?: string, signal?: AbortSignal): Promise<BrowserTargetRef[]>;
  attach(target: BrowserTargetRef, signal?: AbortSignal): Promise<void>;
  detach(target: BrowserTargetRef, signal?: AbortSignal): Promise<void>;
  command(target: BrowserTargetRef, method: string, params?: Record<string, unknown>, signal?: AbortSignal, policy?: { trustedGenerated?: boolean; dangerousApproved?: boolean }): Promise<unknown>;
  capabilities(): Promise<BrowserTransportCapabilities>;
  health(connectionId?: string, signal?: AbortSignal): Promise<BrowserTransportHealth>;
}
