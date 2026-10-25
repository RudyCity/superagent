/**
 * Opt-in owner-scoped API Core guardian.
 *
 * Starts a fresh API supervisor only when no checkpoint/owner exists. After
 * its verified child dies, launch Core's authenticated checkpoint recovery,
 * never reparent or kill foreign processes, worker sessions, MCP tunnels,
 * Muse, Telegram or T-Line. No OS-reboot or LLM-memory continuity promise.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getRootConfigDir } from "../config/paths.js";
import { coreCheckpointPath, readCoreCheckpoint } from "./coreSupervisorCheckpoint.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";

export type CoreGuardianPolicy = { maxRecoveries: number; windowMs: number; backoffMs: number };
export const DEFAULT_CORE_GUARDIAN_POLICY: CoreGuardianPolicy = {
  maxRecoveries: 3, windowMs: 10 * 60_000, backoffMs: 1000,
};
export function validateCoreGuardianPolicy(input: CoreGuardianPolicy): CoreGuardianPolicy {
  if (!Number.isInteger(input.maxRecoveries) || input.maxRecoveries < 0 ||
      input.maxRecoveries > 20 || !Number.isSafeInteger(input.windowMs) ||
      input.windowMs < 10_000 || input.windowMs > 86_400_000 ||
      !Number.isSafeInteger(input.backoffMs) || input.backoffMs < 100 ||
      input.backoffMs > 60_000) throw new Error("Unsafe Core guardian recovery policy");
  return input;
}
export type CoreGuardianDecision = "refuse" | "recover";
export function decideCoreGuardianRecovery(input: {
  guardianStopping: boolean; verifiedInitialOwner: boolean; currentChildWasOwned: boolean;
  checkpointVerified: boolean; foreignOwnerOnline: boolean; recentAttempts: number;
}, policy: CoreGuardianPolicy = DEFAULT_CORE_GUARDIAN_POLICY): CoreGuardianDecision {
  validateCoreGuardianPolicy(policy);
  if (input.guardianStopping || !input.verifiedInitialOwner ||
      !input.currentChildWasOwned || !input.checkpointVerified ||
      input.foreignOwnerOnline || !Number.isInteger(input.recentAttempts) ||
      input.recentAttempts < 0 ||
      input.recentAttempts >= policy.maxRecoveries) return "refuse";
  return "recover";
}
export function coreGuardianFile(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Core guardian port");
  return path.join(getRootConfigDir(), "core-guardian-" + port + ".json");
}
type GuardianLease = { version: 1; port: number; pid: number;
  instanceId: string; startedAt: number; clientMode: "tline" | "chrome-extension" };
export function readCoreGuardianLease(port: number): GuardianLease | null {
  const file = coreGuardianFile(port);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Core guardian lease unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024) {
    throw new Error("Core guardian lease invalid");
  }
  let data: GuardianLease;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("Core guardian lease corrupt"); }
  if (data.version !== 1 || data.port !== port ||
      !Number.isSafeInteger(data.pid) || data.pid <= 0 ||
      !/^[a-f0-9]{32}$/.test(data.instanceId) ||
      !Number.isSafeInteger(data.startedAt) || data.startedAt <= 0 ||
      !["tline", "chrome-extension"].includes(data.clientMode)) {
    throw new Error("Core guardian lease invalid");
  }
  return data;
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function identifyChild(port: number, pid: number, deadlineMs = 25_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const status = await requestCoreSupervisor("status", port, 1100);
      if (status.supervisorPid !== pid || status.publicPort !== port) {
        throw new Error("Core supervisor identity mismatch; foreign owner may exist");
      }
      return status;
    } catch (error) {
      if (String(error).includes("identity mismatch")) throw error;
    }
    await pause(250);
  }
  throw new Error("Owned Core supervisor failed authenticated readiness");
}
export async function runCoreGuardian(options: {
  port: number;
  clientMode?: "tline" | "chrome-extension";
  policy?: CoreGuardianPolicy;
  entry?: string;
  signal?: AbortSignal;
}): Promise<{ reason: "stopped" | "refused" | "budget_exhausted"; recoveries: number }> {
  const { port } = options;
  const clientMode = options.clientMode ?? "tline";
  const policy = validateCoreGuardianPolicy(options.policy ?? DEFAULT_CORE_GUARDIAN_POLICY);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !["tline", "chrome-extension"].includes(clientMode)) throw new Error("Invalid Core guardian options");
  const entry = path.resolve(options.entry || process.argv[1] || "");
  if (!fs.existsSync(entry)) throw new Error("Core guardian requires an existing CLI entry");
  const dir = getRootConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Core guardian directory");

  if (fs.existsSync(coreCheckpointPath(port)) ||
      fs.existsSync(path.join(dir, "core-supervisor-" + port + ".json"))) {
    throw new Error("Existing Core checkpoint/discovery; guardian cannot adopt it. Inspect ownership and use explicit core recover.");
  }
  try {
    await requestCoreSupervisor("status", port, 900);
    throw new Error("An active Core supervisor exists; guardian refuses takeover");
  } catch (error) {
    if (String(error).includes("guardian refuses takeover")) throw error;
  }
  const leaseFile = coreGuardianFile(port);
  const lease: GuardianLease = {
    version: 1, port, pid: process.pid,
    instanceId: crypto.randomBytes(16).toString("hex"), startedAt: Date.now(), clientMode,
  };
  fs.writeFileSync(leaseFile, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
  let stopping = Boolean(options.signal?.aborted);
  const onStop = () => { stopping = true; };
  options.signal?.addEventListener("abort", onStop);
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  const spawnChild = (action: "start" | "recover") => {
    const child = spawn(process.execPath, [entry, "core", action, "--port", String(port),
      "--client-mode", clientMode], {
      stdio: process.env.SUPERAGENT_CORE_STAGING === "1" ? "inherit" : "ignore",
      windowsHide: true, detached: true, cwd: process.cwd(), env: process.env,
    });
    // Core owns its own listener and workers, independent of guardian lifetime.
    child.unref();
    return child;
  };
  const exits: number[] = [];
  let child: ChildProcess | undefined;
  let verifiedInitialOwner = false;
  let recoveries = 0;
  try {
    child = spawnChild("start");
    if (!child.pid) throw new Error("Core child process did not start");
    let ownedPid = child.pid;
    try {
      await identifyChild(port, ownedPid);
      const checkpoint = readCoreCheckpoint(port);
      if (!checkpoint.workers.length || checkpoint.clientMode !== clientMode) {
        throw new Error("Initial Core checkpoint invalid");
      }
      verifiedInitialOwner = true;
    } catch (error) {
      console.warn("[Core guardian] Initial Core process could not be verified: " + String(error));
      return { reason: "refused", recoveries };
    }
    while (!stopping) {
      while (!stopping && child.exitCode === null && child.signalCode === null) {
        await pause(250);
      }
      if (stopping) return { reason: "stopped", recoveries };
      const childWasOwned = child.pid === ownedPid;
      const now = Date.now();
      for (let i = exits.length - 1; i >= 0; i--) {
        if (now - exits[i] > policy.windowMs) exits.splice(i, 1);
      }
      let foreignOwnerOnline = false;
      try { await requestCoreSupervisor("status", port, 1200); foreignOwnerOnline = true; }
      catch {}
      let checkpointVerified = false;
      try {
        const cp = readCoreCheckpoint(port);
        checkpointVerified = cp.workers.length > 0 && cp.clientMode === clientMode &&
          cp.savedAt >= lease.startedAt;
      } catch {}
      const decision = decideCoreGuardianRecovery({
        guardianStopping: stopping, verifiedInitialOwner,
        currentChildWasOwned: childWasOwned, checkpointVerified,
        foreignOwnerOnline, recentAttempts: exits.length,
      }, policy);
      if (decision !== "recover") {
        return { reason: exits.length >= policy.maxRecoveries ?
          "budget_exhausted" : "refused", recoveries };
      }
      exits.push(now);
      const delay = Math.min(30_000, policy.backoffMs *
        2 ** Math.min(exits.length - 1, 6));
      console.warn("[Core guardian] Owned Core supervisor exited; attempting authenticated checkpoint recovery");
      await pause(delay);
      if (stopping) return { reason: "stopped", recoveries };
      child = spawnChild("recover");
      if (!child.pid) return { reason: "refused", recoveries };
      ownedPid = child.pid;
      recoveries++;
      try {
        const ready = await identifyChild(port, ownedPid);
        if (!ready.recovered) return { reason: "refused", recoveries };
      } catch {
        return { reason: "refused", recoveries };
      }
    }
    return { reason: "stopped", recoveries };
  } finally {
    // Never stop an API Core child, existing sessions or external services
    // merely because the guardian is being stopped.
    options.signal?.removeEventListener("abort", onStop);
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    try {
      if (fs.readFileSync(leaseFile, "utf8") === JSON.stringify(lease)) {
        fs.rmSync(leaseFile);
      }
    } catch {}
  }
}
