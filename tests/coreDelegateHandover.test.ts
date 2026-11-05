import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handoverCoreDelegateBridge, callCoreWorkerDelegateBridge,
  type DelegateBridgeCall, type DelegateWorkerBridgeStatus,
} from "../src/core/runtime/coreDelegateHandover.js";

afterEach(() => vi.restoreAllMocks());

function status(running: boolean, pendingRequests = 0): DelegateWorkerBridgeStatus {
  return { running, port: 17341, openSockets: 0, pendingRequests, activeProfiles: [] };
}

describe("supervised Core Delegate bridge handover", () => {
  it("stops only the previous worker bridge then starts the new bridge", async () => {
    const calls: string[] = [];
    let old = true;
    let next = false;
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      if (port === 50301) {
        if (action === "stop") old = false;
        if (action === "start") old = true;
        return status(old);
      }
      if (port === 50302) {
        if (action === "start") next = true;
        return status(next);
      }
      throw Error("unknown worker");
    };
    await handoverCoreDelegateBridge(50301, 50302, "a".repeat(64), call);
    expect(calls).toEqual(["50301:status", "50301:stop", "50302:start"]);
    expect(old).toBe(false);
    expect(next).toBe(true);
  });

  it("fails closed rather than interrupt an ongoing Delegate RPC", async () => {
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(action);
      return status(true, 1);
    };
    await expect(handoverCoreDelegateBridge(50301, 50302, "a".repeat(64), call))
      .rejects.toThrow("CORE_DELEGATE_HANDOVER_INFLIGHT");
    expect(calls).toEqual(["status"]);
  });

  it("restores previous listener on new listener failure", async () => {
    const calls: string[] = [];
    let old = true;
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      if (port === 50301) {
        if (action === "stop") old = false;
        if (action === "start") old = true;
        return status(old);
      }
      throw Error("NEW_WORKER_CANNOT_BIND");
    };
    await expect(handoverCoreDelegateBridge(50301, 50302, "a".repeat(64), call))
      .rejects.toThrow("NEW_WORKER_CANNOT_BIND");
    expect(calls).toEqual(["50301:status", "50301:stop", "50302:start", "50301:start"]);
    expect(old).toBe(true);
  });

  it("does not stop or restart a previous worker that has no listener", async () => {
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      return status(port === 50302 && action === "start");
    };
    await handoverCoreDelegateBridge(50301, 50302, "a".repeat(64), call);
    expect(calls).toEqual(["50301:status", "50302:start"]);
  });

  it("marks supervisor handovers transient with an internal capability", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ success: true, ...status(false) }),
    } as Response);
    await callCoreWorkerDelegateBridge(50301, "stop", "a".repeat(64), {
      transient: true, inspectToken: "b".repeat(64),
    });
    const request = mock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ action: "stop", transient: true });
    expect((request.headers as Record<string, string>)["x-superagent-internal-token"])
      .toBe("b".repeat(64));
  });

  it("uses authenticated, fixed loopback endpoints and rejects malformed replies", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ success: true, ...status(true) }),
    } as Response);
    const response = await callCoreWorkerDelegateBridge(50301, "stop", "a".repeat(64));
    expect(response.running).toBe(true);
    expect(String(mock.mock.calls[0][0])).toEqual("http://127.0.0.1:50301/api/desktop/delegate/lifecycle");
    expect((mock.mock.calls[0][1] as any)?.method).toEqual("POST");
    expect(JSON.parse(String((mock.mock.calls[0][1] as any)?.body)).action).toEqual("stop");
    mock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ success: true, port: 0 }) } as Response);
    await expect(callCoreWorkerDelegateBridge(50301, "status", "a".repeat(64)))
      .rejects.toThrow("CORE_DELEGATE_WORKER_BAD_STATUS");
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
