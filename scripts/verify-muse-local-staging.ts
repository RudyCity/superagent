/**
 * End-to-end local-only stage, deliberate idle mode: no Muse/Telegram/watcher,
 * no outbound alert, no external LLM and no interference with live ~/.superagent-r.
 * Persists private staging evidence and verified backup outside the repo.
 *
 * bun scripts/verify-muse-local-staging.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MuseBatchJournal } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseIncidentCenter } from "../src/core/remoteAgent/museIncidentCenter.js";
import { storeMuseAlertConfig, loadMuseAlertConfig } from "../src/core/remoteAgent/museAlertConfig.js";
import { inspectMuseRecoveryStorage, verifyMuseRecoveryBackup } from "../src/core/remoteAgent/museRecoveryBackup.js";
import { readMuseWatchdogHeartbeat } from "../src/core/runtime/museWatchdogSupervisor.js";

const begin = Date.now();
const done: string[] = [];
const test = (id: string, condition: unknown) => {
  if (!condition) throw new Error("Staging verification failed: " + id);
  done.push(id);
};
const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repo, "dist", "cli.js");
if (!fs.existsSync(cli)) throw new Error("Build first: bun run build");
const base = path.join(os.homedir(), ".superagent-local-staging");
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const root = path.join(base, new Date().toISOString().replace(/[.:]/g, "-") + "-" +
  crypto.randomBytes(4).toString("hex"));
fs.mkdirSync(root, { mode: 0o700, recursive: false });
const home = path.join(root, "home");
const remote = path.join(home, ".superagent-r");
const destination = path.join(root, "backup");
const restoredHome = path.join(root, "restored-home");
const restoredRoot = path.join(restoredHome, ".superagent-r");
fs.mkdirSync(remote, { recursive: true, mode: 0o700 });
fs.mkdirSync(restoredHome, { recursive: true, mode: 0o700 });
const cleanEnv = (selectedHome: string): NodeJS.ProcessEnv => ({
  ...process.env,
  USERPROFILE: selectedHome, HOME: selectedHome,
  SUPERAGENT_CONFIG_DIR: path.join(selectedHome, ".superagent-r"),
  SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "",
  SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN: "",
  SUPERAGENT_MUSE_ALERT_TELEGRAM_CHAT_ID: "",
  NODE_ENV: "production", VITEST: "", BUN_TEST: "",
  SUPERAGENT_SESSION_ID: "",
});
const originalEnv = cleanEnv(home);
const restoreEnv = cleanEnv(restoredHome);
function localCli(args: string[], env = originalEnv, mustPass = true): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cli, "channel-host", ...args], {
    cwd: root, env, encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 100_000,
  });
  if (mustPass && res.status !== 0) throw new Error("Isolated CLI failed: " + args[0] +
    " (" + String(res.status) + ") " + String(res.stderr).slice(0, 400));
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No free staging loopback port");
  return address.port;
}
function workerSource(port: number): string {
  const entry = pathToFileURL(path.join(repo, "dist", "core", "runtime", "channelHost.js")).href;
  return [
    "const {runChannelHost}=await import(" + JSON.stringify(entry) + ");",
    "const {server}=await runChannelHost({port:" + port + ",mode:'idle',wsPort:9225});",
    "process.stdout.write('STAGING_HOST_READY\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (data)=>{if(String(data).includes('STOP')){server.close(()=>process.exit(0));}});",
  ].join("\n");
}
async function startHost(port: number) {
  const child = spawn(process.execPath, ["-e", workerSource(port)], {
    cwd: root, env: originalEnv, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  let output = "";
  let stderr = "";
  child.stdout.on("data", chunk => { output += String(chunk).slice(0, 1000); });
  child.stderr.on("data", chunk => { stderr += String(chunk).slice(0, 1000); });
  const start = Date.now();
  while (!output.includes("STAGING_HOST_READY")) {
    if (child.exitCode !== null || Date.now() - start > 9000) {
      child.kill();
      throw new Error("Isolated staging host did not start: " + stderr.slice(0, 300));
    }
    await new Promise(resolve => setTimeout(resolve, 45));
  }
  return child;
}
async function stopHost(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.stdin.write("STOP\n");
  const left = await Promise.race([
    new Promise<boolean>(resolve => child.once("exit", code => resolve(code === 0))),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 6_000)),
  ]);
  if (!left) { child.kill(); throw new Error("Staging host graceful shutdown failed"); }
}
async function hostHealth(port: number) {
  const response = await fetch("http://127.0.0.1:" + port + "/_channel/health", {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("Staging host unhealthy");
  return await response.json() as {
    port: number; pid: number; instanceId: string; mode: string; status: string;
    watcherActive: boolean; recoveryIntegrity: { state: string };
  };
}
let active: ChildProcessWithoutNullStreams | null = null;
let lastReport: Record<string, unknown> = {};
try {
  const port = await freePort();
  test("reserved_unique_loopback_port", port !== 7666 && port !== 9864 && port !== 7892 && port !== 7888);
  test("private_isolated_home_not_production",
    path.resolve(remote) !== path.join(os.homedir(), ".superagent-r"));
  // A task-signal metadata-only checkpoint creates the durable journal without
  // executing ANY tool or simulating a fake external result ACK.
  const journal = new MuseBatchJournal(port, remote);
  journal.observeTask("local-staging-metadata", "accepted");
  journal.observeTask("local-staging-metadata", "done_seen");
  test("safe_metadata_only_journal_bootstrap", journal.list().length === 0 &&
    journal.taskRecovery().length === 1 && inspectMuseRecoveryStorage(port, remote).integrityBlocked === 0);
  storeMuseAlertConfig(port, { mode: "disabled" }, remote);
  test("provider_explicitly_disabled_even_if_external_env_exists",
    loadMuseAlertConfig(port, remote)?.mode === "disabled");

  active = await startHost(port);
  const live = await hostHealth(port);
  const registration = JSON.parse(fs.readFileSync(path.join(remote,
    "channel-host-" + port + ".json"), "utf8"));
  test("real_loopback_host_verified_identity",
    live.port === port && live.pid === active.pid && registration.instanceId === live.instanceId);
  test("idle_mode_never_starts_external_watcher",
    live.mode === "idle" && live.status === "idle" && live.watcherActive === false);
  test("live_integrity_healthy", live.recoveryIntegrity.state === "healthy");
  const unauthorized = await fetch("http://127.0.0.1:" + port + "/_channel/ipc", {
    method: "POST", body: JSON.stringify({ operation: "task" }),
    headers: { "content-type": "application/json" },
  });
  test("unauthorized_mutation_rejected", unauthorized.status === 401);
  const online = localCli(["watchdog-once", "--port", String(port)]);
  test("real_watchdog_verifies_host_online",
    online.stdout.includes("verified-online") &&
    readMuseWatchdogHeartbeat(port, remote)?.online === true);
  const forbiddenBackup = localCli(["backup", "--port", String(port),
    "--destination", destination], originalEnv, false);
  test("live_owner_blocks_offline_backup", forbiddenBackup.status !== 0 &&
    !fs.existsSync(destination));

  await stopHost(active);
  active = null;
  test("graceful_shutdown_releases_lock_and_registration",
    !fs.existsSync(path.join(remote, "channel-host-" + port + ".json")) &&
    !fs.existsSync(path.join(remote, "muse-batches-" + port + ".json.review.lock")));
  const offline = localCli(["watchdog-once", "--port", String(port)]);
  test("independent_watchdog_detects_offline", offline.stdout.includes("offline") &&
    readMuseWatchdogHeartbeat(port, remote)?.online === false &&
    new MuseIncidentCenter(port, remote).summary().open === 1);

  active = await startHost(port);
  const restarted = await hostHealth(port);
  test("verified_host_restart_new_identity", restarted.instanceId !== live.instanceId &&
    restarted.recoveryIntegrity.state === "healthy");
  const recovered = localCli(["watchdog-once", "--port", String(port)]);
  test("watchdog_observes_verified_recovery", recovered.stdout.includes("verified-online") &&
    new MuseIncidentCenter(port, remote).summary().resolved === 1);
  const safeNoDelivery = localCli(["deliver-alerts", "--port", String(port)]);
  test("outbox_kept_no_external_delivery", safeNoDelivery.stdout.includes("disabled") &&
    new MuseIncidentCenter(port, remote).summary().pending > 0);
  await stopHost(active);
  active = null;

  const created = localCli(["backup", "--port", String(port), "--destination", destination]);
  test("offline_backup_created_and_verified", created.stdout.includes("backup created") &&
    verifyMuseRecoveryBackup(destination, port).integrityBlocked === 0);
  const verified = localCli(["verify-backup", "--port", String(port), "--source", destination]);
  test("cli_backup_verified", verified.stdout.includes("bundle validated"));
  const restored = localCli(["restore-backup", "--port", String(port),
    "--source", destination, "--confirm-port", String(port)], restoreEnv);
  test("restore_into_separate_empty_staging_home", restored.stdout.includes("restored") &&
    inspectMuseRecoveryStorage(port, restoredRoot).integrityBlocked === 0);
  const originalFacts = new MuseBatchJournal(port, remote).taskRecovery();
  const restoredFacts = new MuseBatchJournal(port, restoredRoot).taskRecovery();
  test("restored_recovery_journal_matches", JSON.stringify(originalFacts) === JSON.stringify(restoredFacts));
  test("restored_provider_still_disabled", loadMuseAlertConfig(port, restoredRoot)?.mode === "disabled");
  test("restored_alert_outbox_kept_without_external_send",
    new MuseIncidentCenter(port, restoredRoot).summary().pending > 0);

  const readiness = localCli(["readiness", "--port", String(port),
    "--backup", destination, "--json"]);
  const state = JSON.parse(readiness.stdout.slice(readiness.stdout.indexOf('{"version"'))) as {
    score: number; status: string; checks: Array<{ id: string; code: string }>;
  };
  test("staging_not_mislabeled_production_pass", state.status !== "PASS" &&
    state.checks.some(check => check.id === "delivery" && check.code === "DELIVERY_NOT_TESTED"));
  // Keep backup and evidence, never the previously used host/listener running.
  lastReport = { version: 1, phase: "local-only-staging", ok: true, port,
    root, backup: destination, restoredRoot,
    outboundNotifications: 0, externalWatcherStarted: false,
    liveHostLeftRunning: false, verifiedChecks: done.length, checks: done,
    readiness: { status: state.status, score: state.score },
    completedAt: Date.now(), durationMs: Date.now() - begin };
  const reportFile = path.join(root, "staging-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(lastReport, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...lastReport, reportFile }, null, 2));
} catch (error) {
  const failed = { version: 1, ok: false, phase: "local-only-staging",
    root, passedChecks: done.length, failed: String(error).slice(0, 450) };
  fs.writeFileSync(path.join(root, "staging-error.json"), JSON.stringify(failed, null, 2));
  console.error(JSON.stringify(failed));
  process.exitCode = 1;
} finally {
  if (active) {
    try { await stopHost(active); }
    catch { active.kill(); }
  }
}
