import { describe, expect, it } from "vitest";
import { desktopLiveAccessModes } from "../../src/core/desktopUi/desktopLiveAccessModes.js";

describe("Desktop Live independent viewer and controller permissions", () => {
  it("never promotes local window preview into controller input approval", () => {
    const before = desktopLiveAccessModes("native");
    const after = desktopLiveAccessModes("native", {previewActive:true});
    expect(before.view).toBe("available");
    expect(after.view).toBe("active");
    expect(before.controller).toBe("native-approval-required");
    expect(after.controller).toBe("native-approval-required");
    expect(after.independentlyApproved).toBe(false);
  });

  it("reports paired LAN support separately from device input permission", () => {
    const disconnected = desktopLiveAccessModes("lan-device",{connected:false});
    const connected = desktopLiveAccessModes("lan-device",{connected:true});
    expect(disconnected.view).toBe("not-supported");
    expect(connected.view).toBe("device-approval-required");
    expect(connected.controller).toBe("device-approval-required");
    expect(connected.independentlyApproved).toBe(false);
  });

  it("reports managed CDP ownership without suggesting a screen or OS input grant", () => {
    const agent = desktopLiveAccessModes("managed-cdp",{ownerMode:"agent"});
    const human = desktopLiveAccessModes("managed-cdp",{ownerMode:"human"});
    expect(agent.view).toBe("not-supported");
    expect(human.view).toBe("not-supported");
    expect(agent.controller).toBe("agent-held");
    expect(human.controller).toBe("human-held");
    expect(human.independentlyApproved).toBe(false);
  });

  it("keeps Delegate metadata unrelated to native screen or keyboard permission", () => {
    expect(desktopLiveAccessModes("cdp-delegate")).toEqual({
      view:"not-supported",controller:"not-supported",independentlyApproved:false,
    });
  });
});
