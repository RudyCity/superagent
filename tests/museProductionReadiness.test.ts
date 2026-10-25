import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateMuseReadiness } from "../src/core/runtime/museReadiness.js";
import { MuseWatchdogSupervisor, writeMuseWatchdogHeartbeat } from "../src/core/runtime/museWatchdogSupervisor.js";
import { probeMuseAlertDelivery, readMuseAlertProbe } from "../src/core/runtime/museAlertProbe.js";
import { runMuseDisasterRecoveryDrill } from "../src/core/runtime/museDisasterRecoveryDrill.js";
import { storeMuseDrillEvidence, readMuseDrillEvidence } from "../src/core/runtime/museDrillEvidence.js";
import { storeMuseAlertConfig } from "../src/core/remoteAgent/museAlertConfig.js";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseIncidentCenter } from "../src/core/remoteAgent/museIncidentCenter.js";
import { makeMuseRecoveryBackup } from "../src/core/remoteAgent/museRecoveryBackup.js";
import { handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";

const dirs: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-dr-readiness-"));
  dirs.push(home);
  const root = path.join(home, ".superagent-r");
  fs.mkdirSync(root);
  return { home, root, port: 51317, backup: path.join(home, "bundle") };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe("phase 4o independent watchdog, delivery proof and production readiness", () => {
  it("fail/warn closed in a fresh instance without starting or altering tools", () => {
    const f = fixture();
    const before = fs.readdirSync(f.root);
    const report = evaluateMuseReadiness({ port: f.port, root: f.root,
      host: { verified: false }, now: Date.now() });
    expect(report).toMatchObject({ status: "FAIL", version: 1 });
    expect(report.checks.find(c => c.id === "host")).toMatchObject({
      severity: "FAIL", code: "NO_VERIFIED_OWNER",
    });
    expect(report.checks.find(c => c.id === "backup")?.severity).toBe("WARN");
    expect(report.checks.find(c => c.id === "drill")?.severity).toBe("WARN");
    expect(report.checks.find(c => c.id === "delivery")?.severity).toBe("WARN");
    expect(report.checks.find(c => c.id === "watchdog")?.severity).toBe("WARN");
    expect(fs.readdirSync(f.root)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(f.root);
  });

  it("PASS only when owner, recovery, alert provider, proof, watchdog and recent backup all verify", async () => {
    const f = fixture();
    const now = Date.now();
    new MuseBatchJournal(f.port, f.root).claim("dr-readiness-reserved", "dr-task", 0);
    storeMuseAlertConfig(f.port, { mode: "webhook", url: "https://alerts.example.com/ops?secret=SHOULD_NOT_LEAK" }, f.root);
    writeMuseWatchdogHeartbeat(f.port, true, f.root, now - 500);
    const logs: Array<{ url: string; body: string }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      logs.push({ url, body: String(init.body) });
      return { ok: true } as Response;
    }) as typeof fetch;
    expect(await probeMuseAlertDelivery(f.port, f.root, fetcher, now - 200)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toContain('"test":true');
    expect(logs[0].body).not.toContain("SHOULD_NOT_LEAK");
    expect(readMuseAlertProbe(f.port, f.root, now)?.currentConfig).toBe(true);
    makeMuseRecoveryBackup(f.port, f.backup, f.root);
    const reportTime = Date.now();
    storeMuseDrillEvidence(f.port, 15, f.root, reportTime);
    const report = evaluateMuseReadiness({
      port: f.port, root: f.root, backup: f.backup, now: reportTime,
      host: { verified: true, mode: "muse-ws", status: "running" },
    });
    expect(report).toMatchObject({ status: "PASS", score: 100, counts: { fail: 0, warn: 0 } });
    expect(report.checks).toHaveLength(8);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("alerts.example.com");
    expect(serialized).not.toContain(f.root);
    const future = evaluateMuseReadiness({ port: f.port, root: f.root, backup: f.backup,
      now: reportTime + 25 * 3_600_000, host: { verified: true, mode: "muse-ws", status: "running" } });
    expect(future.status).toBe("FAIL"); // overdue watchdog is an operational failure
    expect(future.checks.find(c => c.id === "delivery")?.code).toBe("DELIVERY_TEST_STALE");
  });

  it("fails closed on corrupt recovery/backup/config, invalid heartbeat and provider changes", async () => {
    const f = fixture();
    const now = Date.now();
    new MuseBatchJournal(f.port, f.root).claim("still-in-review", "task", 0);
    storeMuseAlertConfig(f.port, { mode: "webhook", url: "https://alerts.example.com/first" }, f.root);
    const fetcher = (async () => ({ ok: true } as Response)) as typeof fetch;
    await probeMuseAlertDelivery(f.port, f.root, fetcher, now);
    makeMuseRecoveryBackup(f.port, f.backup, f.root);
    storeMuseAlertConfig(f.port, { mode: "webhook", url: "https://alerts.example.com/changed" }, f.root);
    expect(evaluateMuseReadiness({ port: f.port, root: f.root, now })
      .checks.find(c => c.id === "delivery")?.code).toBe("PROVIDER_CHANGED_SINCE_TEST");
    fs.writeFileSync(museJournalFile(f.port, f.root), "{bad-journal");
    const configFile = path.join(f.root, "muse-alert-config-" + f.port + ".json");
    fs.writeFileSync(configFile, "INVALID_CIPHERTEXT");
    fs.writeFileSync(path.join(f.root, "muse-watchdog-" + f.port + ".json"), "{}");
    fs.appendFileSync(path.join(f.backup, "muse-batches-" + f.port + ".json"), "BAD_BACKUP");
    const report = evaluateMuseReadiness({
      port: f.port, root: f.root, backup: f.backup, now,
      host: { verified: true, mode: "muse-ws", status: "running" },
    });
    expect(report.status).toBe("FAIL");
    const codes = report.checks.map(c => c.code);
    for (const expected of ["RECOVERY_UNREADABLE", "ALERT_CONFIG_INVALID",
      "WATCHDOG_STORAGE_INVALID", "BACKUP_INVALID"]) expect(codes).toContain(expected);
    expect(JSON.stringify(report)).not.toContain("INVALID_CIPHERTEXT");
    expect(JSON.stringify(report)).not.toContain(f.home);
  });

  it("bounded watchdog restart budget, interruption and explicit stop (never launches a channel host)", async () => {
    class Child extends EventEmitter {
      killed = false;
      kill() { this.killed = true; this.emit("exit", null, "SIGTERM"); return true; }
    }
    let launches = 0;
    const supervisor = new MuseWatchdogSupervisor({
      launch: () => {
        launches++;
        const child = new Child();
        queueMicrotask(() => child.emit("exit", 31, null));
        return child;
      },
      pause: async () => {},
      maxRestarts: 2, clock: () => Date.now(),
    });
    expect(await supervisor.start()).toEqual({ reason: "budget_exhausted", restarts: 2 });
    expect(launches).toBe(3);
    const child = new Child();
    const second = new MuseWatchdogSupervisor({ launch: () => child });
    const active = second.start();
    await Promise.resolve();
    second.stop();
    expect(await active).toEqual({ reason: "stopped", restarts: 0 });
    expect(child.killed).toBe(true);
  });

  it("CLI readiness and recovery-wizard use no real outbound traffic and do not initialize state", async () => {
    const f = fixture();
    vi.spyOn(os, "homedir").mockReturnValue(f.home);
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => messages.push(parts.join(" ")));
    const before = fs.readdirSync(f.root);
    await expect(handleChannelHostCliCommand(["readiness", "--port", String(f.port), "--json"]))
      .resolves.toBe(false);
    await expect(handleChannelHostCliCommand(["recovery-wizard", "--port", String(f.port)]))
      .resolves.toBe(false);
    expect(messages.join("\n")).toContain("NO_VERIFIED_OWNER");
    expect(messages.join("\n")).toContain("Operator-only:");
    await expect(handleChannelHostCliCommand(["alert-test", "--port", String(f.port)]))
      .rejects.toThrow(/confirm-send/);
    expect(fs.readdirSync(f.root)).toEqual(before);
  });

  it("explicit alert-test creates recent evidence only after successful HTTP, never after failure", async () => {
    const f = fixture();
    storeMuseAlertConfig(f.port, { mode: "webhook", url: "https://alerts.example.org/test" }, f.root);
    expect(await probeMuseAlertDelivery(f.port, f.root,
      (async () => ({ ok: false } as Response)) as typeof fetch)).toBe(false);
    expect(readMuseAlertProbe(f.port, f.root)).toBeNull();
    expect(await probeMuseAlertDelivery(f.port, f.root,
      (async () => ({ ok: true } as Response)) as typeof fetch)).toBe(true);
    expect(readMuseAlertProbe(f.port, f.root)?.currentConfig).toBe(true);
    expect(new MuseIncidentCenter(f.port, f.root).list()).toEqual([]); // no fake incident
  });
  it("stores local sanitized drill evidence and rejects invalid records", () => {
    const f = fixture();
    expect(readMuseDrillEvidence(f.port, f.root)).toBeNull();
    expect(() => storeMuseDrillEvidence(f.port, 14, f.root)).toThrow();
    storeMuseDrillEvidence(f.port, 15, f.root);
    expect(readMuseDrillEvidence(f.port, f.root)).toMatchObject({
      isolated: true, passedChecks: 15, failedChecks: 0,
    });
    const file = path.join(f.root, "muse-dr-drill-" + f.port + ".json");
    fs.writeFileSync(file, "INVALID");
    expect(() => readMuseDrillEvidence(f.port, f.root)).toThrow();
    expect(evaluateMuseReadiness({ port: f.port, root: f.root })
      .checks.find(c => c.id === "drill")?.code).toBe("DR_EVIDENCE_INVALID");
  });
  it("executes a real isolated unclean child crash and restores without duplicate side effects", async () => {
    const report = await runMuseDisasterRecoveryDrill();
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.checks).toContain("crashed_batch_reserved_once");
    expect(report.checks).toContain("tampered_backup_rejected_before_restore");
    expect(report.checks).toContain("restored_started_batch_replay_denied");
    expect(report.checks).toHaveLength(15);
  });
});
