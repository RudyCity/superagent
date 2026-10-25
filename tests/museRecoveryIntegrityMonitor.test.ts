import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseRecoveryIntegrityMonitor } from "../src/core/remoteAgent/museRecoveryIntegrityMonitor.js";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseResultOutbox, outboxFile } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseExecutionCheckpoint } from "../src/core/remoteAgent/museExecutionCheckpoint.js";
import { runChannelHost, handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";
import type { Server } from "node:http";

const directories: string[] = [];
const servers: Server[] = [];
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-integrity-"));
  directories.push(root);
  return { root, port: 51723 };
};
async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("No free port"));
      server.close(() => resolve(addr.port));
    });
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of servers.splice(0)) await new Promise<void>(r => srv.close(() => r()));
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("phase 4l periodic read-only Muse recovery verification", () => {
  it("distinguishes a new owner from healthy journal and fails closed on stray files", () => {
    const { root, port } = fresh();
    const monitor = new MuseRecoveryIntegrityMonitor(port, 300, root);
    expect(monitor.check(1_000)).toMatchObject({
      state: "not_initialized", reason: "NO_JOURNAL_YET", totalFailures: 0,
    });
    const journal = new MuseBatchJournal(port, root);
    journal.claim("phase-4l", "task", 0);
    const snapshot = monitor.check(2_000);
    expect(snapshot).toMatchObject({
      state: "healthy", reason: "VALIDATED", activeBatches: 1, archivedTombstones: 0,
      encryptedResults: 0, encryptedIntents: 0, lastHealthyAt: 2_000,
    });
    expect(snapshot).not.toHaveProperty("filePath");
    expect(monitor.snapshot(3_000)).toMatchObject({
      state: "stale", reason: "CHECK_OVERDUE", activeBatches: null,
    });

    const raw = fs.readFileSync(museJournalFile(port, root), "utf8");
    fs.writeFileSync(museJournalFile(port, root), raw.replace('"ownerPort":' + port, '"ownerPort":42'));
    expect(monitor.check(3_100)).toMatchObject({
      state: "degraded", consecutiveFailures: 1, totalFailures: 1,
      reason: "STORAGE_CHECK_FAILED", activeBatches: null,
    });
    expect(monitor.check(3_200)).toMatchObject({ state: "failed", consecutiveFailures: 2 });
    expect(monitor.snapshot(3_300).lastHealthyAt).toBe(2_000);
    fs.writeFileSync(museJournalFile(port, root), raw);
    expect(monitor.check(3_400)).toMatchObject({
      state: "healthy", consecutiveFailures: 0, totalFailures: 2, lastHealthyAt: 3_400,
    });
    fs.rmSync(museJournalFile(port, root));
    fs.writeFileSync(path.join(root, "muse-results-" + port + ".json.key"), "orphan-key");
    expect(monitor.check(3_500).state).toBe("degraded");
  });

  it("detects archive corruption and does not print sensitive output or mutate recovery", () => {
    const { root, port } = fresh();
    const journal = new MuseBatchJournal(port, root);
    const outbox = new MuseResultOutbox(port, root);
    const exec = new MuseExecutionCheckpoint(port, root);
    journal.claim("redacted", "task-redacted", 0);
    journal.transition("redacted", "result_pending");
    const digest = outbox.put({
      v: 1, kind: "task_result", id: "redacted", task_id: "task-redacted",
      results: [{ id: "result", ok: true, output: "DO_NOT_DISCLOSE_SECRETS" }],
    }).sha256;
    journal.transition("redacted", "delivered");
    journal.acknowledgeResult("redacted", "task-redacted", digest);
    journal.markPayloadReleased("redacted", digest);
    outbox.releaseAcknowledgedPayload("redacted", digest);
    journal.archiveFinalized(["redacted"], outbox, exec);
    const monitor = new MuseRecoveryIntegrityMonitor(port, 200, root);
    const success = monitor.check();
    expect(success).toMatchObject({ state: "healthy", archivedTombstones: 1 });
    const checkpointBefore = fs.readFileSync(museJournalFile(port, root));
    const archivedFile = fs.readdirSync(path.join(root, "muse-tombstones-" + port))[0];
    const archivePath = path.join(root, "muse-tombstones-" + port, archivedFile);
    fs.appendFileSync(archivePath, "CHANGED");
    const failure = monitor.check();
    expect(failure.state).toBe("degraded");
    expect(JSON.stringify(failure)).not.toContain("DO_NOT_DISCLOSE_SECRETS");
    expect(JSON.stringify(failure)).not.toContain(root);
    expect(JSON.stringify(failure)).not.toContain(archivePath);
    expect(fs.readFileSync(museJournalFile(port, root))).toEqual(checkpointBefore);
    expect(fs.readFileSync(outboxFile(port, root)).toString("utf8")).not.toContain("DO_NOT_DISCLOSE_SECRETS");
  });

  it("starts and stops polling without leaving timers or probing a network service", async () => {
    const { root, port } = fresh();
    fs.writeFileSync(path.join(root, "muse-results-" + port + ".json.key"), "orphan");
    let scans = 0;
    const monitor = new MuseRecoveryIntegrityMonitor(port, 100, root, () => {
      scans++;
      return { port, active: 0, archived: 0, encryptedResults: 0, encryptedIntents: 0, integrityBlocked: 0 };
    });
    monitor.start();
    monitor.start();
    expect(monitor.snapshot().state).toBe("healthy");
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(scans).toBeGreaterThanOrEqual(2);
    monitor.stop();
    const old = scans;
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(scans).toBe(old);
  });

  it("exposes redacted live health and offline integrity CLI without triggering repairs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-integrity-home-"));
    directories.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const port = await freePort();
    const root = path.join(home, ".superagent-r");
    fs.mkdirSync(root);
    const journal = new MuseBatchJournal(port, root);
    journal.claim("live-batch", "task", 0);
    const status = { port, active: 1, archived: 0, encryptedResults: 0, encryptedIntents: 0, integrityBlocked: 0 };
    let probes = 0;
    const host = await runChannelHost({
      port, wsPort: 9225, mode: "telegram-fallback",
      config: { botToken: "SECRET_TOKEN_TEST", groupId: "secret-group", museBotId: "secret-user" },
      startWatcher: async () => {},
      integrityIntervalMs: 100,
      integrityProbe: () => { probes++; return status; },
    });
    servers.push(host.server);
    let seen = host.health().recoveryIntegrity!;
    expect(seen).toMatchObject({ state: "healthy", activeBatches: 1 });
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(probes).toBeGreaterThanOrEqual(2);
    const url = "http://127.0.0.1:" + port + "/_channel/health";
    const live = await (await fetch(url)).json() as { recoveryIntegrity: Record<string, unknown> };
    expect(live.recoveryIntegrity.state).toBe("healthy");
    expect(JSON.stringify(live)).not.toContain("SECRET_TOKEN_TEST");
    expect(JSON.stringify(live)).not.toContain(root);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    const oldProbes = probes;
    await handleChannelHostCliCommand(["integrity", "--port", String(port)]);
    expect(probes).toBe(oldProbes);
    expect(output.join(" ")).toContain("cached live verification");
    expect(output.join(" ")).not.toContain("secret");
    await new Promise<void>(resolve => host.server.close(() => resolve()));
    servers.splice(servers.indexOf(host.server), 1);
    expect(await handleChannelHostCliCommand(["integrity", "--port", String(port)])).toBe(false);
    expect(output.join(" ")).toContain("offline full scan");
    expect(new MuseBatchJournal(port, root).claim("live-batch", "task2", 0)).toBe(false);
  });
});
