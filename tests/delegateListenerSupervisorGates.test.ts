import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDelegateListenerPreference, writeDelegateListenerPreference } from "../src/core/delegate/delegateListenerPreference.js";
import { applyDelegateListenerAction } from "../src/core/delegate/delegateListenerLifecycle.js";
import { stopRetainedDelegateListener } from "../src/core/delegate/delegateListenerRecovery.js";
import { callCoreWorkerDelegateBridge, handoverCoreDelegateBridge, type DelegateBridgeCall, type DelegateWorkerBridgeStatus } from "../src/core/runtime/coreDelegateHandover.js";
import type { CoreSupervisorCheckpoint } from "../src/core/runtime/coreSupervisorCheckpoint.js";

const status = (running: boolean, pendingRequests: number | null = 0, sockets = 0): DelegateWorkerBridgeStatus =>
  ({ running, port: 17341, openSockets: sockets, ...(pendingRequests === null ? {} : { pendingRequests }), activeProfiles: [] });
const ACTIVE = 42, RETAINED = 43, OLD_PORT = 51301, NEW_PORT = 51302;
const TOKEN = "c".repeat(48), INSPECT = "d".repeat(64);
const checkpoint = (): CoreSupervisorCheckpoint => ({
  version: 1, port: 7888, savedAt: 1, clientMode: "tline",
  serverToken: TOKEN, inspectToken: INSPECT, activePid: ACTIVE, sessions: [],
  workers: [
    { pid: ACTIVE, port: NEW_PORT, since: 1, generationId: "a".repeat(32), drainEligible: false },
    { pid: RETAINED, port: OLD_PORT, since: 1, generationId: "b".repeat(32), drainEligible: true },
  ],
});

