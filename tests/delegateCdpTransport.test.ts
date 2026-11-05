import { afterEach, describe, expect, it, vi } from "vitest";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { delegateCdpTransport } from "../src/core/delegate/cdpTransport.js";

afterEach(() => vi.restoreAllMocks());

describe("host Delegate-CDP transport", () => {
  it("fails clearly when an old Delegate lacks delegate-cdp-v1", async () => {
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([{
      clientId: "chrome-old-001", label: "Old", extensionId: "a".repeat(32),
      extensionVersion: "1.7.0", capabilities: [], connectedAt: Date.now(),
    }]);
    await expect(delegateCdpTransport.listTargets("chrome-old-001"))
      .rejects.toMatchObject({ code: "DELEGATE_CDP_EXTENSION_TOO_OLD" });
  });

  it("routes typed target discovery to exactly one selected client", async () => {
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([{
      clientId: "chrome-new-001", label: "New", extensionId: "a".repeat(32),
      extensionVersion: "1.8.0", capabilities: ["delegate-cdp-v1"], connectedAt: Date.now(),
    }]);
    const request = vi.spyOn(delegateBridge, "request").mockResolvedValue(JSON.stringify([{
      transport: "delegate", clientId: "chrome-new-001", tabId: 44,
      targetId: "delegate:chrome-new-001:44", title: "App", url: "https://example.com/",
    }]));
    const targets = await delegateCdpTransport.listTargets("chrome-new-001");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][4]).toBe("chrome-new-001");
    expect(targets[0]).toEqual(expect.objectContaining({
      kind: "delegate", connectionId: "chrome-new-001", tabId: 44,
    }));
  });
});
