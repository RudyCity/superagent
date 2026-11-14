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
