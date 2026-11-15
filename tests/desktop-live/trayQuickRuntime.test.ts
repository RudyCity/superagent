import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({
  gatewayStart:vi.fn(),launch:vi.fn(),
}));
vi.mock("../../src/core/desktopUi/remoteTrayGateway.js",()=>({
  startRemoteTrayGateway:mock.gatewayStart,
}));
vi.mock("../../src/core/desktopUi/trayQuickTunnel.js",()=>({
  startTrayQuickTunnel:mock.launch,
}));
vi.mock("../../src/core/desktopUi/trayManagementPassword.js",()=>({
  trayManagementPassword:{status:()=>({configured:true})},
}));
import {
  startTrayQuickManagement,startTrayRemoteManagement,stopTrayRemoteManagement,trayRemoteStatus,
} from "../../src/core/desktopUi/trayRemoteRuntime.js";

let gatewayClose:ReturnType<typeof vi.fn>;
let tunnelStop:ReturnType<typeof vi.fn>;
let onExit:(()=>void)|undefined;
beforeEach(async()=>{
  await stopTrayRemoteManagement();
  mock.gatewayStart.mockReset();
  mock.launch.mockReset();
  gatewayClose=vi.fn(async()=>undefined);
  tunnelStop=vi.fn(async()=>undefined);
  mock.gatewayStart.mockImplementation(async(options:any)=>{
    let publicUrl=options.publicOrigin;
    return {
      get publicUrl(){return publicUrl;},
      originPort:options.originPort,close:gatewayClose,
      activateQuickOrigin:vi.fn((value:string)=>{publicUrl=value;}),
    };
  });
  mock.launch.mockImplementation(async(options:any)=>{
    onExit=options.onExit;
    return {publicUrl:"https://gentle-leaf.trycloudflare.com",pid:5678,stop:tunnelStop};
  });
});
afterEach(async()=>{await stopTrayRemoteManagement();});

describe("Tray Quick runtime isolation from Named/MCP and password lifecycle",()=>{
  it("starts a new dedicated Quick connector, publishes URL and stops only its child",async()=>{
    const status=await startTrayQuickManagement({originPort:19330});
    expect(status.mode).toBe("quick");
    expect(status.active).toBe(true);
    expect(status.connectorReady).toBe(true);
    expect(status.routeVerified).toBe(false);
    expect(status.publicUrl).toBe("https://gentle-leaf.trycloudflare.com");
    expect(mock.gatewayStart).toHaveBeenCalledWith(expect.objectContaining({mode:"quick",publicOrigin:"",originPort:19330}));
    expect(mock.launch).toHaveBeenCalledWith(expect.objectContaining({originPort:19330,signal:expect.any(AbortSignal)}));
    const stopped=await stopTrayRemoteManagement();
    expect(stopped.active).toBe(false);
    expect(gatewayClose).toHaveBeenCalledOnce();
    expect(tunnelStop).toHaveBeenCalledOnce();
  });
  it("refuses Named while Quick is active and does not mutate foreign tunnels",async()=>{
    await startTrayQuickManagement({originPort:19330});
    await expect(startTrayRemoteManagement({publicOrigin:"https://tray.rcity.web.id",originPort:19331}))
      .rejects.toThrow("TRAY_REMOTE_ALREADY_ACTIVE");
    expect(mock.launch).toHaveBeenCalledTimes(1);
  });
  it("shuts down Quick management if its owned cloudflared child dies",async()=>{
    await startTrayQuickManagement({originPort:19330});
    onExit?.();
    await vi.waitFor(()=>expect(trayRemoteStatus().active).toBe(false));
    expect(gatewayClose).toHaveBeenCalled();
    expect(tunnelStop).toHaveBeenCalled();
  });
  it("rejects arbitrary fields, protected port and Quick hostname submitted as Named",async()=>{
    await expect(startTrayQuickManagement({originPort:9227})).rejects.toThrow("INVALID_TRAY_REMOTE_REQUEST");
    await expect(startTrayQuickManagement({originPort:19330,publicOrigin:"https://other.trycloudflare.com"}))
      .rejects.toThrow("INVALID_TRAY_REMOTE_REQUEST");
    await expect(startTrayRemoteManagement({originPort:19330,publicOrigin:"https://abc.trycloudflare.com"}))
      .rejects.toThrow("DEDICATED_NAMED_HOSTNAME_REQUIRED");
    expect(mock.gatewayStart).not.toHaveBeenCalled();
  });
  it("closes the gateway when cloudflared cannot publish a URL",async()=>{
    mock.launch.mockRejectedValueOnce(Error("TRAY_QUICK_URL_TIMEOUT"));
    await expect(startTrayQuickManagement({originPort:19330})).rejects.toThrow("TRAY_QUICK_URL_TIMEOUT");
    expect(gatewayClose).toHaveBeenCalledOnce();
    expect(trayRemoteStatus().active).toBe(false);
  });
});
