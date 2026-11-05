import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDelegateListenerPreference, writeDelegateListenerPreference,
  delegateListenerPreferencePath } from "../src/core/delegate/delegateListenerPreference.js";
import { applyDelegateListenerAction } from "../src/core/delegate/delegateListenerLifecycle.js";
import { recoverDelegateListenerFromRetained, stopRetainedDelegateListener } from "../src/core/delegate/delegateListenerRecovery.js";
import { handoverCoreDelegateBridge, type DelegateBridgeCall, type DelegateWorkerBridgeStatus
} from "../src/core/runtime/coreDelegateHandover.js";
import type { CoreSupervisorCheckpoint } from "../src/core/runtime/coreSupervisorCheckpoint.js";

let home: string;
let previousConfig: string | undefined;
beforeEach(() => {
  previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
  home = mkdtempSync(join(tmpdir(), "sa-delegate-listener-"));
  process.env.SUPERAGENT_CONFIG_DIR = home;
});
afterEach(() => {
  if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const status = (running: boolean, pendingRequests = 0): DelegateWorkerBridgeStatus =>
  ({ running, pendingRequests, port: 17341, openSockets: 0, activeProfiles: [] });

describe("durable Delegate listener preferences", () => {
  it("defaults ON, persists OFF/ON and rejects unsafe or corrupt records", () => {
    expect(readDelegateListenerPreference()).toBe(true);
    writeDelegateListenerPreference(false);
    expect(readDelegateListenerPreference()).toBe(false);
    writeDelegateListenerPreference(true);
    expect(readDelegateListenerPreference()).toBe(true);
    writeFileSync(delegateListenerPreferencePath(), "{nope");
    expect(() => readDelegateListenerPreference()).toThrow("DELEGATE_LISTENER_PREFERENCE_INVALID");
    rmSync(delegateListenerPreferencePath());
    mkdirSync(join(home, "delegate", "listener-preference-v1.json"));
    expect(() => readDelegateListenerPreference()).toThrow("DELEGATE_LISTENER_PREFERENCE_UNSAFE");
  });

  it("persists OFF on manual Stop and ON on manual Start", async () => {
    let running = true;
    const bridge = {
      start: vi.fn(async () => { running = true; }),
      close: vi.fn(async () => { running = false; }),
      getStatus: () => ({ running, pendingRequests: 0 }),
    };
    await applyDelegateListenerAction(bridge, "stop");
    expect(running).toBe(false);
    expect(readDelegateListenerPreference()).toBe(false);
    await applyDelegateListenerAction(bridge, "start");
    expect(running).toBe(true);
    expect(readDelegateListenerPreference()).toBe(true);
  });

  it("does not persist supervisor handover or stop an in-flight Delegate RPC", async () => {
    writeDelegateListenerPreference(false);
    const bridge = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getStatus: () => ({ running: true, pendingRequests: 0 }),
    };
    await applyDelegateListenerAction(bridge, "start", { transient: true });
    expect(readDelegateListenerPreference()).toBe(false);
    await applyDelegateListenerAction(bridge, "stop", { transient: true });
    expect(readDelegateListenerPreference()).toBe(false);
    const busy = { ...bridge, getStatus: () => ({ running: true, pendingRequests: 1 }) };
    await expect(applyDelegateListenerAction(busy, "stop"))
      .rejects.toThrow("DELEGATE_BRIDGE_BUSY");
    expect(readDelegateListenerPreference()).toBe(false);
  });

  it("rolls back stored preference if a manual transition cannot bind", async () => {
    writeDelegateListenerPreference(false);
    const bridge = {
      start: vi.fn(async () => { throw new Error("EADDRINUSE port 17341"); }),
      close: vi.fn(async () => {}),
      getStatus: () => ({ running: false, pendingRequests: 0 }),
    };
    await expect(applyDelegateListenerAction(bridge, "start"))
      .rejects.toThrow("EADDRINUSE");
    expect(readDelegateListenerPreference()).toBe(false);
    const recover = vi.fn(async () => {});
    await applyDelegateListenerAction(bridge, "start", { recover });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(readDelegateListenerPreference()).toBe(true);
  });

  it("serializes overlapping listener transitions", async () => {
    let resolveStart!: () => void;
    const gate = new Promise<void>(resolve => { resolveStart = resolve; });
    const bridge = {
      start: vi.fn(() => gate),
      close: vi.fn(async () => {}),
      getStatus: () => ({ running: false, pendingRequests: 0 }),
    };
    const first = applyDelegateListenerAction(bridge, "start");
    await expect(applyDelegateListenerAction(bridge, "stop"))
      .rejects.toThrow("DELEGATE_LISTENER_TRANSITION_BUSY");
    resolveStart();
    await first;
    expect(readDelegateListenerPreference()).toBe(true);
  });

  it("an explicit Stop also releases a verified listener on a retained worker", async () => {
    const checkpoint = fixtureCheckpoint();
    const calls: string[] = [];
    await stopRetainedDelegateListener({
      checkpoint, currentPid: 42, currentGenerationId: "a".repeat(32),
      serverToken: "c".repeat(48), inspect: async () => true,
      call: async (port, action, _token, opts) => {
        calls.push(port + ":" + action + (opts?.transient ? ":transient" : ""));
        return status(action === "status");
      },
    });
    expect(calls).toEqual(["51301:status", "51301:stop:transient"]);
  });

  it("does not save OFF when stale owner stop fails", async () => {
    writeDelegateListenerPreference(true);
    const bridge = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getStatus: () => ({ running: false, pendingRequests: 0 }),
    };
    await expect(applyDelegateListenerAction(bridge, "stop", {
      stopStale: async () => { throw new Error("DELEGATE_RECOVERY_OWNER_INFLIGHT_UNVERIFIED"); },
    })).rejects.toThrow("OWNER_INFLIGHT_UNVERIFIED");
    expect(readDelegateListenerPreference()).toBe(true);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it("does not resurrect a manually disabled listener during Core handover", async () => {
    writeDelegateListenerPreference(false);
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action, _token, opts) => {
      calls.push([port, action, opts?.transient ? "transient" : "manual"].join(":"));
      return status(port === 51100 && action === "status");
    };
    await handoverCoreDelegateBridge(51100, 51101, "a".repeat(48), call, { inspectToken: "b".repeat(64) });
    expect(calls).toEqual(["51100:status:manual", "51100:stop:transient"]);
    expect(readDelegateListenerPreference()).toBe(false);
  });

  it("recovers the only authenticated old worker without killing any process", async () => {
    const checkpoint = fixtureCheckpoint();
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action, _token, opts) => {
      calls.push(port + ":" + action + (opts?.transient ? ":transient" : ""));
      return status(action === "status" || action === "start");
    };
    const start = vi.fn(async () => {});
    await recoverDelegateListenerFromRetained(start, {
      checkpoint, currentPid: 42, currentGenerationId: "a".repeat(32),
      serverToken: "c".repeat(48), inspect: async () => true, call,
    });
    expect(calls).toEqual(["51301:status", "51301:stop:transient"]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("refuses wrong active generation and in-flight owners", async () => {
    const checkpoint = fixtureCheckpoint();
    const call: DelegateBridgeCall = async () => status(true, 1);
    const start = vi.fn(async () => {});
    const opts = { checkpoint, currentPid: 42, currentGenerationId: "a".repeat(32),
      serverToken: "c".repeat(48), inspect: async () => true, call };
    await expect(recoverDelegateListenerFromRetained(start, { ...opts, currentPid: 99 }))
      .rejects.toThrow("ACTIVE_WORKER_UNVERIFIED");
    await expect(recoverDelegateListenerFromRetained(start, opts))
      .rejects.toThrow("OWNER_INFLIGHT_UNVERIFIED");
    expect(start).not.toHaveBeenCalled();
  });

  it("permits a verified legacy owner only when all of its sockets are closed", async () => {
    const checkpoint = fixtureCheckpoint();
    const noSocket: DelegateBridgeCall = async (_port, action) => ({
      running: action === "status", port: 17341, openSockets: 0,
      activeProfiles: [],
    });
    await recoverDelegateListenerFromRetained(async () => {}, {
      checkpoint, currentPid: 42, currentGenerationId: "a".repeat(32),
      serverToken: "c".repeat(48), inspect: async () => true, call: noSocket,
    });
    const busyLegacy: DelegateBridgeCall = async () => ({
      running: true, port: 17341, openSockets: 1, activeProfiles: [],
    });
    await expect(recoverDelegateListenerFromRetained(async () => {}, {
      checkpoint, currentPid: 42, currentGenerationId: "a".repeat(32),
      serverToken: "c".repeat(48), inspect: async () => true, call: busyLegacy,
    })).rejects.toThrow("OWNER_INFLIGHT_UNVERIFIED");
  });

  it("restores former owner if takeover of the new listener fails", async () => {
    const checkpoint = fixtureCheckpoint();
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      return status(action !== "stop");
    };
    await expect(recoverDelegateListenerFromRetained(
      async () => { throw new Error("new owner failed"); }, {
        checkpoint, currentPid: 42, currentGenerationId: "a".repeat(32),
        serverToken: "c".repeat(48), inspect: async () => true, call,
      },
    )).rejects.toThrow("new owner failed");
    expect(calls).toEqual(["51301:status", "51301:stop", "51301:start"]);
  });
});

function fixtureCheckpoint(): CoreSupervisorCheckpoint {
  return {
    version: 1, port: 7888, savedAt: Date.now(), clientMode: "tline",
    inspectToken: "b".repeat(64), serverToken: "c".repeat(48), activePid: 42,
    sessions: [],
    workers: [
      { pid: 42, port: 51300, since: 1, generationId: "a".repeat(32), drainEligible: true },
      { pid: 41, port: 51301, since: 1, generationId: "d".repeat(32), drainEligible: false },
    ],
  };
}
