import { describe, expect, it } from "vitest";
import { delegateTargetId, managedTargetId, parseBrowserTargetId } from "../src/core/browserTransport/targetIdentity.js";
import { getBrowserTransport, resolveBrowserTransport } from "../src/core/browserTransport/router.js";
import { ManagedCdpTransport } from "../src/core/browserTransport/managedCdpTransport.js";
import { DelegateCdpHostTransport } from "../src/core/delegate/cdpTransport.js";
import { assertDelegateCdpMethodAllowed, assertDelegateUrlAllowed } from "../src/core/browserTransport/delegateCdpPolicy.js";
import { browserCommandSupported } from "../src/core/browserTransport/commandCapabilities.js";

describe("BrowserTransport target identity and routing", () => {
  it("round-trips backend-qualified target IDs", () => {
    expect(parseBrowserTargetId(managedTargetId(9222, "ABC_123"))).toEqual({
      kind: "managed", connectionId: "9222", targetId: "ABC_123",
    });
    expect(parseBrowserTargetId(delegateTargetId("chrome-work-001", 481))).toEqual({
      kind: "delegate", connectionId: "chrome-work-001", targetId: "tab:481", tabId: 481,
    });
  });

  it("keeps omitted transport managed but honors qualified Delegate targets", () => {
    expect(resolveBrowserTransport({ command: "list_targets" })).toBe("managed");
    expect(resolveBrowserTransport({
      command: "navigate", targetId: "delegate:chrome-work-001:481",
    })).toBe("delegate");
    expect(resolveBrowserTransport({
      command: "navigate", transport: "delegate", delegateClientId: "chrome-work-001", delegateTabId: 481,
    })).toBe("delegate");
  });

  it("allows auto discovery but fails closed for ambiguous mutations", () => {
    expect(resolveBrowserTransport({ command: "list_targets", transport: "auto" })).toBe("auto");
    expect(() => resolveBrowserTransport({ command: "navigate", transport: "auto" }))
      .toThrow(/cannot choose a mutation backend/i);
  });

  it("exposes concrete BrowserTransport adapters for both backends", async () => {
    const managed = getBrowserTransport("managed");
    const delegate = getBrowserTransport("delegate");
    expect(managed).toBeInstanceOf(ManagedCdpTransport);
    expect(delegate).toBeInstanceOf(DelegateCdpHostTransport);
    expect(managed.kind).toBe("managed");
    expect(delegate.kind).toBe("delegate");
    await expect(managed.capabilities()).resolves.toMatchObject({ rawCdp: true, cookies: true });
    await expect(delegate.capabilities()).resolves.toMatchObject({ rawCdp: false, cookies: false });
  });

  it("enforces Delegate capability and raw-CDP policy", () => {
    expect(browserCommandSupported("delegate", "read_page")).toBe(true);
    expect(browserCommandSupported("delegate", "move_cursor")).toBe(true);
    expect(browserCommandSupported("delegate", "drag_and_drop")).toBe(true);
    expect(browserCommandSupported("delegate", "emulate_device")).toBe(true);
    expect(browserCommandSupported("delegate", "get_cookies")).toBe(false);
    expect(browserCommandSupported("delegate", "drag_and_drop")).toBe(true);
    expect(browserCommandSupported("delegate", "emulate_device")).toBe(true);
    expect(browserCommandSupported("delegate", "execute_terminal")).toBe(false);
    expect(assertDelegateCdpMethodAllowed("Page.captureScreenshot")).toBe("read");
    expect(() => assertDelegateCdpMethodAllowed("Network.getCookies")).toThrow(/denied/i);
    expect(() => assertDelegateCdpMethodAllowed("Runtime.evaluate")).toThrow(/requires/i);
    expect(assertDelegateCdpMethodAllowed("Runtime.evaluate", { trustedGenerated: true })).toBe("read");
    expect(assertDelegateCdpMethodAllowed("Runtime.evaluate", { dangerousApproved: true })).toBe("write");
    expect(() => assertDelegateUrlAllowed("chrome://settings")).toThrow(/privileged/i);
    expect(() => assertDelegateUrlAllowed("chrome-extension://abc/page.html")).toThrow(/privileged/i);
    expect(() => assertDelegateUrlAllowed("https://example.com")).not.toThrow();
  });
});
