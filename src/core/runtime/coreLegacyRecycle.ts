/**
 * Guarded migration of a legacy direct Core server into the supervised Core lifecycle.
 *
 * "restart" remains supervisor-only and fail-closed. "recycle" is an explicit
 * migration path requiring exact listener PID, process birth identity, command
 * digest, authenticated server-info ownership, and a fresh target build.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { getPackageRootDir, getRootConfigDir } from "../config/paths.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { inspectCoreBuild } from "./coreBuildIdentity.js";
import { coreCheckpointPath } from "./coreSupervisorCheckpoint.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "./managedSidecarLedger.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";
import { recordLifecycleEvent, operationHashPrefix } from "./lifecycleTimeline.js";

export type CoreClientMode = "tline" | "chrome-extension";
export type LegacyCoreRecyclePlan = {
  service: "core";
  action: "recycle";
  port: number;
  operationId: string;
  expectedOwnerPid: number;
  expectedProcessIdentity: string;
  expectedLegacyCommandDigest: string;
  expectedBuildDigest: string;
  clientMode: CoreClientMode;
  note: string;
};

type LegacyProcessDescriptor = {
  pid: number;
  executablePath: string;
  commandLine: string;
};

type ServerInfo = {
  port: number;
  pid: number;
  authToken: string;
  startedAt: number;
};

const validPort = (value: number) =>
  Number.isSafeInteger(value) && value >= 1024 && value <= 65535;

const validIdentity = (value: string) =>
  /^(?:win:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/.test(value);

const hashText = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

function canonical(value: string): string {
  try { return fs.realpathSync.native(value); }
  catch { return path.resolve(value); }
}

function readServerInfo(port: number): ServerInfo {
  if (!validPort(port)) throw new Error("CORE_RECYCLE_INVALID_PORT");
  const file = path.join(getRootConfigDir(), `server-info-${port}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 20 || stat.size > 4096)
    throw new Error("CORE_RECYCLE_SERVER_INFO_UNSAFE");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServerInfo>;
  if (
    value.port !== port ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.authToken !== "string" ||
    !/^[A-Za-z0-9._~-]{24,256}$/.test(value.authToken) ||
    !Number.isSafeInteger(value.startedAt) ||
    Number(value.startedAt) <= 0
  ) throw new Error("CORE_RECYCLE_SERVER_INFO_INVALID");
  return value as ServerInfo;
}

function readWindowsDescriptor(pid: number): LegacyProcessDescriptor {
  const script =
    "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid +
    "' -ErrorAction Stop; if($null -eq $p){exit 3}; " +
    "$p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const raw = execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true });
  const value = JSON.parse(raw.trim()) as Record<string, unknown>;
  if (
    Number(value.ProcessId) !== pid ||
    typeof value.ExecutablePath !== "string" ||
    typeof value.CommandLine !== "string" ||
    value.CommandLine.length > 8192
  ) throw new Error("CORE_RECYCLE_PROCESS_DESCRIPTOR_INVALID");
  return { pid, executablePath: value.ExecutablePath, commandLine: value.CommandLine };
}

function readLinuxDescriptor(pid: number): LegacyProcessDescriptor {
  const base = `/proc/${pid}`;
  const executablePath = fs.readlinkSync(path.join(base, "exe"));
  const commandLine = fs.readFileSync(path.join(base, "cmdline"))
    .toString("utf8").split("\0").filter(Boolean).join(" ");
  if (!commandLine || commandLine.length > 8192)
    throw new Error("CORE_RECYCLE_PROCESS_DESCRIPTOR_INVALID");
  return { pid, executablePath, commandLine };
}

export function readLegacyCoreProcessDescriptor(pid: number): LegacyProcessDescriptor {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("CORE_RECYCLE_INVALID_OWNER_PID");
  if (process.platform === "win32") return readWindowsDescriptor(pid);
  if (process.platform === "linux") return readLinuxDescriptor(pid);
  throw new Error("CORE_RECYCLE_PLATFORM_UNSUPPORTED");
}

function commandHasServerPort(commandLine: string, port: number): boolean {
  return new RegExp(`(?:^|\\s)--server(?:=|\\s+)"?${port}"?(?:\\s|$)`, "i")
    .test(commandLine);
}

function commandLooksLikeSuperAgent(commandLine: string): boolean {
  return /superagent[\\/]dist[\\/]cli\.js/i.test(commandLine) ||
    /superagent[\\/]src[\\/]cli\.tsx/i.test(commandLine);
}

function inferClientMode(commandLine: string): CoreClientMode {
  const match = /--client-mode(?:=|\s+)"?([a-z-]+)"?/i.exec(commandLine);
  return match?.[1] === "chrome-extension" ? "chrome-extension" : "tline";
}

function verifyLegacyDescriptor(descriptor: LegacyProcessDescriptor, port: number) {
  const exe = path.basename(descriptor.executablePath).toLowerCase();
  if (!["bun.exe", "bun", "node.exe", "node"].includes(exe))
    throw new Error("CORE_RECYCLE_UNEXPECTED_RUNTIME_EXECUTABLE");
  if (!commandLooksLikeSuperAgent(descriptor.commandLine) ||
      !commandHasServerPort(descriptor.commandLine, port))
    throw new Error("CORE_RECYCLE_PROCESS_IS_NOT_LEGACY_SUPERAGENT_CORE");
}

async function authenticatedCoreProbe(port: number, authToken: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    method: "GET",
    headers: { Authorization: "Bearer " + authToken },
    redirect: "error",
    signal: AbortSignal.timeout(1800),
  });
  if (!response.ok) throw new Error("CORE_RECYCLE_AUTHENTICATED_PROBE_FAILED");
  await response.arrayBuffer();
}

function targetEntry(): string {
  const entry = path.join(getPackageRootDir(), "dist", "cli.js");
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("CORE_RECYCLE_TARGET_ENTRY_UNSAFE");
  return canonical(entry);
}

async function assertNoSupervisedOwner(port: number) {
  try {
    const current = await requestCoreSupervisor("status", port, 900);
    if (current?.publicPort === port)
      throw new Error("CORE_RECYCLE_ALREADY_SUPERVISED");
  } catch (error) {
    if (error instanceof Error && error.message === "CORE_RECYCLE_ALREADY_SUPERVISED")
      throw error;
  }
}

async function captureLegacyEvidence(port: number) {
  if (!validPort(port)) throw new Error("CORE_RECYCLE_INVALID_PORT");
  await assertNoSupervisedOwner(port);
  if (fs.existsSync(coreCheckpointPath(port)))
    throw new Error("CORE_RECYCLE_CHECKPOINT_PRESENT_USE_RECOVER");

  const listeners = readListenerOwners();
  if (!listeners) throw new Error("CORE_RECYCLE_LISTENER_OWNERSHIP_UNAVAILABLE");
  const ownerPid = listeners.get(port);
  if (!ownerPid) throw new Error("CORE_RECYCLE_NO_LISTENER");

  const serverInfo = readServerInfo(port);
  if (serverInfo.pid !== ownerPid)
    throw new Error("CORE_RECYCLE_SERVER_INFO_PID_MISMATCH");

  const descriptor = readLegacyCoreProcessDescriptor(ownerPid);
  verifyLegacyDescriptor(descriptor, port);
  const identity = await readProcessStartIdentity(ownerPid);
  if (!identity || !validIdentity(identity))
    throw new Error("CORE_RECYCLE_PROCESS_IDENTITY_UNAVAILABLE");
  await authenticatedCoreProbe(port, serverInfo.authToken);

  return {
    ownerPid,
    processIdentity: identity,
    commandDigest: hashText(descriptor.commandLine),
    clientMode: inferClientMode(descriptor.commandLine),
    serverInfo,
  };
}

export async function planLegacyCoreRecycle(port = 7888): Promise<LegacyCoreRecyclePlan> {
  const evidence = await captureLegacyEvidence(port);
  const build = inspectCoreBuild(targetEntry(), { requireFreshCompiled: true });
  return {
    service: "core",
    action: "recycle",
    port,
    operationId: crypto.randomUUID(),
    expectedOwnerPid: evidence.ownerPid,
    expectedProcessIdentity: evidence.processIdentity,
    expectedLegacyCommandDigest: evidence.commandDigest,
    expectedBuildDigest: build.digest,
    clientMode: evidence.clientMode,
    note: "Guarded legacy migration: reverify listener PID, process birth identity, command digest and authenticated Core; graceful shutdown only, then start a fresh supervised Core from the exact fresh build.",
  };
}

function assertPlan(plan: LegacyCoreRecyclePlan) {
  if (
    plan.service !== "core" ||
    plan.action !== "recycle" ||
    !validPort(plan.port) ||
    !Number.isSafeInteger(plan.expectedOwnerPid) ||
    plan.expectedOwnerPid <= 0 ||
    !validIdentity(plan.expectedProcessIdentity) ||
    !/^[a-f0-9]{64}$/.test(plan.expectedLegacyCommandDigest) ||
    !/^[a-f0-9]{64}$/.test(plan.expectedBuildDigest) ||
    !["tline", "chrome-extension"].includes(plan.clientMode)
  ) throw new Error("CORE_RECYCLE_INVALID_PLAN");
  validateCoreOperationId(plan.operationId);
}

function recycleFingerprint(plan: LegacyCoreRecyclePlan) {
  return sidecarOperationFingerprint({
    service: "core",
    action: "recycle",
    port: plan.port,
    expectedOwnerPid: plan.expectedOwnerPid,
    expectedProcessIdentity: plan.expectedProcessIdentity,
    expectedLegacyCommandDigest: plan.expectedLegacyCommandDigest,
    expectedBuildDigest: plan.expectedBuildDigest,
    clientMode: plan.clientMode,
  });
}

export async function scheduleLegacyCoreRecycle(
  plan: LegacyCoreRecyclePlan,
  confirm: boolean,
) {
  assertPlan(plan);
  if (confirm !== true) throw new Error("CORE_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");

  const prior = new ManagedSidecarLedger('core', plan.port)
    .lookup(plan.operationId, recycleFingerprint(plan));
  if (prior?.replayed) {
    return {service:'core' as const,action:'recycle' as const,changed:false,
      replayed:true,scheduled:false,ownerPid:prior.afterPid??null};
  }

  const evidence = await captureLegacyEvidence(plan.port);
  if (
    evidence.ownerPid !== plan.expectedOwnerPid ||
    evidence.processIdentity !== plan.expectedProcessIdentity ||
    evidence.commandDigest !== plan.expectedLegacyCommandDigest ||
    evidence.clientMode !== plan.clientMode
  ) throw new Error("CORE_RECYCLE_OWNER_CHANGED_SINCE_PLAN");

  const entry = targetEntry();
  const build = inspectCoreBuild(entry, { requireFreshCompiled: true });
  if (build.digest !== plan.expectedBuildDigest)
    throw new Error("CORE_RECYCLE_BUILD_CHANGED_SINCE_PLAN");

  const ledger = new ManagedSidecarLedger("core", plan.port);
  const fingerprint = recycleFingerprint(plan);
  const existing = ledger.lookup(plan.operationId, fingerprint);
  if (existing?.replayed) {
    return {
      service: "core", action: "recycle", changed: false, replayed: true,
      scheduled: false, ownerPid: existing.afterPid ?? null,
    };
  }
  ledger.begin(plan.operationId, fingerprint);

  const child = spawn(process.execPath, [
    entry, "core", "recycle-worker",
    "--port", String(plan.port),
    "--operation-id", plan.operationId,
    "--expected-owner-pid", String(plan.expectedOwnerPid),
    "--expected-process-identity", plan.expectedProcessIdentity,
    "--expected-command-digest", plan.expectedLegacyCommandDigest,
    "--expected-build", plan.expectedBuildDigest,
    "--client-mode", plan.clientMode,
  ], {
    cwd: getPackageRootDir(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, SUPERAGENT_CORE_RECYCLE_HELPER: "1" },
  });
  child.on("error", () => {});
  child.unref();
  if (!child.pid) throw new Error("CORE_RECYCLE_HELPER_SPAWN_FAILED");

  recordLifecycleEvent({
    at: Date.now(), service: "core", action: "recycle",
    outcome: "planned", port: plan.port, ownerPid: plan.expectedOwnerPid,
    operationHashPrefix: operationHashPrefix(plan.operationId),
    buildDigestPrefix: plan.expectedBuildDigest.slice(0, 12),
  });

  return {
    service: "core",
    action: "recycle",
    changed: false,
    replayed: false,
    scheduled: true,
    helperPid: child.pid,
    previousPid: plan.expectedOwnerPid,
    operationId: plan.operationId,
    expectedBuildDigest: plan.expectedBuildDigest,
    note: "Recycle helper started. It will reverify the exact legacy owner, request authenticated graceful shutdown, wait for the port to be released, then start and attest a supervised Core.",
  };
}

async function waitForLegacyExit(plan: LegacyCoreRecyclePlan, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await readProcessStartIdentity(plan.expectedOwnerPid);
    if (identity === null) {
      const listeners = readListenerOwners();
      if (listeners && !listeners.has(plan.port)) return;
    } else if (identity !== plan.expectedProcessIdentity) {
      throw new Error("CORE_RECYCLE_PID_REUSED_ABORTED");
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("CORE_RECYCLE_LEGACY_EXIT_TIMEOUT");
}

async function requestLegacyShutdown(port: number, authToken: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: "POST",
    headers: { Authorization: "Bearer " + authToken },
    redirect: "error",
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error("CORE_RECYCLE_GRACEFUL_SHUTDOWN_REFUSED");
  await response.arrayBuffer();
}

async function waitForSupervisedCore(port: number, expectedBuild: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await requestCoreSupervisor("status", port, 1400);
      const listener = readListenerOwners()?.get(port);
      if (
        status.publicPort === port &&
        status.ownerContract?.role === "core-supervisor" &&
        status.ownerContract?.mcpLifecycle === "not-owned" &&
        status.supervisorPid === listener &&
        status.currentBuild?.fresh === true &&
        status.currentBuild?.digest === expectedBuild
      ) return status;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("CORE_RECYCLE_NEW_SUPERVISOR_ATTESTATION_TIMEOUT");
}

export async function runLegacyCoreRecycleWorker(plan: LegacyCoreRecyclePlan) {
  assertPlan(plan);
  if (process.env.SUPERAGENT_CORE_RECYCLE_HELPER !== "1")
    throw new Error("CORE_RECYCLE_HELPER_CONTEXT_REQUIRED");

  const started = Date.now();
  const ledger = new ManagedSidecarLedger("core", plan.port);
  try {
    // Give the caller enough time to receive the accepted/scheduled response
    // before this detached helper shuts down the legacy Core serving it.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const evidence = await captureLegacyEvidence(plan.port);
    if (
      evidence.ownerPid !== plan.expectedOwnerPid ||
      evidence.processIdentity !== plan.expectedProcessIdentity ||
      evidence.commandDigest !== plan.expectedLegacyCommandDigest ||
      evidence.clientMode !== plan.clientMode
    ) throw new Error("CORE_RECYCLE_OWNER_CHANGED_BEFORE_SHUTDOWN");

    const build = inspectCoreBuild(targetEntry(), { requireFreshCompiled: true });
    if (build.digest !== plan.expectedBuildDigest)
      throw new Error("CORE_RECYCLE_BUILD_CHANGED_BEFORE_SHUTDOWN");

    await requestLegacyShutdown(plan.port, evidence.serverInfo.authToken);
    await waitForLegacyExit(plan);

    const entry = targetEntry();
    const child = spawn(process.execPath, [
      entry, "core", "start",
      "--port", String(plan.port),
      "--client-mode", plan.clientMode,
    ], {
      cwd: getPackageRootDir(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SUPERAGENT_CORE_RECYCLED: "1",
        SUPERAGENT_CORE_RECYCLE_SERVER_TOKEN: evidence.serverInfo.authToken,
      },
    });
    child.on("error", () => {});
    child.unref();
    if (!child.pid) throw new Error("CORE_RECYCLE_SUPERVISOR_SPAWN_FAILED");

    const status = await waitForSupervisedCore(plan.port, plan.expectedBuildDigest);
    ledger.complete(plan.operationId, status.supervisorPid);
    recordLifecycleEvent({
      at: Date.now(), service: "core", action: "recycle",
      outcome: "succeeded", port: plan.port, ownerPid: status.supervisorPid,
      operationHashPrefix: operationHashPrefix(plan.operationId),
      buildDigestPrefix: plan.expectedBuildDigest.slice(0, 12),
      durationMs: Date.now() - started,
    });
  } catch (error) {
    try {
      recordLifecycleEvent({
        at: Date.now(), service: "core", action: "recycle",
        outcome: "uncertain", port: plan.port,
        operationHashPrefix: operationHashPrefix(plan.operationId),
        buildDigestPrefix: plan.expectedBuildDigest.slice(0, 12),
        durationMs: Date.now() - started,
        errorCode: error instanceof Error
          ? (error.message.match(/CORE_RECYCLE_[A-Z0-9_]+/)?.[0] ?? "CORE_RECYCLE_FAILED")
          : "CORE_RECYCLE_FAILED",
      });
    } catch {}
    throw error;
  }
}
