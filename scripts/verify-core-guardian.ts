/**
 * Real local-only acceptance for owner-scoped Core guardian recovery.
 * Creates only test-owned processes with a private profile and random loopback
 * port. Never kills or adopts any production process or external tunnel.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";
import { coreCheckpointPath } from "../src/core/runtime/coreSupervisorCheckpoint.js";

const repo = path.resolve(import.meta.dir, "..");
const cli = path.join(repo, "dist", "cli.js");
if (!fs.existsSync(cli)) throw new Error("Build first: bun run build");
const base = path.join(os.homedir(), ".superagent-local-staging");
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(base, "core-guardian-" + crypto.randomBytes(4).toString("hex") + "-"));
const config = path.join(root, "profile");
const workspace = path.join(root, "workspace");
fs.mkdirSync(config, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const originalConfig = process.env.SUPERAGENT_CONFIG_DIR;
process.env.SUPERAGENT_CONFIG_DIR = config;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/(?:_KEY|_TOKEN|_PASSWORD|_SECRET|_CREDENTIAL)$/i.test(key) ||
      /^(?:SUPERAGENT_CORE_|SUPERAGENT_MUSE_ALERT_|SUPERAGENT_SESSION_ID$)/.test(key)) delete env[key];
}
env.SUPERAGENT_CONFIG_DIR = config;
env.SUPERAGENT_CORE_STAGING = "1";
env.HOME = root;
env.USERPROFILE = root;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (port < 1024) throw new Error("No safe random loopback port");
  return port;
}
function killOwned(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", timeout: 5000 });
    } else process.kill(pid, "SIGKILL");
  } catch {}
}
async function waitFor<T>(fn: () => Promise<T | null>, deadlineMs = 45_000): Promise<T> {
  const start = Date.now();
  let lastIssue = "";
  while (Date.now() - start < deadlineMs) {
    const value = await fn().catch(error => {
      lastIssue = String(error).slice(0, 250);
      return null;
    });
    if (value) return value;
    await sleep(250);
  }
  throw new Error("Isolated guardian acceptance timed out: " + lastIssue);
}
async function getOwner(port: number) {
  return requestCoreSupervisor("status", port, 1600);
}
function bearer(port: number) {
  const payload = JSON.parse(fs.readFileSync(path.join(config, "server-info-" + port + ".json"), "utf8"));
  if (typeof payload.authToken !== "string" || payload.authToken.length < 40) throw new Error("Invalid staging bearer");
  return payload.authToken as string;
}
async function api(port: number, token: string, url: string, body?: Record<string, unknown>) {
  const response = await fetch("http://127.0.0.1:" + port + url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      "x-client-mode": "tline",
      ...(body ? { "content-type": "application/json" } : {}),
    }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return { code: response.status, data: await response.json().catch(() => null) as any };
}
const port = await availablePort();
let frontPort = await availablePort();
while (frontPort === port) frontPort = await availablePort();
const checks: string[] = [];
function check(code: string, truthy: unknown) {
  if (!truthy) throw new Error("Guardian acceptance failed: " + code);
  checks.push(code);
}
const ownedPids = new Set<number>();
let guardian: ChildProcess | null = null;
let transport: ChildProcess | null = null;
let errorTail = "";
let childTail = "";
try {
  check("distinct_random_isolated_port", port !== 7888 && port !== 7666 && port !== 9864);
  check("no_prior_ownership_or_checkpoint", !fs.existsSync(coreCheckpointPath(port)));
  guardian = spawn(process.execPath, [cli, "core", "guard", "--port", String(port),
    "--stop-on-stdin"], {
    cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  if (!guardian.pid) throw new Error("No guardian PID");
  guardian.stderr?.on("data", chunk => { errorTail = (errorTail + String(chunk)).slice(-1800); });
  guardian.stdout?.on("data", chunk => { childTail = (childTail + String(chunk)).slice(-1800); });
  const first = await waitFor(async () => {
    if (guardian?.exitCode !== null) throw new Error("Guardian stopped: " + errorTail);
    const value = await getOwner(port);
    return value.supervisorPid !== guardian?.pid && value.active.pid > 0 ? value : null;
  });
  ownedPids.add(first.supervisorPid);
  ownedPids.add(first.active.pid);
  check("guardian_starts_verified_independent_core", first.supervisorPid !== guardian.pid);
  check("guardian_scoped_lease", fs.existsSync(path.join(config, "core-guardian-" + port + ".json")));
  const initialBearer = bearer(port);
  const id = "guardian_stage_" + crypto.randomBytes(5).toString("hex");
  const initialized = await api(port, initialBearer, "/api/init", {
    sessionId: id, mode: "single", workspace,
  });
  check("session_initialized_before_supervisor_crash",
    initialized.code === 200 && initialized.data?.sessionId === id);
  check("durable_affinity_checkpoint", (await getOwner(port)).affinitySessions === 1);
  // Independent T-Line transport must outlive a verified Core supervisor crash.
  transport = spawn(process.execPath, [cli, "transport", "start",
    "--port", String(frontPort), "--core-port", String(port)], {
    cwd: workspace, env, stdio: "ignore", windowsHide: true, detached: true,
  });
  if (!transport.pid) throw new Error("No staging transport PID");
  ownedPids.add(transport.pid);
  const initialTransport = await waitFor(async () => {
    const r = await fetch("http://127.0.0.1:" + frontPort + "/_transport/health", {
      signal: AbortSignal.timeout(1600),
    });
    const data = await r.json() as { service: string; pid: number; corePort: number; backendReady: boolean };
    return data.service === "superagent-transport-host" && data.backendReady &&
      data.corePort === port ? data : null;
  }, 15_000);
  check("independent_tline_frontdoor_verified", initialTransport.pid === transport.pid);
  const firstViaTline = await api(frontPort, initialBearer, "/api/status?sessionId=" + id);
  check("old_session_accessible_via_tline_proxy_before_crash",
    firstViaTline.code === 200 && firstViaTline.data?.sessionId === id);
  const secondAttempt = spawnSync(process.execPath, [cli, "core", "guard", "--port", String(port)], {
    cwd: workspace, env, stdio: "pipe", timeout: 8000, encoding: "utf8", windowsHide: true,
  });
  check("double_guardian_refused", secondAttempt.status !== 0);
  // Only kill the verified exact supervisor PID launched by this test-owned guardian.
  const verifiedForCrash = await getOwner(port);
  check("owned_supervisor_identity_before_injection",
    verifiedForCrash.supervisorPid === first.supervisorPid);
  killOwned(first.supervisorPid);
  const recovered = await waitFor(async () => {
    const status = await getOwner(port);
    return status.supervisorPid !== first.supervisorPid && status.recovered ? status : null;
  }, 48_000);
  ownedPids.add(recovered.supervisorPid);
  ownedPids.add(recovered.active.pid);
  for (const gen of recovered.retained) ownedPids.add(gen.pid);
  check("guardian_auto_recovers_owned_crashed_supervisor",
    recovered.recovered === true && recovered.supervisorPid !== first.supervisorPid);
  check("worker_survives_crash_without_restart", recovered.active.pid === first.active.pid);
  check("session_affinity_restored_from_checkpoint", recovered.affinitySessions === 1);
  check("client_bearer_preserved", bearer(port) === initialBearer);
  const oldSession = await api(port, initialBearer, "/api/status?sessionId=" + id);
  check("old_session_routed_after_recovery",
    oldSession.code === 200 && oldSession.data?.sessionId === id);
  const restoredTransport = await fetch("http://127.0.0.1:" + frontPort + "/_transport/health", {
    signal: AbortSignal.timeout(1800),
  }).then(res => res.json()) as { pid: number; backendReady: boolean };
  check("tline_listener_pid_unchanged_across_crash",
    restoredTransport.pid === initialTransport.pid && restoredTransport.backendReady);
  const recoveredViaTline = await api(frontPort, initialBearer, "/api/status?sessionId=" + id);
  check("tline_proxy_routes_recovered_session",
    recoveredViaTline.code === 200 && recoveredViaTline.data?.sessionId === id);
  const reconnectProbe = spawnSync(process.execPath, [cli, "core", "reconnect-check",
    "--front-port", String(frontPort), "--core-port", String(port),
    "--session-id", id], { cwd: workspace, env, stdio: "pipe",
      encoding: "utf8", timeout: 10_000, windowsHide: true });
  check("tline_cli_reconnect_check_uses_only_get_and_verifies_session",
    reconnectProbe.status === 0 &&
    reconnectProbe.stdout.includes('"sessionVerified": true') &&
    reconnectProbe.stdout.includes('"issuedMethods": [') &&
    reconnectProbe.stdout.includes('"automaticChatReplayAllowed": false'));
  const newSession = await api(port, initialBearer, "/api/init", {
    sessionId: id + "_new", mode: "single", workspace,
  });
  check("new_session_accepted_after_guardian_recovery",
    newSession.code === 200 && newSession.data?.sessionId === id + "_new");
  guardian.stdin?.write("STOP\n");
  await waitFor(async () => (guardian?.exitCode !== null || guardian?.signalCode !== null) ?
    true : null, 6000);
  check("guardian_exit_does_not_stop_core", (await getOwner(port)).supervisorPid === recovered.supervisorPid);
  const transportStillUp = await fetch("http://127.0.0.1:" + frontPort + "/_transport/health", {
    signal: AbortSignal.timeout(1800),
  }).then(res => res.json()) as { pid: number; backendReady: boolean };
  check("guardian_exit_does_not_stop_tline",
    transportStillUp.pid === initialTransport.pid && transportStillUp.backendReady);
  await waitFor(async () => !fs.existsSync(path.join(config, "core-guardian-" + port + ".json")) ?
    true : null, 5000);
  check("guard_lease_cleans_up_on_graceful_exit", true);
  const bootAlreadyRunning = spawnSync(process.execPath, [cli, "core", "boot",
    "--port", String(port)], { cwd: workspace, env, encoding: "utf8",
      stdio: "pipe", timeout: 8000, windowsHide: true });
  check("boot_noop_when_authenticated_owner_already_running",
    bootAlreadyRunning.status === 0 &&
      bootAlreadyRunning.stdout.includes("verified owner already active"));
  const beforeBootRecovery = await getOwner(port);
  check("boot_crash_injection_targets_owned_supervisor",
    beforeBootRecovery.supervisorPid === recovered.supervisorPid);
  // Simulate login-time recovery with surviving in-memory workers.
  killOwned(recovered.supervisorPid);
  const bootProcess = spawn(process.execPath, [cli, "core", "boot",
    "--port", String(port)], { cwd: workspace, env, stdio: "ignore", windowsHide: true, detached: true });
  if (!bootProcess.pid) throw new Error("No Core boot PID");
  ownedPids.add(bootProcess.pid);
  const bootRecovered = await waitFor(async () => {
    const state = await getOwner(port);
    return state.supervisorPid === bootProcess.pid && state.recovered ? state : null;
  }, 30_000);
  check("boot_recovers_only_authenticated_surviving_workers",
    bootRecovered.active.pid === first.active.pid && bootRecovered.affinitySessions === 2);
  const viaTlineAfterBoot = await api(frontPort, initialBearer, "/api/status?sessionId=" + id);
  check("tline_routes_original_session_after_login_boot",
    viaTlineAfterBoot.code === 200 && viaTlineAfterBoot.data?.sessionId === id);
  // A whole-machine reboot has NO surviving workers. A checkpoint must not
  // authorize automatic execution of a new agent as if it were the old one.
  killOwned(bootProcess.pid);
  killOwned(first.active.pid);
  const deniedColdBoot = spawnSync(process.execPath, [cli, "core", "boot",
    "--port", String(port)], { cwd: workspace, env, stdio: "pipe",
      timeout: 12_000, encoding: "utf8", windowsHide: true });
  check("boot_refuses_to_replay_sessions_when_every_worker_is_dead",
    deniedColdBoot.status !== 0 &&
      (deniedColdBoot.stderr + deniedColdBoot.stdout).includes("No authenticated worker survived"));
  const auditFile = coreCheckpointPath(port);
  const checkpointBeforeAudit = fs.readFileSync(auditFile);
  const coldAudit = spawnSync(process.execPath, [cli, "core", "boot-audit",
    "--port", String(port)], { cwd: workspace, env, stdio: "pipe",
    encoding: "utf8", timeout: 12000, windowsHide: true });
  check("cold_boot_audit_is_read_only_and_refuses_total_worker_loss",
    coldAudit.status === 0 &&
    coldAudit.stdout.includes('"decision": "operator_review"') &&
    coldAudit.stdout.includes('"automaticToolReplay": false') &&
    Buffer.compare(fs.readFileSync(auditFile), checkpointBeforeAudit) === 0);
  const evidence = spawnSync(process.execPath, [cli, "core", "evidence-snapshot",
    "--port", String(port)], { cwd: workspace, env, stdio: "pipe",
      encoding: "utf8", timeout: 22_000, windowsHide: true });
  const evidenceData = evidence.status === 0 ?
    JSON.parse(evidence.stdout) as {
      folder: string; restartAuthorized: boolean; toolReplayAuthorized: boolean;
      database: { integrity: string }; files: Array<{ name: string }>;
    } : null;
  check("cold_evidence_snapshot_verified_without_restarting_or_erasing",
    evidenceData &&
    evidenceData.restartAuthorized === false &&
    evidenceData.toolReplayAuthorized === false &&
    evidenceData.database.integrity === "ok" &&
    evidenceData.files.some(file => file.name === "core-checkpoint.json") &&
    fs.existsSync(path.join(evidenceData.folder, "manifest.json")) &&
    Buffer.compare(fs.readFileSync(auditFile), checkpointBeforeAudit) === 0);
  const report = {
    version: 1, phase: "core-guardian-local-staging", ok: true, port, frontPort,
    root, verifiedChecks: checks.length, checks,
    ownerCreatedByGuardian: true, workerSurvivedSupervisorCrash: true,
    externalServicesTouched: false, externalNotificationCount: 0,
    coreSurvivesGuardianShutdown: true, cleanedUpAfterTest: true,
    completedAt: Date.now(),
  };
  const reportPath = path.join(root, "guardian-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} catch (error) {
  const msg = String(error) + " " + errorTail.slice(-450) + " " + childTail.slice(-250);
  console.error("CORE_GUARDIAN_STAGE_FAIL: " + msg);
  process.exitCode = 1;
} finally {
  if (guardian?.exitCode === null && guardian.pid) killOwned(guardian.pid);
  // Only exact worker/supervisor PIDs seen in authenticated status responses.
  for (const pid of ownedPids) killOwned(pid);
  if (originalConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfig;
}
