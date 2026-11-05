import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let pending: {resolve:(value:any)=>void;reject:(error:Error)=>void}|null=null;
let sendCount = 0;
let connected = true;
const watcher = {
  isActive: () => true,
  getTransport: () => ({ type: "websocket", isConnected: () => connected }),
  getFileTransferStatus: () => ({ state: "transferring", bytes: 256, total: 2048, percent: 12, resumed: sendCount > 1 }),
  sendFile: vi.fn(async () => {
    sendCount++;
    return new Promise<any>((resolve, reject) => { pending = { resolve, reject }; });
  }),
  cancelFileTransfer: vi.fn(() => {
    pending?.reject(new Error("Aborted by operator"));
    return true;
  }),
};
vi.mock("../src/core/remoteAgent/museWatcherRegistry.js", () => ({
  getMuseWatcherStrict: () => watcher,
}));
vi.mock("../src/core/remoteAgent/config.js", () => ({
  loadRemoteAgentConfig: () => ({ wsPort: 9225, botToken: "token", groupId: "-100100" }),
}));
import { DesktopMuseFileManager } from "../src/core/runtime/desktopMuseFileManager.js";

describe("DesktopMuseFileManager", () => {
  let root: string;
  let file: string;
  let manager: DesktopMuseFileManager;
  beforeEach(async () => {
    pending = null;
    sendCount = 0;
    connected = true;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-tray-files-"));
    file = path.join(root, "report.csv");
    await fs.writeFile(file, Buffer.alloc(2048, 66));
    manager = new DesktopMuseFileManager(path.join(root, "config"));
  });
  afterEach(async () => {
    pending?.reject(new Error("stop test"));
    await manager.waitForIdle();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exposes the authenticated watcher state and bounded default preferences", () => {
    const state = manager.status();
    expect(state.watcherConnected).toBe(true);
    expect(state.settings.maxFileMiB).toBe(8);
    expect(state.settings.historyDays).toBe(7);
    expect(state.history).toEqual([]);
  });

  it("starts from validated native-selected path, supports pause/resume, and persists history without disclosing paths", async () => {
    const first = await manager.start(file, "muse-websocket");
    const id = first.job.id;
    expect(first.job.state).toBe("transferring");
    expect(JSON.stringify(manager.status())).not.toContain(root);
    expect(manager.status().active?.bytes).toBe(256);
    const pause = manager.pause(id);
    expect(pause.job.state).toBe("paused");
    const resumed = await manager.resume(id);
    expect(resumed.job.state).toBe("transferring");
    expect(sendCount).toBe(2);
    pending!.resolve({ transferId: "fixed-transfer-id", size: 2048, sha256: "a".repeat(64) });
    await vi.waitFor(() => {
      expect(manager.status().history[0].state).toBe("completed");
    });
    expect(manager.status().history[0].verification).toBe("sha256-acknowledged");
    const secondInstance = new DesktopMuseFileManager(path.join(root, "config"));
    expect(secondInstance.status().history[0].state).toBe("completed");
    expect(JSON.stringify(secondInstance.status())).not.toContain(root);
  });

  it("serializes simultaneous starts while async source validation is in flight", async () => {
    const results = await Promise.allSettled([
      manager.start(file, "muse-websocket"),
      manager.start(file, "muse-websocket"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(sendCount).toBe(1);
  });

  it("serializes concurrent resume requests for the same checkpoint", async () => {
    const started = await manager.start(file, "muse-websocket");
    manager.pause(started.job.id);
    const results = await Promise.allSettled([
      manager.resume(started.job.id),
      manager.resume(started.job.id),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(sendCount).toBe(2);
  });

  it("can cooperatively pause even after the socket disconnects", async () => {
    const started = await manager.start(file, "muse-websocket");
    connected = false;
    expect(manager.status().watcherConnected).toBe(false);
    expect(manager.pause(started.job.id).job.state).toBe("paused");
  });

  it("rejects string-typed numeric preferences to keep strict schema", () => {
    expect(() => manager.updateSettings({
      version: 1, maxFileMiB: "8", historyDays: 7,
      refreshSeconds: 2, defaultTransport: "muse-websocket",
    })).toThrow("Invalid Muse File Transfer settings");
  });

  it("guards active transfers from concurrent starts and rejects invalid resume", async () => {
    const start = await manager.start(file, "muse-websocket");
    await expect(manager.start(file, "muse-websocket")).rejects.toThrow("transfer is running");
    expect(() => manager.cancel(start.job.id).job.state).not.toThrow();
    await expect(manager.resume("bad-id")).rejects.toThrow("Only paused");
  });

  it("strictly validates local limits, source paths, and preferences", async () => {
    expect(() => manager.updateSettings({
      version: 1, maxFileMiB: 8, historyDays: 7, refreshSeconds: 2,
      defaultTransport: "muse-websocket", arbitraryKey: true,
    })).toThrow("Invalid");
    expect(() => manager.updateSettings({
      version: 1, maxFileMiB: 6, historyDays: 14, refreshSeconds: 5,
      defaultTransport: "muse-websocket",
    })).not.toThrow();
    await expect(manager.start(path.join(root, "missing.csv"), "muse-websocket")).rejects.toThrow();
    const large = path.join(root, "large.csv");
    await fs.writeFile(large, Buffer.alloc(7 * 1048576));
    await expect(manager.start(large, "muse-websocket")).rejects.toThrow("configured transfer limit");
    const secret = path.join(root, ".env");
    await fs.writeFile(secret, "SECRET");
    await expect(manager.start(secret, "muse-websocket")).rejects.toThrow("sensitive configuration");
  });

  it("rejects unsupported channel and missing bot when unconfigured", async () => {
    await expect(manager.start(file, "whatever" as any)).rejects.toThrow("Unsupported");
    await expect(manager.start("relative.csv", "muse-websocket")).rejects.toThrow("native file picker");
  });
});
