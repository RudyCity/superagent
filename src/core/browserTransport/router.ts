import { BrowserTransportError, type BrowserTransport, type BrowserTransportKind, type BrowserTransportSelection } from "./types.js";
import { parseBrowserTargetId } from "./targetIdentity.js";
import { managedCdpTransport } from "./managedCdpTransport.js";
import { delegateCdpTransport } from "./delegateCdpTransport.js";

export interface BrowserRouteInput {
  transport?: BrowserTransportSelection;
  targetId?: string;
  delegateClientId?: string;
  delegateTabId?: number;
  command: string;
}

const DISCOVERY = new Set(["list_targets", "transport_status", "list_sessions", "coordinator_status"]);

export function resolveBrowserTransport(input: BrowserRouteInput): "managed" | "delegate" | "auto" {
  const qualified = input.targetId ? parseBrowserTargetId(input.targetId) : null;
  if (qualified) return qualified.kind;
  if (input.transport === "managed" || input.transport === "delegate") return input.transport;
  if (input.delegateClientId || input.delegateTabId !== undefined) return "delegate";
  if (input.transport === "auto") {
    if (DISCOVERY.has(input.command)) return "auto";
    throw new BrowserTransportError(
      "BROWSER_TRANSPORT_AMBIGUOUS",
      "transport=auto cannot choose a mutation backend without a qualified target, active backend session, or explicit Delegate client/tab."
    );
  }
  return "managed";
}

export function getBrowserTransport(kind: BrowserTransportKind): BrowserTransport {
  return kind === "delegate" ? delegateCdpTransport : managedCdpTransport;
}
