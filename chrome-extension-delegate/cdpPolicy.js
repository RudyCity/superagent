"use strict";

(() => {
  const READ = new Set([
    "Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Log.enable", "Accessibility.enable",
    "Page.getFrameTree", "Page.getLayoutMetrics", "Page.captureScreenshot",
    "Accessibility.getFullAXTree", "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.getBoxModel",
    "Runtime.evaluate",
  ]);
  const WRITE = new Set([
    "Page.navigate", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "DOM.focus",
    "Page.handleJavaScriptDialog", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
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
    const value = String(url || "").trim().toLowerCase();
    return /^(chrome|chrome-extension|devtools|edge|file):/.test(value) ||
      (value.startsWith("about:") && value !== "about:blank");
  }

  function assertUrl(url) {
    if (privileged(url)) {
      fail("DELEGATE_CDP_PRIVILEGED_URL_DENIED",
        "Delegate-CDP cannot control browser internal, extension, DevTools, or file pages.");
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

  globalThis.DelegateCdpPolicy = Object.freeze({ privileged, assertUrl, classify });
})();
