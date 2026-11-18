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
  mode: "pipe", cols: 80, rows: 24,
});
const deps = (override: Partial<LanTerminalFleetDeps> = {}): LanTerminalFleetDeps => ({
  list: () => devices,
  open: async (id) => ({ ...devices.find(device => device.id === id)!, connected: true }),
  close: async () => {},
  start: async (id) => receipt(id),
  read: async (id) => receipt(id),
  input: async (id) => receipt(id),
  key: async (id) => receipt(id),
  resize: async (id) => receipt(id),
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

  it("opens two separately approved sessions concurrently and closes only selected handles", async () => {
    const unconnected = devices.map(device => ({ ...device, connected: false }));
    const opened: string[] = [];
    const release: Record<string, (device: LanDevice) => void> = {};
    const close = vi.fn(async (_id: string) => {});
    const fleet = new LanTerminalFleet(deps({
      list: () => unconnected,
      open: id => {
        opened.push(id);
        return new Promise(resolve => { release[id] = resolve; });
      },
      close,
    }));
    const pending = fleet.execute("open", [{ deviceId: a }, { deviceId: c }]);
    expect(opened).toEqual([a, c]);
    release[c]({ ...android, connected: true });
    release[a]({ ...devices[0], connected: true });
    const result = await pending;
    expect(result).toMatchObject({ action: "open", requested: 2, succeeded: 2, failed: 0 });
    expect(result.results[0]).toMatchObject({ deviceId: a, session: { connected: true } });
    expect(result.results[1]).toMatchObject({ deviceId: c, session: { connected: true } });
    const closed = await fleet.execute("close", [{ deviceId: a }, { deviceId: c }]);
    expect(closed.succeeded).toBe(2);
    expect(close).toHaveBeenCalledWith(a);
    expect(close).toHaveBeenCalledWith(c);
  });

  it("does not send an open prompt if any receiver is already connected", async () => {
    const open = vi.fn(async (id: string) => devices.find(device => device.id === id)!);
    const fleet = new LanTerminalFleet(deps({ open }));
    const blocked = await fleet.execute("open", [{ deviceId: a }, { deviceId: b }]);
    expect(blocked).toMatchObject({ requested: 2, succeeded: 0, failed: 2 });
    expect(blocked.results.every(result => !result.ok)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("handles eight independent receivers in one bounded concurrent batch", async () => {
    const targets = Array.from({ length: LAN_TERMINAL_FLEET_MAX_DEVICES }, (_, index) => ({
      id: String(index + 1).padStart(8, "0") + "-1111-4111-8111-111111111111",
      fingerprint: String(index + 1).padStart(2, "0").repeat(32),
      ip: "192.168.1." + (20 + index),
    }));
    const triggered: string[] = [];
    const receivers = targets.map(t => ({
      ...windows(t.id, t.ip), fingerprint: t.fingerprint,
    }));
    const service = new LanTerminalFleet(deps({
      list: () => receivers,
      start: async (deviceId) => {
        triggered.push(deviceId);
        return receipt(deviceId);
      },
    }));
    const done = await service.execute("start", targets.map(t => ({
      deviceId: t.id, command: "Get-Date",
    })));
    expect(triggered).toEqual(targets.map(t => t.id));
    expect(done).toMatchObject({ requested: 8, succeeded: 8, failed: 0 });
    expect(done.results.map(r => r.deviceId)).toEqual(targets.map(t => t.id));
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
      ...receipt(id), jobId: job, running: false, stopping: false, reason: "stopped_by_owner",
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

  it("routes ConPTY keys and resize independently to the correct Windows task", async () => {
    const key = vi.fn(async (id: string) => receipt(id));
    const resize = vi.fn(async (id: string) => receipt(id));
    const service = new LanTerminalFleet(deps({ key, resize }));
    const keys = await service.execute("key", [
      { deviceId: a, jobId: jA, key: "Escape" },
      { deviceId: b, jobId: jB, key: "CtrlC" },
    ]);
    expect(keys).toMatchObject({ requested: 2, succeeded: 2, failed: 0 });
    expect(key).toHaveBeenCalledWith(a, jA, "Escape");
    expect(key).toHaveBeenCalledWith(b, jB, "CtrlC");
    const sizes = await service.execute("resize", [
      { deviceId: a, jobId: jA, cols: 80, rows: 24 },
      { deviceId: b, jobId: jB, cols: 132, rows: 40 },
    ]);
    expect(sizes.succeeded).toBe(2);
    expect(resize).toHaveBeenCalledWith(a, jA, 80, 24);
    expect(resize).toHaveBeenCalledWith(b, jB, 132, 40);
    await expect(service.execute("key", [
      { deviceId: a, jobId: jA, key: "AltF4" },
      { deviceId: b, jobId: jB, key: "Escape" },
    ])).rejects.toThrow(/key/);
    await expect(service.execute("resize", [
      { deviceId: a, jobId: jA, cols: 0, rows: 24 },
      { deviceId: b, jobId: jB, cols: 80, rows: 24 },
    ])).rejects.toThrow(/dimensions/);
    expect(key).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("waits for verified exit on each stopped process without replaying stop", async () => {
    const reads = new Map<string, number>();
    const stop = vi.fn(async (id: string, job: string) => ({
      ...receipt(id), jobId: job, running: true, stopping: true,
    }));
    const read = vi.fn(async (id: string, job: string) => {
      const count = (reads.get(id) || 0) + 1;
      reads.set(id, count);
      return { ...receipt(id), jobId: job,
        running: count < 2, stopping: count < 2,
        reason: count < 2 ? "stopped_by_owner" : "exited" };
    });
    const service = new LanTerminalFleet(deps({ stop, read }));
    const done = await service.execute("stop", [
      { deviceId: a, jobId: jA }, { deviceId: b, jobId: jB },
    ]);
    expect(done).toMatchObject({ requested: 2, succeeded: 2, failed: 0 });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(4);
    expect([...reads.values()]).toEqual([2, 2]);
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

  it("reports a disconnected session per device while preventing duplicate physical receivers", async () => {
    const start = vi.fn(async (deviceId: string) => receipt(deviceId));
    const disconnected = { ...devices[1], connected: false };
    const partial = await new LanTerminalFleet(deps({ list: () => [devices[0], disconnected], start }))
      .execute("start", [{ deviceId: a, command: "id" }, { deviceId: b, command: "id" }]);
    expect(partial).toMatchObject({ requested: 2, succeeded: 1, failed: 1 });
    expect(partial.results[1]).toMatchObject({ deviceId: b, ok: false, error: expect.stringMatching(/no active approved/) });
    expect(start).toHaveBeenCalledWith(a);
    start.mockClear();
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

  it("reports a failed Android shell exit independently without hiding another device's success", async () => {
    const service = new LanTerminalFleet(deps({
      android: async () => ({ stdout: "permission denied", ok: false, exitCode: 1 }),
    }));
    const response = await service.execute("start", [
      { deviceId: a, command: "Get-Date" }, { deviceId: c, command: "id" },
    ]);
    expect(response).toMatchObject({ requested: 2, succeeded: 1, failed: 1 });
    expect(response.results[0]).toMatchObject({ deviceId: a, ok: true });
    expect(response.results[1]).toMatchObject({
      deviceId: c, platform: "android", ok: false,
      shell: { stdout: "permission denied", exitCode: 1 },
    });
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
    if (phone.ok && "shell" in phone) expect(phone.shell.stdout.length).toBe(4096);
    expect(JSON.stringify(response)).not.toContain("sessionToken");
  });
});
