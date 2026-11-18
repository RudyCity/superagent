"use strict";

(() => {
  const READ = new Set([
    "Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Log.enable", "Accessibility.enable",
    "Page.getFrameTree", "Page.getLayoutMetrics", "Page.captureScreenshot",
    "Accessibility.getFullAXTree", "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.getBoxModel", "DOM.describeNode",
    "Runtime.evaluate",
  ]);
  const WRITE = new Set([
    "Page.navigate", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "DOM.focus",
    "Page.handleJavaScriptDialog", "Page.setInterceptFileChooserDialog", "DOM.setFileInputFiles", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
  ]);
  const DENIED = new Set([
    "Network.getAllCookies", "Network.getCookies", "Network.setCookie", "Network.setCookies",
    "Network.deleteCookies", "Storage.clearDataForOrigin", "Target.setAutoAttach", "Target.closeTarget",
    "Browser.setDownloadBehavior",
  ]);
  const DENIED_PREFIX = ["Browser.", "Storage.", "Security.", "SystemInfo."];

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }

  function privileged(url) {
    const value = String(url || "").trim();
    if (value === "about:blank") return false; // Only an empty, non-file page.
    try {
      const parsed = new URL(value);
      return !((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname);
    } catch {
      return true;
    }
  }

  function assertUrl(url) {
    if (privileged(url)) {
      fail("DELEGATE_CDP_PRIVILEGED_URL_DENIED",
        "Delegate-CDP cannot control browser internal, extension, DevTools, or file pages.");
    }
  }

  function assertCertifiedWebUrl(url) {
    // Defense in depth for TOCTOU: recheck actual chrome.tabs.get URL immediately
    // before each command from a certified MCP web workflow. Never rely only on
    // Core's earlier inventory or the requested navigation URL.
    const value = String(url || "").trim();
    let parsed;
    try { parsed = new URL(value); }
    catch { fail("DELEGATE_WEB_TARGET_NOT_PUBLIC_HTTP", "Certified web action requires a public web page."); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      fail("DELEGATE_WEB_TARGET_NOT_PUBLIC_HTTP", "Certified web action requires HTTP(S).");
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (parsed.username || parsed.password || !host.includes(".") || host.includes(":") ||
        /^[0-9.]+$/.test(host) || host === "localhost" ||
        host.endsWith(".localhost") || host.endsWith(".local") ||
        host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid")) {
      fail("DELEGATE_WEB_TARGET_NOT_PUBLIC_HTTP", "Private and local web origins require separate authorization.");
    }
  }

  function classify(method, meta = {}) {
    if (!method || DENIED.has(method) || DENIED_PREFIX.some((prefix) => method.startsWith(prefix))) {
      fail("DELEGATE_CDP_METHOD_DENIED", "CDP method is denied by Delegate-CDP policy: " + method);
    }
    if (method === "Runtime.evaluate") {
      if (!meta.trustedGenerated && !meta.dangerousApproved) {
        fail("DELEGATE_CDP_EVALUATE_APPROVAL_REQUIRED",
          "Arbitrary Runtime.evaluate is allowed only through the audited dangerous high-level evaluate path.");
      }
      return meta.trustedGenerated ? "read" : "write";
    }
    if (READ.has(method)) return "read";
    if (WRITE.has(method) || method.startsWith("Emulation.")) return "write";
    fail("DELEGATE_CDP_METHOD_UNSUPPORTED", "CDP method is not in the Delegate-CDP v1.8 allowlist: " + method);
  }

  globalThis.DelegateCdpPolicy = Object.freeze({ privileged, assertUrl, assertCertifiedWebUrl, classify });
})();
