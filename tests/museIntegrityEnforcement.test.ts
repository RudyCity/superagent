import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseRecoveryIntegrityMonitor } from "../src/core/remoteAgent/museRecoveryIntegrityMonitor.js";
import { MuseRecoveryIntegrityEvents, museIntegrityEventsFile } from "../src/core/remoteAgent/museRecoveryIntegrityEvents.js";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import type { RemoteTransport } from "../src/core/remoteAgent/transport.js";
import {
  inspectMuseRecoveryStorage, makeMuseRecoveryBackup, verifyMuseRecoveryBackup,
  restoreMuseRecoveryBackup,
} from "../src/core/remoteAgent/museRecoveryBackup.js";
import { runChannelHost, handleChannelHostCliCommand, requestChannelHostIpc } from "../src/core/runtime/channelHost.js";
import type { Server } from "node:http";

const roots: string[] = [];
const hosts: Server[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-enforcement-"));
  roots.push(root);
  return { root, port: 51344 };
}
async function freePort() {
  const srv = net.createServer();
  return new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") return reject(new Error("No free port"));
      srv.close(() => resolve(address.port));
    });
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of hosts.splice(0)) await new Promise<void>(r => server.close(() => r()));
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("phase 4m fail-closed integrity enforcement and durable local alerts", () => {
  it("persists sanitized state transitions with a verifiable chain and restores recovery alerts", () => {
    const f = fixture();
    const journal = new MuseBatchJournal(f.port, f.root);
    journal.claim("safe", "task-safe", 0);
    const monitor = new MuseRecoveryIntegrityMonitor(f.port, 1_000, f.root);
    expect(monitor.check().state).toBe("healthy");
    const checkpoint = museJournalFile(f.port, f.root);
    const normal = fs.readFileSync(checkpoint);
    fs.writeFileSync(checkpoint, "{\"broken\":true}");
    const d1 = monitor.check();
    const d2 = monitor.check();
    expect(d1).toMatchObject({ state: "degraded", durableAlertCount: 1 });
    expect(d2).toMatchObject({ state: "failed", durableAlertCount: 2 });
    const ledger = new MuseRecoveryIntegrityEvents(f.port, f.root);
    expect(ledger.read().map(e => e.state)).toEqual(["degraded", "failed"]);
    const reloaded = new MuseRecoveryIntegrityMonitor(f.port, 1_000, f.root);
    expect(reloaded.check().state).toBe("failed"); // severity survives restart
    fs.writeFileSync(checkpoint, normal);
    const recovered = reloaded.check();
    expect(recovered).toMatchObject({ state: "healthy", lastHealthyAt: expect.any(Number) });
    expect(ledger.read().at(-1)).toMatchObject({ state: "healthy", reason: "VALIDATED" });
    const output = JSON.stringify(ledger.read());
    expect(output).not.toContain(f.root);
    expect(output).not.toContain("task-safe");
    const dir = path.join(f.root, "backup");
    // Destination must be external to the recovery root.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "muse-alert-backup-"));
    roots.push(parent);
    const bundle = path.join(parent, "snapshot");
    expect(inspectMuseRecoveryStorage(f.port, f.root)).toMatchObject({ active: 1 });
    makeMuseRecoveryBackup(f.port, bundle, f.root);
    expect(verifyMuseRecoveryBackup(bundle, f.port).active).toBe(1);
    const entry = "muse-integrity-" + f.port + ".jsonl";
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "recovery-bundle.json"), "utf8"));
    expect(manifest.files.some((item: { name: string }) => item.name === entry)).toBe(true);
    const target = path.join(parent, "restored");
    restoreMuseRecoveryBackup(f.port, bundle, target);
    expect(new MuseRecoveryIntegrityEvents(f.port, target).read().map(e => e.state).at(-1)).toBe("healthy");
    expect(new MuseBatchJournal(f.port, target).claim("safe", "new-task", 0)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("invalid, missing or partially appended alert files fail closed without exposing raw contents", () => {
    const f = fixture();
    new MuseBatchJournal(f.port, f.root).claim("batch", "task", 0);
    const monitor = new MuseRecoveryIntegrityMonitor(f.port, 1_000, f.root);
    expect(monitor.check().state).toBe("healthy");
    const ledger = museIntegrityEventsFile(f.port, f.root);
    fs.writeFileSync(museJournalFile(f.port, f.root), "INVALID_CHECKPOINT");
    expect(monitor.check().state).toBe("degraded");
    fs.appendFileSync(ledger, "{partial-secret-json");
    expect(monitor.check()).toMatchObject({ state: "failed", reason: "ALERT_LEDGER_INVALID" });
    expect(() => new MuseRecoveryIntegrityEvents(f.port, f.root).read()).toThrow();
    const json = JSON.stringify(monitor.snapshot());
    expect(json).not.toContain("partial-secret-json");
    expect(json).not.toContain(f.root);
    expect(() => inspectMuseRecoveryStorage(f.port, f.root)).toThrow();
  });

  it("rejects a symlinked recovery alert ledger and refuses to report healthy", () => {
    const f = fixture();
    new MuseBatchJournal(f.port, f.root).claim("guard", "task", 0);
    const monitor = new MuseRecoveryIntegrityMonitor(f.port, 1_000, f.root);
    monitor.check();
    const journal = museJournalFile(f.port, f.root);
    fs.writeFileSync(journal, "BROKEN");
    monitor.check();
    const ledgerFile = museIntegrityEventsFile(f.port, f.root);
    const backup = ledgerFile + ".saved";
    fs.renameSync(ledgerFile, backup);
    try {
      fs.symlinkSync(backup, ledgerFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        fs.renameSync(backup, ledgerFile);
        return;
      }
      throw error;
    }
    expect(() => new MuseRecoveryIntegrityEvents(f.port, f.root).read()).toThrow();
    expect(monitor.check()).toMatchObject({ state: "failed", reason: "ALERT_LEDGER_INVALID" });
    expect(fs.readFileSync(backup, "utf8")).not.toContain("BROKEN");
  });

  it("an injected watcher guard blocks fresh tool batches and direct recovery attempts", async () => {
    const f = fixture();
    const deliveries: string[] = [];
    const transport: RemoteTransport = {
      type: "https", start: async () => {}, stop: async () => {},
      isConnected: () => true,
      sendEnvelope: async message => { deliveries.push(message.kind); return true; },
      getTransportInfo: () => ({ type: "https", details: "fake" }),
    };
    let checks = 0;
    const journal = new MuseBatchJournal(f.port, f.root);
    const watcher = new MuseWatcher({
      workspace: f.root, workspaces: [f.root], transport,
      batchJournal: journal,
      integrityGuard: () => { checks++; return false; },
      announce: false,
    });
    await watcher.start();
    try {
      await watcher.handleEnvelope({
        v: 1, kind: "task_batch", id: "guarded",
        task_id: "guarded-task", calls: [],
      });
      await watcher.waitForIdle();
      expect(watcher.getStats().batchesExecuted).toBe(0);
      expect(journal.get("guarded")).toBeUndefined();
      expect(await watcher.resumeUntouchedBatch("guarded")).toBe(false);
      expect(await watcher.replayStoredResult("guarded")).toBe(false);
      expect(checks).toBeGreaterThanOrEqual(3);
      expect(deliveries.filter(k => k === "task_result")).toHaveLength(0);
    } finally { await watcher.stop(); }
  });

  it("live recovery IPC requires fresh disk scan; corruption blocks replay and resume, not safe abort", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-alert-live-"));
    roots.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const port = await freePort();
    const root = path.join(home, ".superagent-r");
    fs.mkdirSync(root);
    const journal = new MuseBatchJournal(port, root);
    journal.claim("existing", "task", 0);
    let called = 0;
    const host = await runChannelHost({
      port, mode: "telegram-fallback", wsPort: 9225,
      config: { botToken: "secret_fake", groupId: "test", museBotId: "test" },
      startWatcher: async () => {},
      executeIpc: async () => { called++; return true; },
    });
    hosts.push(host.server);
    expect(host.health().recoveryIntegrity?.state).toBe("healthy");
    expect((await requestChannelHostIpc(port, "resume_untouched", "existing")).ok).toBe(true);
    expect(called).toBe(1);
    fs.writeFileSync(museJournalFile(port, root), "CORRUPT_DISK_NOT_SECRET");
    await expect(requestChannelHostIpc(port, "replay_result", "existing")).rejects.toThrow();
    await expect(requestChannelHostIpc(port, "resume_untouched", "existing")).rejects.toThrow();
    expect(called).toBe(1);
    expect(host.health().recoveryIntegrity?.state).not.toBe("healthy");
    expect((await requestChannelHostIpc(port, "abort", "")).ok).toBe(true);
    expect(called).toBe(2);
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { captured.push(a.join(" ")); });
    await expect(handleChannelHostCliCommand(["alerts", "--port", String(port)])).resolves.toBe(false);
    expect(captured.join("\n")).toContain("STORAGE_CHECK_FAILED");
    expect(captured.join("\n")).not.toContain("CORRUPT_DISK_NOT_SECRET");
    expect(captured.join("\n")).not.toContain(root);
    const eventFile = museIntegrityEventsFile(port, root);
    expect(fs.existsSync(eventFile)).toBe(true);
    const before = fs.readFileSync(eventFile);
    await new Promise<void>(resolve => host.server.close(() => resolve()));
    hosts.splice(hosts.indexOf(host.server), 1);
    expect(fs.readFileSync(eventFile)).toEqual(before);
    expect(new MuseRecoveryIntegrityEvents(port, root).read().length).toBeGreaterThan(0);
  });
});
