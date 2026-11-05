import { BrowserTransportError, type BrowserTargetRef } from "./types.js";

const SAFE_MANAGED_ID = /^[a-zA-Z0-9_-]{1,256}$/;
const SAFE_CLIENT_ID = /^[a-zA-Z0-9_-]{8,80}$/;

export function managedTargetId(port: number, targetId: string): string {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !SAFE_MANAGED_ID.test(targetId)) {
    throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Invalid managed CDP target identity.");
  }
  return `managed:${port}:${targetId}`;
}

export function delegateTargetId(clientId: string, tabId: number): string {
  if (!SAFE_CLIENT_ID.test(clientId) || !Number.isSafeInteger(tabId) || tabId < 1) {
    throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Invalid Delegate target identity.");
  }
  return `delegate:${clientId}:${tabId}`;
}

export function parseBrowserTargetId(value: string): BrowserTargetRef | null {
  if (typeof value !== "string" || value.length > 420) return null;
  const managed = /^managed:(\d{4,5}):([a-zA-Z0-9_-]{1,256})$/.exec(value);
  if (managed) {
    const port = Number(managed[1]);
    if (port < 1024 || port > 65535) return null;
    return { kind: "managed", connectionId: String(port), targetId: managed[2] };
  }
  const delegate = /^delegate:([a-zA-Z0-9_-]{8,80}):(\d{1,10})$/.exec(value);
  if (delegate) {
    const tabId = Number(delegate[2]);
    if (!Number.isSafeInteger(tabId) || tabId < 1) return null;
    return { kind: "delegate", connectionId: delegate[1], targetId: `tab:${tabId}`, tabId };
  }
  return null;
}

export function serializeBrowserTarget(target: BrowserTargetRef): string {
  if (target.kind === "managed") return managedTargetId(Number(target.connectionId), target.targetId);
  if (!target.tabId) throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Delegate target requires tabId.");
  return delegateTargetId(target.connectionId, target.tabId);
}
