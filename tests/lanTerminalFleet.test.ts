import { describe, expect, it, vi } from "vitest";
import {
  LanTerminalFleet, LAN_TERMINAL_FLEET_MAX_DEVICES, type LanTerminalFleetDeps,
} from "../src/core/lanRemote/terminalFleet.js";
import type { LanDevice, LanTerminalSnapshot } from "../src/core/lanRemote/controller.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const jA = "aaaa1111-1111-4111-8111-111111111111";
const jB = "bbbb2222-2222-4222-8222-222222222222";

const windows = (id: string, ip: string): LanDevice => ({
  id, host: ip, port: 17845, fingerprint: (id === a ? "a" : "c").repeat(64),
  label: "Receiver " + id.slice(0, 4), platform: "windows",
  paired: true, connected: true, transport: "lan",
});
const android: LanDevice = {
  id: c, host: "192.168.1.13", port: 17845, fingerprint: "b".repeat(64),
  label: "Phone", platform: "android", paired: true, connected: true, transport: "lan",
};
const devices = [windows(a, "192.168.1.11"), windows(b, "192.168.1.12"), android];
const receipt = (id: string): LanTerminalSnapshot => ({
  jobId: id === a ? jA : jB, running: true, stopping: false, exitCode: null,
  reason: null, cursor: 0, nextCursor: 0, oldestCursor: 1, truncated: false, chunks: [],
});
const deps = (override: Partial<LanTerminalFleetDeps> = {}): LanTerminalFleetDeps => ({
  list: () => devices,
  start: async (id) => receipt(id),
  read: async (id) => receipt(id),
  input: async (id) => receipt(id),
  stop: async (id) => ({ ...receipt(id), running: false, stopping: true, reason: "stopped_by_owner" }),
  android: async () => ({ stdout: "Android output", ok: true, exitCode: 0 }),
  fullYolo: () => true, destructive: () => false, ...override,
});