let configDir: string;
let previousDir: string | undefined;
beforeEach(() => {
  previousDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "delegate-supervisor-gates-"));
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (previousDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousDir;
  rmSync(configDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Delegate Supervisor gates (isolated fake workers, no real service state)", () => {
  it("manual OFF remains OFF across a simulated worker generation restart", async () => {
    writeDelegateListenerPreference(false);
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      return status(port === OLD_PORT && action === "status");
    };
    await handoverCoreDelegateBridge(OLD_PORT, NEW_PORT, TOKEN, call, { inspectToken: INSPECT });
    expect(calls).toEqual([OLD_PORT + ":status", OLD_PORT + ":stop"]);
    expect(readDelegateListenerPreference()).toBe(false);
  });

  it("fails closed when retained listener has pending in-flight RPC", async () => {
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      return status(true, 2);
    };
    await expect(handoverCoreDelegateBridge(OLD_PORT, NEW_PORT, TOKEN, call, { desiredEnabled: true }))
      .rejects.toThrow("CORE_DELEGATE_HANDOVER_INFLIGHT");
    expect(calls).toEqual([OLD_PORT + ":status"]);
  });

  it("fails closed for legacy worker with connected sockets but no RPC count", async () => {
    const call = vi.fn(async () => status(true, null, 1));
    await expect(handoverCoreDelegateBridge(OLD_PORT, NEW_PORT, TOKEN, call))
      .rejects.toThrow("CORE_DELEGATE_HANDOVER_UNVERIFIED_INFLIGHT");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects unverified active worker metadata before invoking retained worker callbacks", async () => {
    const call = vi.fn(async () => status(true));
    const inspect = vi.fn(async () => true);
    await expect(stopRetainedDelegateListener({
      checkpoint: { ...checkpoint(), activePid: 999 },
      currentPid: ACTIVE, currentGenerationId: "a".repeat(32),
      serverToken: TOKEN, call, inspect,
    })).rejects.toThrow("DELEGATE_RECOVERY_ACTIVE_WORKER_UNVERIFIED");
    expect(call).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects supervisor credential mismatch before touching retained worker", async () => {
    const call = vi.fn(async () => status(true));
    await expect(stopRetainedDelegateListener({
      checkpoint: checkpoint(), currentPid: ACTIVE,
      currentGenerationId: "a".repeat(32), serverToken: "x".repeat(48),
      call, inspect: async () => true,
    })).rejects.toThrow("DELEGATE_RECOVERY_ACTIVE_WORKER_UNVERIFIED");
    expect(call).not.toHaveBeenCalled();
  });

  it("uses both bearer and inspection capability for transient worker stop", async () => {
    const calls: Array<{ action: string; token: string; transient?: boolean; inspectToken?: string }> = [];
    await stopRetainedDelegateListener({
      checkpoint: checkpoint(), currentPid: ACTIVE,
      currentGenerationId: "a".repeat(32), serverToken: TOKEN,
      inspect: async () => true,
      call: async (_port, action, token, options) => {
        calls.push({ action, token, ...options });
        return status(action === "status");
      },
    });
    expect(calls.map(c => c.action)).toEqual(["status", "stop"]);
    expect(calls[1]).toEqual({ action: "stop", token: TOKEN, transient: true, inspectToken: INSPECT });
  });

  it("does not start pairing/listener after manual OFF handover", async () => {
    writeDelegateListenerPreference(false);
    const call = vi.fn(async (_port: number, action: string) => status(action !== "stop"));
    await handoverCoreDelegateBridge(OLD_PORT, NEW_PORT, TOKEN, call);
    expect(call.mock.calls.some(args => args[1] === "start")).toBe(false);
  });

  it("serializes concurrent local transitions on one bridge", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bridge = { start: vi.fn(() => gate), close: vi.fn(async () => {}),
      getStatus: () => ({ running: false, pendingRequests: 0 }) };
    const first = applyDelegateListenerAction(bridge, "start", { transient: true });
    await expect(applyDelegateListenerAction(bridge, "stop", { transient: true }))
      .rejects.toThrow("DELEGATE_LISTENER_TRANSITION_BUSY");
    release();
    await first;
  });

  it("rolls back old worker when the new worker start fails", async () => {
    const calls: string[] = [];
    const call: DelegateBridgeCall = async (port, action) => {
      calls.push(port + ":" + action);
      if (port === NEW_PORT && action === "start") throw new Error("bind failed");
      return status(action !== "stop");
    };
    await expect(handoverCoreDelegateBridge(OLD_PORT, NEW_PORT, TOKEN, call, { desiredEnabled: true, inspectToken: INSPECT }))
      .rejects.toThrow("bind failed");
    expect(calls).toEqual([OLD_PORT + ":status", OLD_PORT + ":stop", NEW_PORT + ":start", OLD_PORT + ":start"]);
  });

  it("reports compound failure if old worker rollback also fails", async () => {
    const call: DelegateBridgeCall = async (port, action) => {
      if (action === "start") throw new Error("bind failed");
      return status(action !== "stop");
    };
    await expect(handoverCoreDelegateBridge(OLD_PORT, NEW_PORT, TOKEN, call, { desiredEnabled: true }))
      .rejects.toThrow("CORE_DELEGATE_HANDOVER_AND_ROLLBACK_FAILED");
  });

  it("fails closed for invalid worker port or short bearer before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(callCoreWorkerDelegateBridge(80, "status", TOKEN)).rejects.toThrow("CORE_DELEGATE_UNVERIFIED_WORKER");
    await expect(callCoreWorkerDelegateBridge(OLD_PORT, "status", "short")).rejects.toThrow("CORE_DELEGATE_UNVERIFIED_WORKER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends transient requests with supervisor header and no request replay", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, text: async () => JSON.stringify({
        success: true, ...status(false),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await callCoreWorkerDelegateBridge(OLD_PORT, "stop", TOKEN, { transient: true, inspectToken: INSPECT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:" + OLD_PORT + "/api/desktop/delegate/lifecycle");
    expect((init.headers as Record<string, string>)["x-superagent-internal-token"]).toBe(INSPECT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer " + TOKEN);
    expect(JSON.parse(String(init.body))).toEqual({ action: "stop", transient: true });
  });
});
