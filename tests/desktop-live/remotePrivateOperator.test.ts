import { describe, expect, it, vi } from "vitest";
import { RemotePrivateHostOperator } from "../../src/core/desktopUi/remotePrivateOperator.js";

describe("private remote Desktop Live host operator fail-closed integration", () => {
  it("never treats local preview, public tunnel or Core bearer as remote provisioning", () => {
    const operator = new RemotePrivateHostOperator();
    const status = operator.status();
    expect(status).toMatchObject({
      state: "NOT_CONFIGURED",
      viewAvailable: false,
      inputAvailable: false,
      activeViewer: false,
      approvalAvailable: false,
      viewerCertificateSha256: null,
      leaseSeconds: 0,
    });
    expect(status.blockers).toHaveLength(3);
    expect(JSON.stringify(status)).not.toMatch(/viewerKey|hostToken|previewToken|Bearer /);
    expect(operator.review()).toEqual(status);
  });

  it("atomically rejects duplicate native host registration without displacing the owner",()=>{
    const operator=new RemotePrivateHostOperator();
    const calls:string[]=[];
    const viewer={humanTakeover:vi.fn(()=>{calls.push("viewer");})};
    const controller={humanTakeover:vi.fn(()=>{calls.push("input");})};
    operator.registerNativeHost(viewer,controller);
    expect(()=>operator.registerNativeHost(
      {humanTakeover:vi.fn()}, {humanTakeover:vi.fn()},
    )).toThrow(/ALREADY_REGISTERED/);
    expect(()=>operator.registerStopHook({humanTakeover:vi.fn()})).toThrow();
    expect(()=>operator.registerControllerStopHook({humanTakeover:vi.fn()})).toThrow();
    operator.humanTakeover();
    expect(calls).toEqual(["input","viewer"]);
    expect(controller.humanTakeover).toHaveBeenCalledOnce();
    expect(viewer.humanTakeover).toHaveBeenCalledOnce();
    operator.humanTakeover();
    expect(calls).toHaveLength(2);
  });

  it("terminates the trusted capture/TLS runtime on human takeover", () => {
    const operator = new RemotePrivateHostOperator();
    const humanTakeover = vi.fn();
    operator.registerStopHook({ humanTakeover });
    expect(operator.status().activeViewer).toBe(false);
    expect(() => operator.registerStopHook({ humanTakeover })).toThrow();
    expect(operator.humanTakeover().state).toBe("NOT_CONFIGURED");
    expect(humanTakeover).toHaveBeenCalledTimes(1);
    operator.humanTakeover();
    expect(humanTakeover).toHaveBeenCalledTimes(1);
  });

  it("physical takeover revokes input before terminating the private viewer", () => {
    const operator = new RemotePrivateHostOperator();
    const calls: string[] = [];
    const controller = { humanTakeover: vi.fn(() => { calls.push("input"); }) };
    const viewer = { humanTakeover: vi.fn(() => { calls.push("viewer"); }) };
    operator.registerStopHook(viewer);
    operator.registerControllerStopHook(controller);
    expect(() => operator.registerControllerStopHook(controller)).toThrow();
    expect(operator.status().inputAvailable).toBe(false);
    expect(operator.humanTakeover().state).toBe("NOT_CONFIGURED");
    expect(calls).toEqual(["input", "viewer"]);
    operator.humanTakeover();
    expect(calls).toEqual(["input", "viewer"]);
  });

  it("still tears down private viewer if native input revocation throws", () => {
    const operator = new RemotePrivateHostOperator();
    const controller = { humanTakeover: vi.fn(() => { throw Error("Input lease already gone"); }) };
    const viewer = { humanTakeover: vi.fn() };
    operator.registerControllerStopHook(controller);
    operator.registerStopHook(viewer);
    expect(operator.humanTakeover().inputAvailable).toBe(false);
    expect(controller.humanTakeover).toHaveBeenCalledOnce();
    expect(viewer.humanTakeover).toHaveBeenCalledOnce();
  });

  it("fails closed if a native revoke hook throws, and never re-arms it", () => {
    const operator = new RemotePrivateHostOperator();
    const humanTakeover = vi.fn(() => { throw Error("OS transport closed"); });
    operator.registerStopHook({ humanTakeover });
    expect(operator.humanTakeover().state).toBe("NOT_CONFIGURED");
    operator.humanTakeover();
    expect(humanTakeover).toHaveBeenCalledOnce();
  });

  it("refuses malformed stop-only registrations", () => {
    const operator = new RemotePrivateHostOperator();
    expect(() => operator.registerStopHook({} as never)).toThrow();
    expect(operator.status().viewAvailable).toBe(false);
  });
});
