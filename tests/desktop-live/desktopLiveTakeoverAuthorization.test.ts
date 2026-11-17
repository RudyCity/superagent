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
  listCdpSessions: vi.fn(),
  discoverCdpPages: vi.fn(),
  listManagedBrowserRegistrations: vi.fn(),
  readManagedControlStatus: vi.fn(),
  setManagedBrowserControl: vi.fn(),
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
  listCdpSessions: mock.listCdpSessions,
}));
vi.mock("../../src/core/tools/chromeCdpTools.js", () => ({
  discoverCdpPages: mock.discoverCdpPages,
}));
vi.mock("../../src/core/tools/managedBrowserRegistry.js", () => ({
  listManagedBrowserRegistrations: mock.listManagedBrowserRegistrations,
}));
vi.mock("../../src/core/tools/managedBrowserControl.js", () => ({
  readManagedControlStatus: mock.readManagedControlStatus,
  setManagedBrowserControl: mock.setManagedBrowserControl,
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
    mock.listCdpSessions.mockResolvedValue([]);
    mock.discoverCdpPages.mockResolvedValue([]);
    mock.listManagedBrowserRegistrations.mockReturnValue([]);
    mock.readManagedControlStatus.mockResolvedValue("agent");
    mock.setManagedBrowserControl.mockImplementation(async (input:{mode:"human"|"agent"}) => {
      mock.readManagedControlStatus.mockResolvedValue(input.mode);
      return {mode:input.mode};
    });
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

  it("confirms managed CDP human takeover against the authoritative write fence", async () => {
    mock.listCdpSessions.mockResolvedValue([{port:9222,targetId:"target_123",agentId:"agentA",revision:9}]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("agent");
    const result=await stopDesktopLiveHandle({
      id:"managed:9222:target_123",expectedRevision:9,
    },"human");
    expect(result.stopped).toBe(true);
    expect(mock.setManagedBrowserControl).toHaveBeenCalledWith({
      mode:"human",port:9222,targetId:"target_123",profileId:"test_profile",
      generation:"gen_1",browserFingerprint:"a".repeat(64),
    },undefined,9);
    expect(mock.readManagedControlStatus).toHaveBeenLastCalledWith(9222,"target_123");
  });

  it("never claims a successful human takeover when the hold did not stick", async () => {
    mock.listCdpSessions.mockResolvedValue([{port:9222,targetId:"target_123",revision:9}]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("agent");
    mock.setManagedBrowserControl.mockResolvedValueOnce({mode:"human"});
    await expect(stopDesktopLiveHandle({
      id:"managed:9222:target_123",expectedRevision:9,
    },"human")).rejects.toThrow("CDP_HUMAN_HOLD_NOT_VERIFIED");
  });

  it("never claims Return to Agent while a competing human hold remains", async () => {
    mock.listCdpSessions.mockResolvedValue([{port:9222,targetId:"target_123",revision:9}]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("human");
    mock.setManagedBrowserControl.mockResolvedValueOnce({mode:"agent"});
    await expect(stopDesktopLiveHandle({
      id:"managed:9222:target_123",expectedRevision:9,
    },"human")).rejects.toThrow("CDP_AGENT_RETURN_NOT_VERIFIED");
  });

  it("shows Return to Agent only on a verified human-held managed CDP target", async () => {
    mock.listCdpSessions.mockResolvedValue([{
      port:9222,targetId:"target_123",agentId:"agentA",revision:9,
    }]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("human");
    const inventory = await listDesktopLiveInventory();
    const held = inventory.items.find(item=>item.id==="managed:9222:target_123");
    expect(held?.stopAction).toBe("return-to-agent");
    expect(held?.access.controller).toBe("human-held");
    expect(held?.access.independentlyApproved).toBe(false);
    const result = await stopDesktopLiveHandle({
      id:"managed:9222:target_123",expectedRevision:9,
    },"human");
    expect(result.stopped).toBe(true);
    expect(mock.setManagedBrowserControl).toHaveBeenCalledTimes(1);
    expect(mock.setManagedBrowserControl).toHaveBeenCalledWith({
      mode:"agent",port:9222,targetId:"target_123",profileId:"test_profile",
      generation:"gen_1",browserFingerprint:"a".repeat(64),
    },undefined,9);
  });

  it("allows verified human hold release when agent's CDP lease has already ended", async () => {
    mock.listCdpSessions.mockResolvedValue([]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("human");
    const inventory=await listDesktopLiveInventory();
    const target=inventory.items.find(item=>item.id==="managed:9222:target_123");
    expect(target?.status).toBe("human");
    expect(target?.revision).toBeUndefined();
    expect(target?.stopAction).toBe("return-to-agent");
    const response=await stopDesktopLiveHandle({
      id:"managed:9222:target_123",
    },"human");
    expect(response.stopped).toBe(true);
    expect(mock.setManagedBrowserControl).toHaveBeenCalledWith({
      mode:"agent",port:9222,targetId:"target_123",profileId:"test_profile",
      generation:"gen_1",browserFingerprint:"a".repeat(64),
    },undefined,undefined);
  });

  it("denies Return to Agent if an active takeover reservation prevents release", async () => {
    mock.listCdpSessions.mockResolvedValue([{
      port:9222,targetId:"target_123",agentId:"agentA",revision:9,
    }]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("human");
    mock.setManagedBrowserControl.mockRejectedValueOnce(
      Error("Browser takeover reservation requires verified operator Return to Agent."));
    await expect(stopDesktopLiveHandle({
      id:"managed:9222:target_123",expectedRevision:9,
    },"human")).rejects.toThrow(/takeover reservation/);
    expect(mock.setManagedBrowserControl).toHaveBeenCalledTimes(1);
  });

  it("rejects stale CDP Return to Agent revisions before asking the browser to release", async () => {
    mock.listCdpSessions.mockResolvedValue([{port:9222,targetId:"target_123",revision:9}]);
    mock.listManagedBrowserRegistrations.mockReturnValue([{
      port:9222,targetId:"target_123",profileId:"test_profile",generation:"gen_1",
      browserFingerprint:"a".repeat(64),
    }]);
    mock.discoverCdpPages.mockResolvedValue([{targetId:"target_123",title:"Test tab"}]);
    mock.readManagedControlStatus.mockResolvedValue("human");
    await expect(stopDesktopLiveHandle({
      id:"managed:9222:target_123",expectedRevision:8,
    },"human")).rejects.toThrow("STALE_CDP_REVISION");
    expect(mock.setManagedBrowserControl).not.toHaveBeenCalled();
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
