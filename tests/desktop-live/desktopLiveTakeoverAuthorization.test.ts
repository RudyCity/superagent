import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  listLanDevices: vi.fn(),
  closeLanSession: vi.fn(),
  revokeDelegateTargetByHuman: vi.fn(),
  listConnections: vi.fn(),
  listDelegateSessions: vi.fn(),
  listTargets: vi.fn(),
  operatorStop: vi.fn(),
  revokeOperatorWindowSessions: vi.fn(),
}));

vi.mock("../../src/core/desktopUi/livePreview.js", () => ({
  nativeWindowPreviewManager: {
    operatorStatus: () => null,
    operatorStop: mock.operatorStop,
  },
}));
vi.mock("../../src/core/tools/desktopUiTools.js", () => ({
  desktopUiSessionManager: {
    listWindows: async () => ({windows: []}),
    listOperatorSessions: () => [],
    revokeOperatorWindowSessions: mock.revokeOperatorWindowSessions,
  },
}));
vi.mock("../../src/core/tools/chromeCdpSessionManager.js", () => ({
  listCdpSessions: async () => [],
}));
vi.mock("../../src/core/tools/chromeCdpTools.js", () => ({
  discoverCdpPages: async () => [],
}));
vi.mock("../../src/core/tools/managedBrowserRegistry.js", () => ({
  listManagedBrowserRegistrations: () => [],
}));
vi.mock("../../src/core/tools/managedBrowserControl.js", () => ({
  readManagedControlStatus: async () => "agent",
  setManagedBrowserControl: vi.fn(),
}));
vi.mock("../../src/core/delegate/bridge.js", () => ({
  delegateBridge: {
    listConnections: mock.listConnections,
    disconnectClient: vi.fn(),
  },
}));
vi.mock("../../src/core/browserTransport/router.js", () => ({
  getBrowserTransport: () => ({listTargets: mock.listTargets}),
}));
vi.mock("../../src/core/browserTransport/sessionCoordinator.js", () => ({
  listDelegateSessions: mock.listDelegateSessions,
  revokeDelegateTargetByHuman: mock.revokeDelegateTargetByHuman,
}));
vi.mock("../../src/core/lanRemote/controller.js", () => ({
  listLanDevices: mock.listLanDevices,
  closeLanSession: mock.closeLanSession,
}));

import {
  listDesktopLiveInventory, stopDesktopLiveHandle,
} from "../../src/core/desktopUi/desktopLiveInventory.js";

describe("Desktop Live exact-owner takeover and stop routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.listLanDevices.mockReturnValue([{
      id:"device_A1",host:"192.168.1.20",port:7777,platform:"android",
      connected:true,transport:"lan",label:"Personal Android",
    }]);
    mock.listConnections.mockReturnValue([{clientId:"profile_A1B2",label:"Chrome"}]);
    mock.listDelegateSessions.mockReturnValue([{
      clientId:"profile_A1B2",tabId:42,agentId:"agentA",revision:7,
    }]);
    mock.listTargets.mockResolvedValue([{tabId:42,title:"Test tab"}]);
    mock.closeLanSession.mockResolvedValue(undefined);
    mock.revokeDelegateTargetByHuman.mockResolvedValue(true);
    mock.operatorStop.mockReturnValue(false);
    mock.revokeOperatorWindowSessions.mockReturnValue(0);
  });

  it("disconnects a named LAN device without treating it as a native PID", async () => {
    const inventory = await listDesktopLiveInventory();
    expect(inventory.items.find(x => x.id === "lan:device_A1")?.stopAction).toBe("stop-session");
    const result = await stopDesktopLiveHandle({id:"lan:device_A1"},"human");
    expect(result.stopped).toBe(true);
    expect(result.scope).toBe("lan:device_A1");
    expect(mock.closeLanSession).toHaveBeenCalledTimes(1);
    expect(mock.closeLanSession).toHaveBeenCalledWith("device_A1");
    expect(mock.operatorStop).not.toHaveBeenCalled();
    expect(mock.revokeOperatorWindowSessions).not.toHaveBeenCalled();
  });

  it("does not report successful LAN stop if disconnection fails", async () => {
    mock.closeLanSession.mockRejectedValueOnce(Error("device unavailable"));
    await expect(stopDesktopLiveHandle({id:"lan:device_A1"},"human"))
      .rejects.toThrow("device unavailable");
  });

  it("revokes only the exact numeric Delegate tab and expected revision", async () => {
    const inventory = await listDesktopLiveInventory();
    expect(inventory.items.find(x => x.id === "delegate:profile_A1B2:42")?.revision).toBe(7);
    const result = await stopDesktopLiveHandle({
      id:"delegate:profile_A1B2:42", expectedRevision:7,
    },"human");
    expect(result.stopped).toBe(true);
    expect(mock.revokeDelegateTargetByHuman).toHaveBeenCalledTimes(1);
    expect(mock.revokeDelegateTargetByHuman).toHaveBeenCalledWith("profile_A1B2",42,7);
    expect(mock.closeLanSession).not.toHaveBeenCalled();
  });

  it("rejects stale Delegate revisions without releasing anyone's ownership", async () => {
    await expect(stopDesktopLiveHandle({
      id:"delegate:profile_A1B2:42",expectedRevision:6,
    },"human")).rejects.toThrow("STALE_DELEGATE_REVISION");
    expect(mock.revokeDelegateTargetByHuman).not.toHaveBeenCalled();
  });

  it("rejects agent-initiated LAN or profile-wide revocation without exact owner capability", async () => {
    await expect(stopDesktopLiveHandle({id:"lan:device_A1"},"agent"))
      .rejects.toThrow("AGENT_OWNER_CAPABILITY_REQUIRED");
    await expect(stopDesktopLiveHandle({id:"delegate:profile_A1B2:42"},"agent"))
      .rejects.toThrow("AGENT_OWNER_CAPABILITY_REQUIRED");
    expect(mock.closeLanSession).not.toHaveBeenCalled();
    expect(mock.revokeDelegateTargetByHuman).not.toHaveBeenCalled();
  });
});