describe("LAN terminal fleet: multi-device isolation and concurrency", () => {
  it("starts distinct Windows and Android receivers concurrently, not sequentially", async () => {
    const started: string[] = [];
    const release: Record<string, (value: unknown) => void> = {};
    const service = new LanTerminalFleet(deps({
      start: (deviceId) => {
        started.push("windows:" + deviceId);
        return new Promise(resolve => { release[deviceId] = (value) => resolve(value as LanTerminalSnapshot); });
      },
      android: (deviceId) => {
        started.push("android:" + deviceId);
        return new Promise(resolve => { release[deviceId] = (value) => resolve(value as Awaited<ReturnType<LanTerminalFleetDeps["android"]>>); });
      },
    }));
    const pending = service.execute("start", [
      { deviceId: a, command: "Write-Output PC_A" },
      { deviceId: b, command: "Write-Output PC_B" },
      { deviceId: c, command: "id" },
    ]);
    expect(started).toEqual(["windows:" + a, "windows:" + b, "android:" + c]);
    release[b](receipt(b));
    release[c]({ stdout: "PHONE", ok: true, exitCode: 0 });
    release[a](receipt(a));
    const done = await pending;
    expect(done).toMatchObject({ action: "start", requested: 3, succeeded: 3, failed: 0 });
    expect(done.results.map(result => result.deviceId)).toEqual([a, b, c]);
    expect(done.results[0]).toMatchObject({ platform: "windows", ok: true, terminal: { jobId: jA } });
    expect(done.results[1]).toMatchObject({ platform: "windows", ok: true, terminal: { jobId: jB } });
    expect(done.results[2]).toMatchObject({ platform: "android", ok: true, shell: { stdout: "PHONE" } });
  });

  it("returns per-device failures without cancelling successful targets", async () => {
    const service = new LanTerminalFleet(deps({
      start: async (deviceId) => {
        if (deviceId === b) throw Error("owner denied");
        return receipt(deviceId);
      },
    }));
    const response = await service.execute("start", [
      { deviceId: a, command: "Get-Date" },
      { deviceId: b, command: "Get-Process" },
    ]);
    expect(response).toMatchObject({ requested: 2, succeeded: 1, failed: 1 });
    expect(response.results[0]).toMatchObject({ deviceId: a, ok: true });
    expect(response.results[1]).toMatchObject({ deviceId: b, ok: false, error: "owner denied" });
  });

  it("routes read/input/stop to the exact device and job IDs independently", async () => {
    const read = vi.fn(async (id: string, job: string, cursor: number) => ({
      ...receipt(id), jobId: job, cursor, nextCursor: cursor,
    }));
    const input = vi.fn(async (id: string, job: string, text: string, newline: boolean) => ({
      ...receipt(id), jobId: job,
    }));
    const stop = vi.fn(async (id: string, job: string) => ({
      ...receipt(id), jobId: job, stopping: true,
    }));
    const service = new LanTerminalFleet(deps({ read, input, stop }));
    await service.execute("read", [
      { deviceId: a, jobId: jA, cursor: 12 }, { deviceId: b, jobId: jB, cursor: 45 },
    ]);
    expect(read).toHaveBeenCalledWith(a, jA, 12);
    expect(read).toHaveBeenCalledWith(b, jB, 45);
    await service.execute("input", [
      { deviceId: a, jobId: jA, text: "A", appendNewline: true },
      { deviceId: b, jobId: jB, text: "B" },
    ]);
    expect(input).toHaveBeenCalledWith(a, jA, "A", true);
    expect(input).toHaveBeenCalledWith(b, jB, "B", false);
    await service.execute("stop", [
      { deviceId: a, jobId: jA }, { deviceId: b, jobId: jB },
    ]);
    expect(stop).toHaveBeenCalledWith(a, jA);
    expect(stop).toHaveBeenCalledWith(b, jB);
  });

  it("preflights all targets before any side effect or owner prompt", async () => {
    const start = vi.fn(async (deviceId: string) => receipt(deviceId));
    const service = new LanTerminalFleet(deps({ start }));
    const badBatches = [
      [{ deviceId: a, command: "id" }, { deviceId: a, command: "id" }],
      [{ deviceId: a, command: "id" }, { deviceId: b, command: "echo \u0000" }],
      [{ deviceId: a, command: "id" }, { deviceId: b, command: "id", sessionToken: "forbidden" }],
      [{ deviceId: a, command: "id" }, { deviceId: c, command: "x".repeat(513) }],
      [{ deviceId: a, command: "id" }, { deviceId: b, command: "id" }, { deviceId: c, command: "x\n" }],
      [{ deviceId: a, command: "id" }],
      Array.from({ length: LAN_TERMINAL_FLEET_MAX_DEVICES + 1 }, () => ({ deviceId: a, command: "id" })),
    ];
    for (const batch of badBatches) await expect(service.execute("start", batch)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it("requires existing session on every device and rejects duplicate physical target", async () => {
    const start = vi.fn(async (deviceId: string) => receipt(deviceId));
    const disconnected = { ...devices[1], connected: false };
    await expect(new LanTerminalFleet(deps({ list: () => [devices[0], disconnected] }))
      .execute("start", [{ deviceId: a, command: "id" }, { deviceId: b, command: "id" }]))
      .rejects.toThrow(/approved open support session/);
    const alias = { ...devices[0], id: b };
    await expect(new LanTerminalFleet(deps({ list: () => [devices[0], alias] }))
      .execute("start", [{ deviceId: a, command: "id" }, { deviceId: b, command: "id" }]))
      .rejects.toThrow(/Same physical receiver/);
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps per-device mutation exclusive but permits independent fleet stop", async () => {
    const release: Record<string, (value: LanTerminalSnapshot) => void> = {};
    let calls = 0;
    const service = new LanTerminalFleet(deps({
      start: (id) => {
        calls++;
        return calls <= 2
          ? new Promise(resolve => { release[id] = resolve; })
          : Promise.resolve(receipt(id));
      },
    }));
    const first = service.execute("start", [
      { deviceId: a, command: "Get-Date" }, { deviceId: b, command: "Get-Date" },
    ]);
    const concurrent = await service.execute("start", [
      { deviceId: a, command: "Get-Process" }, { deviceId: b, command: "Get-Process" },
    ]);
    expect(concurrent.failed).toBe(2);
    const stopped = await service.execute("stop", [
      { deviceId: a, jobId: jA }, { deviceId: b, jobId: jB },
    ]);
    expect(stopped.succeeded).toBe(2);
    release[a](receipt(a)); release[b](receipt(b));
    expect((await first).succeeded).toBe(2);
    expect((await service.execute("start", [
      { deviceId: a, command: "id" }, { deviceId: c, command: "id" },
    ])).succeeded).toBe(2);
  });

  it("keeps stop available without YOLO but denies execution and read", async () => {
    const start = vi.fn(async (deviceId: string) => receipt(deviceId));
    const service = new LanTerminalFleet(deps({ fullYolo: () => false, start }));
    await expect(service.execute("start", [
      { deviceId: a, command: "id" }, { deviceId: b, command: "id" },
    ])).rejects.toThrow(/Full YOLO/);
    await expect(service.execute("read", [
      { deviceId: a, jobId: jA }, { deviceId: b, jobId: jB },
    ])).rejects.toThrow(/Full YOLO/);
    expect((await service.execute("stop", [
      { deviceId: a, jobId: jA }, { deviceId: b, jobId: jB },
    ])).succeeded).toBe(2);
    expect(start).not.toHaveBeenCalled();
  });

  it("bounds Android output per device and never returns credentials", async () => {
    const service = new LanTerminalFleet(deps({
      android: async () => ({ stdout: "a".repeat(24 * 1024), ok: true, exitCode: 0 }),
    }));
    const response = await service.execute("start", [
      { deviceId: a, command: "Get-Date" }, { deviceId: c, command: "id" },
    ]);
    const phone = response.results[1];
    expect(phone).toMatchObject({ deviceId: c, platform: "android", ok: true, outputTruncated: true });
    if (phone.ok && phone.platform === "android") expect(phone.shell.stdout.length).toBe(4096);
    expect(JSON.stringify(response)).not.toContain("sessionToken");
  });
});
