import { BrowserTransportError } from "./types.js";

const READ_METHODS = new Set([
  "Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Log.enable", "Accessibility.enable",
  "Page.getFrameTree", "Page.getLayoutMetrics", "Page.captureScreenshot",
  "Accessibility.getFullAXTree", "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.getBoxModel",
  "Runtime.evaluate",
]);
const WRITE_METHODS = new Set([
  "Page.navigate", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "DOM.focus",
  "Page.handleJavaScriptDialog", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
]);
const DENIED_EXACT = new Set([
  "Network.getAllCookies", "Network.getCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies",
  "Storage.clearDataForOrigin", "Target.setAutoAttach", "Target.closeTarget", "Browser.setDownloadBehavior",
]);
const DENIED_PREFIXES = ["Browser.", "Storage.", "Security.", "SystemInfo."];

export function isDelegatePrivilegedUrl(url: string): boolean {
  const value = String(url || "").trim().toLowerCase();
  return /^(chrome|chrome-extension|devtools|edge|about|file):/.test(value);
}

export function assertDelegateUrlAllowed(url: string): void {
  if (isDelegatePrivilegedUrl(url)) {
    throw new BrowserTransportError("DELEGATE_CDP_PRIVILEGED_URL_DENIED", "Delegate-CDP cannot control privileged browser, extension, DevTools, file, or internal pages.");
  }
}

export function assertDelegateCdpMethodAllowed(method: string, opts: { trustedGenerated?: boolean; dangerousApproved?: boolean } = {}): "read" | "write" {
  if (!method || DENIED_EXACT.has(method) || DENIED_PREFIXES.some(prefix => method.startsWith(prefix))) {
    throw new BrowserTransportError("DELEGATE_CDP_METHOD_DENIED", `CDP method '${method}' is denied by Delegate-CDP policy.`);
  }
  if (method === "Runtime.evaluate") {
    if (!opts.trustedGenerated && !opts.dangerousApproved) {
      throw new BrowserTransportError("DELEGATE_CDP_EVALUATE_APPROVAL_REQUIRED", "Arbitrary Runtime.evaluate requires the audited dangerous high-level evaluate path.");
    }
    return opts.trustedGenerated ? "read" : "write";
  }
  if (READ_METHODS.has(method)) return "read";
  if (WRITE_METHODS.has(method) || method.startsWith("Emulation.")) return "write";
  throw new BrowserTransportError("DELEGATE_CDP_METHOD_UNSUPPORTED", `CDP method '${method}' is not in the Delegate-CDP v1.8 allowlist.`);
}
