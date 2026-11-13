import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { getRootConfigDir } from "../config/paths.js";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { getProcessSupervisor } from "../process/processSupervisor.js";
import { handoverCoreDelegateBridge, callCoreWorkerDelegateBridge } from "./coreDelegateHandover.js";
import { readDelegateListenerPreference } from "../delegate/delegateListenerPreference.js";
import { generateDelegateForwardedChannelMaterial } from "../browserTransport/delegateForwardedPrincipal.js";
import {
  provisionCoreWorkerDelegateForwardingVerifier,
  startCoreSupervisorDelegateForwardingBroker,
} from "./delegateForwardingLifecycle.js";
import { legacyRetainedCoreMayDrain, type CoreDrainReport } from "./coreDrainInspection.js";
import { inspectCoreBuild, type CoreBuildIdentity } from "./coreBuildIdentity.js";
import { CoreLifecycleLedger, validateCoreOperationId } from "./coreLifecycleLedger.js";
import {
  coreCheckpointPath, readCoreCheckpoint, writeCoreCheckpoint,
  type CoreSupervisorCheckpoint,
} from "./coreSupervisorCheckpoint.js";
import {
  CoreSessionAffinity, CORE_ROUTING_BODY_LIMIT, inspectCoreSessionRequest,
} from "./coreSessionRouting.js";
import { mayRouteExplicitCoreResume } from "./coreAgentSessionCheckpoint.js";
import {
  MAX_RETAINED_CORE_WORKERS, applyCoreRollback, mayCreateCoreGeneration,
  decideCoreRestartBridge,
  rollbackCandidates,
} from "./coreGenerationPolicy.js";

export interface CoreRuntimeStatus {
  /** R4 opt-in desktop attestation. A PID match alone grants no control. */
  ownerContract?: {
    version: 1;
    /** Runtime feature attestation, absent on legacy supervisors. */
    safeLifecycleVersion?: 2;
    role: "core-supervisor";
    mcpLifecycle: "not-owned";
    replayPolicy: "explicit-resume-only";
  };
  supervisorPid: number;
  publicPort: number;
  active: { pid: number; port: number; since: number; buildDigest?: string; buildMode?: "source" | "compiled" };
  retained: Array<{ pid: number; port: number; since: number; buildDigest?: string; buildMode?: "source" | "compiled" }>;
  currentBuild?: CoreBuildIdentity;
  operation?: { operationHashPrefix: string; replayed: boolean; action: "restart" | "rollback" | "drain" };
  /** Bound session IDs remain pinned to the generation that initialized them. */
  affinitySessions?: number;
  maxRetainedWorkers?: number;
  lastRollback?: { reason: string; fromPid: number; toPid: number; at: number };
  lastDrain?: { checked: number; retiredPids: number[]; blocked: string[]; at: number };
  recovered?: boolean;
}

/**
 * Opt-in API core supervisor.
 *
 * The public listener is owned by this process; workers bind only to loopback
 * ephemeral ports. Previous generations are intentionally retained to protect
 * running jobs and already-established SSE/WebSocket connections. This is not
 * a restart of the interactive CLI, MCP, Muse or Telegram processes.
 */
const stateDir = () => getRootConfigDir();
const statePath = (port: number) => path.join(stateDir(), "core-supervisor-" + port + ".json");
const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type Generation = CoreRuntimeStatus["active"] & {
  child?: ChildProcess;
  generationId: string;
  drainEligible: boolean;
  /** Adopted workers are never signalled by drain; unverified remain tombstones. */
  adopted: boolean;
  verified: boolean;
};

interface SupervisorDiscovery {
  supervisorPid: number;
  publicPort: number;
  controlPort: number;
  controlToken: string;
}

function readDiscovery(port: number): SupervisorDiscovery {
  if (!validPort(port)) throw new Error("Port must be between 1 and 65535");
  const state = JSON.parse(fs.readFileSync(statePath(port), "utf8")) as SupervisorDiscovery;
  if (state.publicPort !== port || !validPort(state.controlPort) ||
      typeof state.controlToken !== "string" || !/^[a-f0-9]{64}$/.test(state.controlToken)) {
    throw new Error("Invalid supervisor state; refusing remote control");
  }
  return state;
}

function saveJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const listener = net.createServer();
  return new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const addr = listener.address();
      if (!addr || typeof addr === "string") {
        listener.close();
        reject(new Error("No port assigned"));
        return;
      }
      listener.close(() => resolve(addr.port));
    });
  });
}

async function ready(port: number, child: ChildProcess, bearer: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("New core worker exited before becoming ready");
    }
    const healthy = await new Promise<boolean>(resolve => {
      const req = http.get({
        host: "127.0.0.1", port, path: "/api/status",
        headers: { Authorization: "Bearer " + bearer }, timeout: 600,
      }, res => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(false));
    });
    if (healthy) return;
    await pause(150);
  }
  throw new Error("New core worker did not pass HTTP readiness within 15 seconds");
}

export async function requestCoreSupervisor(
  action: "status" | "restart" | "rollback" | "drain", port = 7888, timeoutMs = 30000,
  options: { operationId?: string; expectedBuildDigest?: string } = {},
): Promise<CoreRuntimeStatus> {
  let info: SupervisorDiscovery;
  try { info = readDiscovery(port); }
  catch { throw new Error("No supervised core is registered on port " + port + ". Start: superagent core start --port " + port); }
  return new Promise<CoreRuntimeStatus>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: info.controlPort, method: action === "status" ? "GET" : "POST",
      path: "/" + action,
      timeout: timeoutMs,
      headers: {
        Authorization: "Bearer " + info.controlToken,
        ...(action !== "status" && options.operationId
          ? { "x-superagent-operation-id": validateCoreOperationId(options.operationId) } : {}),
        ...(action !== "status" && options.expectedBuildDigest
          ? { "x-superagent-expected-build": options.expectedBuildDigest } : {}),
      },
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; if (body.length > 16384) req.destroy(); });
      res.once("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200) throw new Error(parsed.error || "Core supervisor rejected request");
          resolve(parsed as CoreRuntimeStatus);
        } catch (error) { reject(error); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("Core control request timed out")));
    req.once("error", () => reject(new Error("Supervisor is unreachable or stale on port " + port + "; no processes were stopped")));
    req.end();
  });
}

export async function runCoreSupervisor(
  port = 7888, clientMode: "tline" | "chrome-extension" = "tline",
  recover = false,
): Promise<void> {
  if (!validPort(port)) throw new Error("Invalid public port");
  if (process.env.SUPERAGENT_CORE_STAGING === "1" &&
      (!process.env.SUPERAGENT_CONFIG_DIR ||
       path.resolve(process.env.SUPERAGENT_CONFIG_DIR) ===
         path.join(os.homedir(), ".superagent-r"))) {
    throw new Error("Isolated staging requires its own SUPERAGENT_CONFIG_DIR.");
  }
  // Fail closed when an instance is already healthy; never touch existing owners.
  try {
    await requestCoreSupervisor("status", port);
    throw new Error("A core supervisor is already running on port " + port);
  } catch (error) {
    if (String(error).includes("already running")) throw error;
  }

  // Explicit recovery only; starting a fresh listener while orphaned workers
  // exist would lose affinity and misroute active sessions.
  const checkpoint = recover ? readCoreCheckpoint(port) : undefined;
  if (!recover && fs.existsSync(coreCheckpointPath(port))) {
    let hasLiveWorker = false;
    try {
      const saved = readCoreCheckpoint(port);
      for (const w of saved.workers || []) {
        if (typeof w.pid === "number" && w.pid > 0) {
          try {
            process.kill(w.pid, 0);
            hasLiveWorker = true;
            break;
          } catch {
            // PID is offline/dead
          }
        }
      }
    } catch {
      // Corrupt or unreadable checkpoint
    }
    if (hasLiveWorker) {
      throw new Error("Supervisor checkpoint exists for port " + port +
        ". Use core recover --port " + port + " to verify/adopt old workers; refusing fresh overwrite.");
    } else {
      try { fs.rmSync(coreCheckpointPath(port), { force: true }); } catch {}
    }
  }
  if (checkpoint && checkpoint.clientMode !== clientMode) {
    throw new Error("Recovery client mode differs from saved supervisor");
  }
  const controlToken = crypto.randomBytes(32).toString("hex");
  // Stable bearer across crash recovery and guarded legacy recycle so local
  // clients do not lose authentication during ownership migration.
  const recycleToken = process.env.SUPERAGENT_CORE_RECYCLE_SERVER_TOKEN;
  if (recycleToken !== undefined && !/^[A-Za-z0-9._~-]{24,256}$/.test(recycleToken))
    throw new Error("CORE_RECYCLE_SERVER_TOKEN_INVALID");
  const serverToken = checkpoint?.serverToken || recycleToken || crypto.randomBytes(24).toString("hex");
  delete process.env.SUPERAGENT_CORE_RECYCLE_SERVER_TOKEN;
  const inspectToken = checkpoint?.inspectToken || crypto.randomBytes(32).toString("hex");
  // One private forwarding channel lives for this supervisor lifetime. Every
  // worker generation gets the verifier over parent/child IPC; MCP backends
  // obtain the signer only from the supervisor's authenticated local IPC pipe.
  const delegateForwardingMaterial = generateDelegateForwardedChannelMaterial();
  let delegateForwardingBroker: Awaited<ReturnType<
    typeof startCoreSupervisorDelegateForwardingBroker
  >> | undefined;
  let active: Generation | undefined;
  const retained: Generation[] = [];
  const sessionAffinity = new CoreSessionAffinity();
  let restarting = false;
  let lastRollback: CoreRuntimeStatus["lastRollback"];
  let lastDrain: CoreRuntimeStatus["lastDrain"];
  let recovered = false;
  let autoDrainTimer: ReturnType<typeof setTimeout> | undefined;
  // Durable receipts remain outside Core's worker checkpoint and survive
  // supervisor crash/recovery. Unresolved operations are never replayed.
  const lifecycleLedger = new CoreLifecycleLedger(port);
  const coreEntry = path.resolve(process.argv[1] || "");

  function persistCheckpoint(): void {
    if (!active) return;
    const workers = [active, ...retained].map(({ pid, port: workerPort, since, generationId, drainEligible, buildDigest, buildMode }) =>
      ({ pid, port: workerPort, since, generationId, drainEligible,
        ...(buildDigest ? { buildDigest } : {}),
        ...(buildMode ? { buildMode } : {}) }));
    writeCoreCheckpoint({
      version: 1, port, savedAt: Date.now(), clientMode,
      serverToken, inspectToken, activePid: active.pid,
      workers, sessions: sessionAffinity.entries(),
    } satisfies CoreSupervisorCheckpoint);
  }
  // Account for in-flight requests, SSE streams and raw socket upgrades
  // before considering a worker for retirement.
  const inflight = new Map<number, number>();
  function acquire(worker: Generation): () => void {
    inflight.set(worker.pid, (inflight.get(worker.pid) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (inflight.get(worker.pid) || 0) - 1;
      if (remaining > 0) inflight.set(worker.pid, remaining);
      else inflight.delete(worker.pid);
    };
  }

  async function spawnWorker(): Promise<Generation> {
    const workerPort = await reserveLoopbackPort();
    const generationId = crypto.randomBytes(16).toString("hex");
    // Supervised workers are API-only. Fixed-port helpers use independent
    // owner lifecycles, and the single Delegate listener is transactionally
    // handed over before an old worker becomes a retained drain candidate.
    const staging = process.env.SUPERAGENT_CORE_STAGING === "1";
    const drainEligible = true;
    const entry = coreEntry;
    const buildBefore = inspectCoreBuild(entry, { requireFreshCompiled: true });
    let workerRecordId: string | undefined;
    try {
      const reg = await getProcessSupervisor().registerProcess({
        component: "core_worker",
        executable: process.execPath,
        args: [entry, "--server", String(workerPort), "--client-mode", clientMode],
        launchIntent: "headless",
        lifecycle: "persistent",
        cleanupPolicy: "lease_managed",
        systemScope: "global",
      });
      workerRecordId = reg.recordId;
    } catch {}

    const child = fork(entry, ["--server", String(workerPort), "--client-mode", clientMode], {
      execPath: process.execPath,
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
      env: {
        ...process.env,
        SUPERAGENT_CORE_WORKER: "1",
        SUPERAGENT_CORE_GENERATION_ID: generationId,
        SUPERAGENT_CORE_PUBLIC_PORT: String(port),
        SUPERAGENT_CORE_INSPECT_TOKEN: inspectToken,
        // Retained workers are drainable only after the supervisor has
        // completed Delegate-listener handoff and the authenticated drain
        // report proves no live work remains.
        SUPERAGENT_CORE_TRANSPORT_ISOLATED: "1",
        // Vision has an independent managed lifecycle; Core workers must never
        // own its fixed port or block generation retirement.
        SUPERAGENT_CORE_VISION_OWNER: "0",
        // The supervisor explicitly hands over the single Delegate listener.
        // New blue-green candidates must never race the current owner for 17341.
        SUPERAGENT_CORE_DELEGATE_OWNER: staging || active ? "0" : "1",
        SUPERAGENT_SERVER_AUTH_TOKEN: serverToken,
      },
    });
    child.once("error", () => { /* readiness reports a failed spawn */ });
    if (workerRecordId && child.pid) {
      void getProcessSupervisor().recordProcessSpawn(workerRecordId, child.pid).catch(() => {});
      child.once("exit", (code, signal) => {
        void getProcessSupervisor().recordProcessExit(workerRecordId!, {
          exitCode: code,
          signal: signal ? String(signal) : null,
          source: "coreSupervisor.workerExit",
        }).catch(() => {});
      });
    }
    try {
      await provisionCoreWorkerDelegateForwardingVerifier(
        child, generationId, delegateForwardingMaterial,
      );
      await ready(workerPort, child, serverToken);
    }
    catch (error) {
      // Only the candidate worker can be stopped on failure; active traffic is untouched.
      try { child.kill(); } catch {}
      throw error;
    }
    child.unref();
    if (!child.pid) throw new Error("Worker PID unavailable");
    // Do not publish a candidate that was spawned while the source/dist tree
    // was changing. The old active worker remains untouched on failure.
    const buildAfter = inspectCoreBuild(entry, { requireFreshCompiled: true });
    if (buildAfter.digest !== buildBefore.digest) {
      try { child.kill(); } catch {}
      throw new Error("CORE_BUILD_CHANGED_DURING_RESTART");
    }
    return { child, pid: child.pid, port: workerPort, since: Date.now(), generationId,
      buildDigest: buildBefore.digest, buildMode: buildBefore.mode,
      drainEligible, adopted: false, verified: true };
  }

  function status(): CoreRuntimeStatus {
    if (!active) throw new Error("No healthy core worker");
    return {
      ownerContract: {
        version: 1, safeLifecycleVersion: 2, role: "core-supervisor",
        mcpLifecycle: "not-owned", replayPolicy: "explicit-resume-only",
      },
      supervisorPid: process.pid,
      publicPort: port,
      active: { pid: active.pid, port: active.port, since: active.since,
        buildDigest: active.buildDigest, buildMode: active.buildMode },
      retained: retained.map(({ pid, port: workerPort, since, buildDigest, buildMode }) =>
        ({ pid, port: workerPort, since, buildDigest, buildMode })),
      currentBuild: inspectCoreBuild(coreEntry),
      affinitySessions: sessionAffinity.count,
      maxRetainedWorkers: MAX_RETAINED_CORE_WORKERS,
      ...(lastRollback ? { lastRollback } : {}),
      ...(lastDrain ? { lastDrain } : {}),
      recovered,
    };
  }

  function workerExited(worker: Generation): boolean {
    if (!worker.verified) return true;
    if (worker.child) return worker.child.exitCode !== null || worker.child.signalCode !== null;
    // Only metadata for adopted workers; never infer ownership from PID alone.
    try { process.kill(worker.pid, 0); return false; } catch { return true; }
  }

  // Session affinity is a routing hint, never an implicit claim of a live
  // worker. Always resolve it back to a currently tracked child process.
  function selectWorker(sessionId: string | undefined): Generation | undefined {
    if (!active) return undefined;
    const owner = sessionAffinity.resolve(sessionId, active);
    return [active, ...retained].find(worker =>
      worker.pid === owner.pid && worker.port === owner.port);
  }

  async function workerResponsive(worker: Generation): Promise<boolean> {
    if (workerExited(worker)) return false;
    return new Promise(resolve => {
      const req = http.get({
        host: "127.0.0.1", port: worker.port, path: "/api/status",
        headers: { Authorization: "Bearer " + serverToken }, timeout: 1000,
      }, res => { res.resume(); resolve(res.statusCode === 200); });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(false));
    });
  }

  async function verifyRecoveryWorker(worker: Generation): Promise<boolean> {
    const identified = await new Promise<boolean>(resolve => {
      const req = http.get({
        host: "127.0.0.1", port: worker.port,
        path: "/_core/internal/drain",
        headers: { "x-superagent-internal-token": inspectToken },
        timeout: 1300,
      }, res => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) req.destroy();
          else parts.push(chunk);
        });
        res.once("end", () => {
          try {
            const report = JSON.parse(Buffer.concat(parts).toString("utf8")) as CoreDrainReport;
            resolve(res.statusCode === 200 && report.pid === worker.pid &&
              report.workerGenerationId === worker.generationId &&
              report.transportIsolated === worker.drainEligible);
          } catch { resolve(false); }
        });
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(false));
    });
    if (!identified) return false;
    // The child is not yet adopted, so its verified flag is intentionally
    // false. Probe authenticated readiness directly before granting adoption.
    return new Promise(resolve => {
      const req = http.get({
        host: "127.0.0.1", port: worker.port, path: "/api/status",
        headers: { Authorization: "Bearer " + serverToken }, timeout: 1500,
      }, res => { res.resume(); resolve(res.statusCode === 200); });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(false));
    });
  }

  async function rollback(reason: string): Promise<CoreRuntimeStatus> {
    if (restarting) throw new Error("Core lifecycle change already in progress");
    restarting = true;
    try {
      const current = active;
      if (!current) throw new Error("No active core worker");
      for (const candidate of rollbackCandidates(retained, current.pid)) {
        if (!await workerResponsive(candidate)) continue;
        const outcome = applyCoreRollback(current, retained, candidate.pid, !workerExited(current));
        if (!outcome) continue;
        const bridgeHandover = process.env.SUPERAGENT_DELEGATE_BRIDGE !== "0" &&
          process.env.SUPERAGENT_CORE_STAGING !== "1" && !workerExited(current);
        if (bridgeHandover) {
          await handoverCoreDelegateBridge(current.port, candidate.port, serverToken,
            undefined, { inspectToken });
        }
        // If the old active worker crashed, its listener can no longer be
        // handed over. Restore on the verified rollback candidate only when
        // the operator's persisted preference is ON.
        const restoreAfterCrash = !bridgeHandover && workerExited(current) &&
          process.env.SUPERAGENT_DELEGATE_BRIDGE !== "0" &&
          process.env.SUPERAGENT_CORE_STAGING !== "1" &&
          readDelegateListenerPreference();
        if (restoreAfterCrash) {
          const restored = await callCoreWorkerDelegateBridge(candidate.port, "start",
            serverToken, { transient: true, inspectToken });
          if (!restored.running) throw new Error("CORE_DELEGATE_CRASH_RECOVERY_NOT_READY");
        }
        // Preserve all live sessions on the former active generation.
        const previousRetained = [...retained];
        const previousRollback = lastRollback;
        retained.splice(0, retained.length, ...outcome.retained);
        if (workerExited(current) && sessionAffinity.countForOwner(current) > 0 &&
            !retained.some(worker => worker.pid === current.pid)) {
          retained.push({ ...current, child: undefined, verified: false });
        }
        active = outcome.active as Generation;
        lastRollback = { reason, fromPid: current.pid, toPid: candidate.pid, at: Date.now() };
        try {
          persistCheckpoint();
        } catch (error) {
          active = current;
          retained.splice(0, retained.length, ...previousRetained);
          lastRollback = previousRollback;
          if (bridgeHandover) {
            await handoverCoreDelegateBridge(candidate.port, current.port, serverToken,
              undefined, { inspectToken });
          } else if (restoreAfterCrash) {
            // The checkpoint failed: do not leave a listener running on an
            // unpublished generation.
            try {
              await callCoreWorkerDelegateBridge(candidate.port, "stop",
                serverToken, { transient: true, inspectToken });
            } catch {}
          }
          throw error;
        }
        scheduleConservativeAutoDrain();
        return status();
      }
      throw new Error("No responsive previous core worker; no session or tunnel was stopped");
    } finally {
      restarting = false;
    }
  }

  async function restart(): Promise<CoreRuntimeStatus> {
    if (restarting) throw new Error("Core lifecycle change already in progress");
    // No worker is discarded while its SSE streams, tool processes or
    // in-memory agent state may still be alive. Fail closed at the limit.
    if (!mayCreateCoreGeneration(retained.length)) {
      throw new Error("Retained worker safety limit (" + MAX_RETAINED_CORE_WORKERS +
        ") reached; verified drain is required before another restart");
    }
    restarting = true;
    try {
      const candidate = await spawnWorker();
      const previous = active;
      // A confirmed-dead worker cannot serve the authenticated handover API.
      // Do not infer death from a failed HTTP probe alone: a live worker may
      // still own the fixed Delegate listener and have active sessions.
      const bridgeMode = decideCoreRestartBridge({
        bridgeEnabled: process.env.SUPERAGENT_DELEGATE_BRIDGE !== "0",
        staging: process.env.SUPERAGENT_CORE_STAGING === "1",
        previousWorkerExists: Boolean(previous),
        previousWorkerExited: Boolean(previous && workerExited(previous)),
        desiredListenerEnabled: readDelegateListenerPreference(),
      });
      try {
        if (bridgeMode === "handover" && previous) {
          await handoverCoreDelegateBridge(previous.port, candidate.port, serverToken,
            undefined, { inspectToken });
        } else if (bridgeMode === "start-after-verified-exit") {
          const started = await callCoreWorkerDelegateBridge(candidate.port, "start",
            serverToken, { transient: true, inspectToken });
          if (!started.running) throw new Error("CORE_DEAD_WORKER_DELEGATE_NOT_READY");
        }
      } catch (error) {
        // The previous generation stays authoritative. Kill only this
        // freshly owned, unpublished candidate and never a foreign process.
        try { candidate.child?.kill(); } catch {}
        throw error;
      }
      if (active) retained.push(active); // never kill existing generation
      active = candidate;
      try {
        persistCheckpoint();
      } catch (error) {
        active = previous;
        if (previous) retained.pop();
        if (bridgeMode === "handover" && previous) {
          // Restore the verified old listener on a failed checkpoint.
          try { await handoverCoreDelegateBridge(candidate.port, previous.port, serverToken,
              undefined, { inspectToken }); }
          finally { try { candidate.child?.kill(); } catch {} }
        } else {
          // Dead-worker recovery has no live previous listener to restore.
          // Explicitly stop the candidate listener before discarding it.
          if (bridgeMode === "start-after-verified-exit") {
            try { await callCoreWorkerDelegateBridge(candidate.port, "stop",
              serverToken, { transient: true, inspectToken }); } catch {}
          }
          try { candidate.child?.kill(); } catch {}
        }
        throw error;
      }
      scheduleConservativeAutoDrain();
      return status();
    } finally {
      restarting = false;
    }
  }

  async function inspectDrainReport(worker: Generation): Promise<CoreDrainReport | undefined> {
    if (workerExited(worker)) return undefined;
    return new Promise(resolve => {
      const req = http.get({
        host: "127.0.0.1", port: worker.port,
        path: "/_core/internal/drain",
        headers: { "x-superagent-internal-token": inspectToken },
        timeout: 2000,
      }, res => {
        const parts: Buffer[] = [];
        let length = 0;
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8192) req.destroy();
          else parts.push(chunk);
        });
        res.once("end", () => {
          if (res.statusCode !== 200) { resolve(undefined); return; }
          try {
            const report = JSON.parse(Buffer.concat(parts).toString("utf8")) as CoreDrainReport;
            resolve(report.pid === worker.pid && report.workerGenerationId === worker.generationId &&
              typeof report.safe === "boolean" && Array.isArray(report.blockers) &&
              report.metrics && typeof report.metrics === "object"
              ? report : undefined);
          } catch { resolve(undefined); }
        });
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(undefined));
    });
  }

  async function inspectForDrain(worker: Generation): Promise<CoreDrainReport | undefined> {
    if (!worker.drainEligible) return undefined;
    const report = await inspectDrainReport(worker);
    return report?.transportIsolated && !report.visionOwner ? report : undefined;
  }

  async function inspectLegacyRetainedForDrain(worker: Generation): Promise<CoreDrainReport | undefined> {
    if (worker.drainEligible || worker.adopted || workerExited(worker)) return undefined;
    const report = await inspectDrainReport(worker);
    if (!report || !legacyRetainedCoreMayDrain(report)) return undefined;
    try {
      const delegate = await callCoreWorkerDelegateBridge(worker.port, "status", serverToken);
      if (delegate.running || delegate.openSockets !== 0 ||
          (delegate.pendingRequests ?? 0) !== 0) return undefined;
    } catch {
      return undefined;
    }
    return report;
  }

  async function drain(): Promise<CoreRuntimeStatus> {
    if (restarting) throw new Error("Core lifecycle change already in progress");
    restarting = true;
    const retiredPids: number[] = [];
    const blocked: string[] = [];
    const candidates = [...retained];
    try {
      for (const worker of candidates) {
        if (workerExited(worker)) {
          // A dead generation with pinned sessions must remain as explicit
          // unavailable-owner evidence. With no affinity left, retaining dead
          // metadata only consumes the generation safety budget.
          if (sessionAffinity.countForOwner(worker) > 0) {
            blocked.push("PID " + worker.pid + ": worker exited but pinned sessions remain");
            continue;
          }
          const deadIndex = retained.findIndex(item =>
            item.pid === worker.pid && item.generationId === worker.generationId);
          if (deadIndex >= 0) retained.splice(deadIndex, 1);
          retiredPids.push(worker.pid);
          persistCheckpoint();
          continue;
        }
        if (sessionAffinity.countForOwner(worker) > 0) {
          blocked.push("PID " + worker.pid + ": pinned sessions remain");
          continue;
        }
        if ((inflight.get(worker.pid) || 0) > 0) {
          blocked.push("PID " + worker.pid + ": active HTTP/SSE/WebSocket requests");
          continue;
        }
        const first = worker.drainEligible
          ? await inspectForDrain(worker)
          : await inspectLegacyRetainedForDrain(worker);
        const firstAccepted = worker.drainEligible ? first?.safe === true : first !== undefined;
        if (!firstAccepted) {
          blocked.push("PID " + worker.pid + ": " +
            (worker.drainEligible
              ? (first?.blockers.join(", ") || "inspection unavailable")
              : "legacy helper ownership not safely retired"));
          continue;
        }
        // Observe quiescence twice after a delay; reject a newly active worker.
        await pause(300);
        const second = worker.drainEligible
          ? await inspectForDrain(worker)
          : await inspectLegacyRetainedForDrain(worker);
        const secondAccepted = worker.drainEligible ? second?.safe === true : second !== undefined;
        if (!secondAccepted || (inflight.get(worker.pid) || 0) !== 0 ||
            sessionAffinity.countForOwner(worker) !== 0) {
          blocked.push("PID " + worker.pid + ": changed state during drain verification");
          continue;
        }
        // A directly owned child may receive SIGTERM. A recovered/adopted
        // worker has no ChildProcess handle, so never signal its PID; request
        // the worker's authenticated graceful shutdown endpoint instead.
        const stopped = worker.child
          ? await new Promise<boolean>(resolve => {
              worker.child!.once("exit", () => resolve(true));
              if (!worker.child!.kill("SIGTERM")) { resolve(false); return; }
              setTimeout(() => resolve(workerExited(worker)), 2500).unref();
            })
          : worker.adopted && worker.verified
            ? await new Promise<boolean>(async resolve => {
                try {
                  const response = await fetch(
                    "http://127.0.0.1:" + worker.port + "/api/shutdown",
                    {
                      method: "POST",
                      headers: { Authorization: "Bearer " + serverToken },
                      redirect: "error",
                      signal: AbortSignal.timeout(3000),
                    },
                  );
                  if (!response.ok) { resolve(false); return; }
                  await response.arrayBuffer();
                  const deadline = Date.now() + 5000;
                  while (Date.now() < deadline) {
                    if (workerExited(worker)) { resolve(true); return; }
                    await pause(100);
                  }
                  resolve(workerExited(worker));
                } catch {
                  resolve(false);
                }
              })
            : false;
        if (!stopped) {
          blocked.push("PID " + worker.pid + ": shutdown unconfirmed; retained");
          continue;
        }
        const index = retained.findIndex(item => item.pid === worker.pid && item.generationId === worker.generationId);
        if (index >= 0) retained.splice(index, 1);
        retiredPids.push(worker.pid);
        persistCheckpoint();
      }
      lastDrain = { checked: candidates.length, retiredPids, blocked, at: Date.now() };
      persistCheckpoint();
      return status();
    } finally {
      restarting = false;
    }
  }

  function scheduleConservativeAutoDrain(delayMs = 1_500): void {
    if (process.env.SUPERAGENT_CORE_AUTO_DRAIN_RETAINED === "0" || autoDrainTimer) return;
    const eligible = retained.some(worker =>
      worker.drainEligible && !worker.adopted && !workerExited(worker));
    if (!eligible) return;
    autoDrainTimer = setTimeout(() => {
      autoDrainTimer = undefined;
      if (restarting) {
        scheduleConservativeAutoDrain(2_000);
        return;
      }
      void drain().catch(() => {}).finally(() => {
        if (retained.some(worker =>
          worker.drainEligible && !worker.adopted && !workerExited(worker))) {
          scheduleConservativeAutoDrain(30_000);
        }
      });
    }, Math.max(250, delayMs));
    autoDrainTimer.unref?.();
  }

  // On an observed active process exit, prefer a verified prior generation
  // for NEW traffic. Sessions owned by the failed worker remain unavailable,
  // rather than being silently moved to an incompatible in-memory agent.
  const failureMonitor = setInterval(() => {
    if (active && workerExited(active) && !restarting) {
      void rollback("active-worker-exited").catch(() => {});
    }
  }, 1500);
  failureMonitor.unref();

  /**
   * Keep requests for pre-restart sessions on their original worker,
   * including chat (sessionId in JSON), SSE, and upgraded sockets.
   * The actual worker still enforces workspace/client-mode authorization.
   */
  const listener = http.createServer((req, res) => {
    const route = inspectCoreSessionRequest(req.url, req.method, req.headers);
    // Never expose the internal inspection protocol on the stable public port.
    if (route.pathname.startsWith("/_core/")) { res.writeHead(404); res.end(); return; }
    const forward = (bufferedBody?: Buffer) => {
      const inspected = bufferedBody
        ? inspectCoreSessionRequest(req.url, req.method, req.headers, bufferedBody.toString("utf8"))
        : route;
      if (!active) { res.writeHead(503); res.end("Core starting"); return; }
      let worker = selectWorker(inspected.sessionId);
      let fromDeadOwner: Generation | undefined;
      if (worker && inspected.isSessionRegistration && inspected.sessionId &&
          workerExited(worker) && bufferedBody && active && !workerExited(active)) {
        let resumeBody: Record<string, unknown> = {};
        try { resumeBody = JSON.parse(bufferedBody.toString("utf8")); } catch {}
        if (mayRouteExplicitCoreResume({
          id: inspected.sessionId,
          postedResume: resumeBody.resume,
          postedSessionId: resumeBody.sessionId,
          oldWorkerUnavailable: true,
          candidateDifferent: active.pid !== worker.pid,
        })) {
          fromDeadOwner = worker;
          worker = active;
        }
      }
      if (!worker) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session owner is no longer available; explicitly resume the session.",
          code: "SESSION_OWNER_UNAVAILABLE", requiresExplicitResume: true,
          automaticChatReplayAllowed: false }));
        return;
      }
      if (workerExited(worker)) {
        // Do not reassign an existing session to a worker with no in-memory state.
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session worker unavailable; explicitly resume the session.",
          code: "SESSION_WORKER_DEAD", requiresExplicitResume: true,
          automaticChatReplayAllowed: false }));
        return;
      }
      const release = acquire(worker);
      res.once("close", release);
      res.once("finish", release);
      const forwardedHeaders = { ...req.headers };
      delete forwardedHeaders["x-superagent-internal-token"];
      const proxy = http.request({
        host: "127.0.0.1", port: worker.port,
        path: req.url, method: req.method, headers: forwardedHeaders,
      }, upstream => {
        if (!inspected.isSessionRegistration || upstream.statusCode !== 200) {
          res.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(res);
          return;
        }
        // Never acknowledge a successful session initialization until its
        // owner mapping has been durably checkpointed. Bounded JSON only.
        const chunks: Buffer[] = [];
        let size = 0;
        upstream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 16 * 1024) chunks.push(chunk);
        });
        upstream.once("end", () => {
          if (size > 16 * 1024) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Core session response exceeds safe checkpoint limit" }));
            return;
          }
          const recorded = Buffer.concat(chunks).toString("utf8");
          const sessionId = fromDeadOwner && inspected.sessionId
            ? sessionAffinity.rebindFromResponse(
              upstream.statusCode || 0, recorded, inspected.sessionId, fromDeadOwner, worker,
            )
            : sessionAffinity.registerFromResponse(
              upstream.statusCode || 0, recorded, worker, inspected.sessionId,
            );
          if (!sessionId) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Core session affinity could not be registered safely" }));
            return;
          }
          try { persistCheckpoint(); }
          catch {
            if (fromDeadOwner && sessionId) {
              sessionAffinity.restoreRebindAfterFailedCheckpoint(sessionId, fromDeadOwner, worker);
            }
            console.error("[core] Failed to persist session affinity checkpoint");
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Core session checkpoint unavailable; retry initialization" }));
            return;
          }
          res.writeHead(200, upstream.headers);
          res.end(Buffer.concat(chunks));
        });
        upstream.once("error", () => {
          if (!res.headersSent) res.writeHead(502);
          if (!res.writableEnded) res.end("Core upstream unavailable");
        });
      });
      proxy.once("error", () => {
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end("Core upstream unavailable");
      });
      res.once("close", () => { if (!res.writableEnded) proxy.destroy(); });
      if (bufferedBody) proxy.end(bufferedBody);
      else req.pipe(proxy);
    };

    // Session-bound requests already identify their worker in the URL/header.
    // Do not buffer multimodal chat uploads (up to the backend's 32 MiB limit)
    // just to inspect JSON. Registration still needs its response/ID matching.
    if (!route.parseBody || route.sessionId && !route.isSessionRegistration) {
      forward();
      return;
    }

    // Only inspect bounded JSON bodies on session-bearing endpoints.
    // Other endpoints retain request streaming and are never buffered.
    const bodyChunks: Buffer[] = [];
    let length = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      length += chunk.length;
      if (length > CORE_ROUTING_BODY_LIMIT) {
        overflow = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session request body exceeds routing limit." }));
        return;
      }
      bodyChunks.push(chunk);
    });
    req.once("end", () => { if (!overflow) forward(Buffer.concat(bodyChunks)); });
    req.once("error", () => { if (!res.writableEnded) res.destroy(); });
  });
  listener.on("upgrade", (req, socket, head) => {
    if (!active) { socket.destroy(); return; }
    const inspected = inspectCoreSessionRequest(req.url, req.method, req.headers);
    if (inspected.pathname.startsWith("/_core/")) { socket.destroy(); return; }
    const worker = selectWorker(inspected.sessionId);
    if (!worker) { socket.destroy(); return; }
    if (workerExited(worker)) {
      socket.destroy();
      return;
    }
    const release = acquire(worker);
    socket.once("close", release);
    const upstream = net.connect(worker.port, "127.0.0.1", () => {
      upstream.once("close", release);
      const lines = [req.method + " " + (req.url || "/") + " HTTP/" + req.httpVersion];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(req.rawHeaders[i] + ": " + req.rawHeaders[i + 1]);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  const control = http.createServer(async (req, res) => {
    const provided = (req.headers.authorization || "").replace(/^Bearer /, "");
    const a = Buffer.from(provided);
    const b = Buffer.from(controlToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401); res.end(); return;
    }
    try {
      let result: CoreRuntimeStatus | null = null;
      const action = req.method === "POST" && req.url === "/restart" ? "restart"
        : req.method === "POST" && req.url === "/rollback" ? "rollback"
        : req.method === "POST" && req.url === "/drain" ? "drain" : null;
      if (req.method === "GET" && req.url === "/status") {
        result = status();
      } else if (action) {
        const rawId = req.headers["x-superagent-operation-id"];
        const rawDigest = req.headers["x-superagent-expected-build"];
        if ((rawId !== undefined && typeof rawId !== "string") ||
            (rawDigest !== undefined && (typeof rawDigest !== "string" || !/^[a-f0-9]{64}$/.test(rawDigest))))
          throw new Error("CORE_OPERATION_INVALID_HEADERS");
        const id = rawId ? validateCoreOperationId(rawId) : crypto.randomUUID();
        const build = inspectCoreBuild(coreEntry, { requireFreshCompiled: true });
        if (rawDigest && rawDigest !== build.digest)
          throw new Error("CORE_BUILD_CHANGED_SINCE_PLAN");
        const operation = lifecycleLedger.begin({
          id, action, expectedBuildDigest: build.digest,
          beforePid: active!.pid,
        });
        if (operation.replayed) {
          // Previously completed, never execute the requested mutation twice.
          if (active!.pid !== operation.receipt.afterPid)
            throw new Error("CORE_OPERATION_COMPLETED_BUT_STATE_MOVED: inspect status before new action");
          result = {
            ...status(),
            operation: { operationHashPrefix: operation.receipt.operationHash.slice(0,16),
              replayed: true, action },
          };
        } else {
          try {
            const updated = action === "restart" ? await restart()
              : action === "rollback" ? await rollback("operator-requested")
              : await drain();
            if (action === "restart" && updated.active.buildDigest !== build.digest)
              throw new Error("CORE_BUILD_ATTESTATION_MISMATCH");
            lifecycleLedger.complete(id, updated.active.pid);
            result = {
              ...updated,
              operation: { operationHashPrefix: operation.receipt.operationHash.slice(0,16),
                replayed: false, action },
            };
          } catch (error) {
            // A crash before this write leaves a PENDING receipt. Recovery
            // refuses silent retries; an operator must reconcile the outcome.
            lifecycleLedger.fail(id, "CORE_OPERATION_FAILED");
            throw error;
          }
        }
      }
      if (!result) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  if (checkpoint) {
    const restored: Generation[] = checkpoint.workers.map(worker => ({
      ...worker, child: undefined, adopted: true, verified: false,
    }));
    // Adoption requires authenticated proof from the ORIGINAL worker at
    // its persisted private port, including a 128-bit generation identity.
    for (const worker of restored) worker.verified = await verifyRecoveryWorker(worker);
    const chosen = restored.find(worker => worker.pid === checkpoint.activePid && worker.verified)
      || restored.slice().reverse().find(worker => worker.verified);
    if (!chosen) throw new Error("No authenticated worker survived; refusing unsafe recovery");
    active = chosen;
    retained.push(...restored.filter(worker => worker !== chosen));
    sessionAffinity.restore(checkpoint.sessions);
    recovered = true;
  }

  try {
    // Do not bind over existing live REST/SSE or tunnel endpoints.
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", () => resolve());
    });
    if (!checkpoint) active = await spawnWorker();
    // Recovery may temporarily serve an adopted worker whose verifier belongs
    // to the previous supervisor channel. Publishing the new broker is still
    // safe: such requests fail attestation until an explicit restart creates a
    // worker provisioned by this supervisor. The broker must already exist so
    // MCP can rotate to that new channel without another owner replacement.
    delegateForwardingBroker = await startCoreSupervisorDelegateForwardingBroker({
      publicPort: port,
      supervisorPid: process.pid,
      controlToken,
      material: delegateForwardingMaterial,
    });
    const controlAddress = control.address();
    if (!controlAddress || typeof controlAddress === "string") throw new Error("Control port missing");
    persistCheckpoint();
    saveJsonAtomic(statePath(port), {
      supervisorPid: process.pid, publicPort: port, controlPort: controlAddress.port, controlToken,
    } satisfies SupervisorDiscovery);
    // Keep public credentials stable; private workers must never overwrite this file.
    const authInfo = { port, pid: process.pid, authToken: serverToken, startedAt: Date.now() };
    saveJsonAtomic(path.join(stateDir(), "server-info-" + port + ".json"), authInfo);
    // The legacy unqualified lookup belongs to the default API port only.
    // Avoid changing another live T-Line instance when using a custom port.
    if (port === 7888) saveJsonAtomic(path.join(stateDir(), "server-info.json"), authInfo);
    // Only the public owner attempts auto-launch, after the supervised
    // server/worker registration has been successfully established.
    void import("./trayAutoLauncher.js")
      .then(({ autoLaunchSuperAgentTray }) => autoLaunchSuperAgentTray())
      .catch(() => {});
    console.log("Core supervisor listening on http://127.0.0.1:" + port);
    console.log("Worker PID " + active!.pid + "; use: superagent core restart --port " + port);
    if (recovered) console.log("Authenticated supervisor recovery completed; old sessions kept on original workers.");
    scheduleConservativeAutoDrain();
    console.log("MCP, Muse and Telegram processes are not controlled by this supervisor.");
  } catch (error) {
    if (autoDrainTimer) clearTimeout(autoDrainTimer);
    clearInterval(failureMonitor);
    await delegateForwardingBroker?.close().catch(() => {});
    control.close();
    listener.close();
    throw error;
  }
}

export function formatCoreSupervisorStatus(value: CoreRuntimeStatus): string {
  return [
    "SuperAgent supervised API core: ACTIVE",
    "Public port: " + value.publicPort,
    "Supervisor PID: " + value.supervisorPid,
    "Active worker: PID " + value.active.pid + " / internal port " + value.active.port,
    "Retained previous workers: " + value.retained.length,
    "Recovered from checkpoint: " + Boolean(value.recovered),
    "Session IDs pinned to origin workers: " + (value.affinitySessions ?? 0),
    "Retained-worker safety limit: " + (value.maxRetainedWorkers ?? MAX_RETAINED_CORE_WORKERS),
    ...(value.lastRollback ? ["Last rollback: " + value.lastRollback.reason +
      " (PID " + value.lastRollback.fromPid + " -> " + value.lastRollback.toPid + ")"] : []),
    ...(value.lastDrain ? ["Last drain: inspected " + value.lastDrain.checked +
      ", retired " + value.lastDrain.retiredPids.length,
      ...value.lastDrain.blocked.map(reason => "  blocked: " + reason)] : []),
    "Existing connections stay on origin workers; only explicit verified drain retires idle generations.",
  ].join("\n");
}

export async function handleCoreCliCommand(argv: string[]): Promise<void> {
  const action = argv[0]?.toLowerCase() || "status";
  const portIdx = argv.indexOf("--port");
  const port = portIdx === -1 ? 7888 : Number(argv[portIdx + 1]);
  if (!validPort(port)) throw new Error("Invalid --port");
  if (action === "help" || action === "--help") {
    console.log("superagent core start [--port 7888] [--client-mode tline|chrome-extension]");
    console.log("superagent core status [--port 7888]");
    console.log("superagent core restart [--port 7888]");
    console.log("superagent core rollback [--port 7888]");
    console.log("superagent core drain [--port 7888]");
    console.log("superagent core retire-legacy-retained --port PORT --pid PID --confirm  # double-verified graceful cleanup of a quiescent pre-isolation retained worker");
    console.log("superagent core operations --port PORT  # pending/completed operation receipts, no secret IDs");
    console.log("superagent core reconcile-operation --port PORT --operation-id ID --observed-pid PID --acknowledge-unknown  # operator-only, after 120s review");
    console.log("superagent core recover [--port 7888] [--client-mode tline|chrome-extension]");
    console.log("superagent core recycle-plan [--port 7888]  # read-only plan for a verified legacy direct Core");
    console.log("superagent core recycle [--port 7888] --approve RECYCLE_LEGACY_CORE  # guarded graceful migration to supervised Core");
    console.log("superagent core guard [--port 7888] [--client-mode tline|chrome-extension] [--adopt-running] [--stop-on-stdin]  # opt-in owned Core crash recovery");
    console.log("superagent core guard-status [--port 7888]  # conservative guardian registration and verified Core identity");
    console.log("superagent core boot [--port 7888] [--client-mode tline|chrome-extension]  # safe logon/bootstrap, never resets dead worker state");
    console.log("superagent core boot-audit [--port 7888]  # read-only cold-reboot and unfinished chat-turn assessment");
    console.log("superagent core evidence-snapshot [--port 7888]  # offline private backup; does NOT restart or clear state");
    console.log("superagent core reconcile --snapshot PATH  # offline read-only turn/receipt evidence; NEVER authorizes restart");
    console.log("superagent core lifecycle-plan  # inspect service separation without installing OS tasks");
    console.log("superagent core ownership-audit [--port 7888]  # read-only Core / MCP TCP owner comparison");
    console.log("superagent core ownership-inventory [--port 7888]  # versioned R0 topology contract, no restart authorization");
    console.log("superagent core rollout-audit [--port 7888]  # R6/R7 read-only release and cutover blockers");
    console.log("superagent core recovery-cases --snapshot PATH [--limit 100] [--offset 0]  # anonymized offline per-session review");
    console.log("superagent core recovery-canary --snapshot PATH --target-port PORT [--approve START_ISOLATED_CANARY]  # fresh isolated canary; never imports old sessions");
    console.log("superagent core lifecycle-observe [--port 7888] [--samples 3]  # bounded authenticated GET-only health samples");
    console.log("superagent core reconnect-check --front-port 7891 --core-port 7888 --session-id ID  # one-shot GET-only T-Line probe");
    console.log("Requires opt-in supervisor startup; existing unsupervised processes are never replaced.");
    return;
  }
  if (action === "retire-legacy-retained") {
    const pidIdx = argv.indexOf("--pid");
    const pid = pidIdx < 0 ? 0 : Number(argv[pidIdx + 1]);
    if (!argv.includes("--confirm")) {
      throw new Error("CORE_LEGACY_RETAINED_CONFIRM_REQUIRED: pass --confirm");
    }
    const { retireLegacyRetainedGeneration } =
      await import("./coreLegacyRetainedRetire.js");
    console.log(JSON.stringify(await retireLegacyRetainedGeneration({
      port, pid, confirm: true,
    }), null, 2));
    return;
  }
  if (action === "recycle-plan" || action === "recycle") {
    const { planLegacyCoreRecycle, scheduleLegacyCoreRecycle } =
      await import("./coreLegacyRecycle.js");
    const plan = await planLegacyCoreRecycle(port);
    if (action === "recycle-plan") {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const approveIdx = argv.indexOf("--approve");
    if (approveIdx < 0 || argv[approveIdx + 1] !== "RECYCLE_LEGACY_CORE")
      throw new Error("CORE_RECYCLE_APPROVAL_REQUIRED: --approve RECYCLE_LEGACY_CORE");
    console.log(JSON.stringify(await scheduleLegacyCoreRecycle(plan, true), null, 2));
    return;
  }
  if (action === "recycle-worker") {
    const read = (name: string) => {
      const idx = argv.indexOf(name);
      return idx < 0 ? "" : String(argv[idx + 1] || "");
    };
    const expectedOwnerPid = Number(read("--expected-owner-pid"));
    const clientMode = read("--client-mode");
    if (!Number.isSafeInteger(expectedOwnerPid) || expectedOwnerPid <= 0 ||
        (clientMode !== "tline" && clientMode !== "chrome-extension"))
      throw new Error("CORE_RECYCLE_HELPER_INVALID_ARGUMENTS");
    const { runLegacyCoreRecycleWorker } = await import("./coreLegacyRecycle.js");
    await runLegacyCoreRecycleWorker({
      service: "core", action: "recycle", port,
      operationId: read("--operation-id"),
      expectedOwnerPid,
      expectedProcessIdentity: read("--expected-process-identity"),
      expectedLegacyCommandDigest: read("--expected-command-digest"),
      expectedBuildDigest: read("--expected-build"),
      clientMode,
      note: "internal recycle helper",
    });
    return;
  }
  if (action === "operations" || action === "reconcile-operation") {
    const current=await requestCoreSupervisor("status",port,1600);
    if(current.publicPort!==port || current.ownerContract?.role!=="core-supervisor" ||
       current.ownerContract?.mcpLifecycle!=="not-owned")
      throw new Error("CORE_OPERATION_OWNER_UNVERIFIED");
    const ledger=new CoreLifecycleLedger(port);
    if(action==="operations"){
      console.log(JSON.stringify({
        port,supervisorPid:current.supervisorPid,activeWorkerPid:current.active.pid,
        receipts:ledger.inspect(),
      },null,2));
      return;
    }
    const idIdx=argv.indexOf("--operation-id"),pidIdx=argv.indexOf("--observed-pid");
    const id=idIdx>=0?argv[idIdx+1]:"",observed=pidIdx>=0?Number(argv[pidIdx+1]):0;
    if(!argv.includes("--acknowledge-unknown") ||
       !Number.isSafeInteger(observed)||observed<=0)
      throw new Error("CORE_OPERATION_OPERATOR_ATTESTATION_REQUIRED");
    console.log(JSON.stringify(ledger.reconcilePending(
      validateCoreOperationId(id),observed,current.active.pid,true),null,2));
    return;
  }
  if (action === "reconnect-check") {
    const frontIdx = argv.indexOf("--front-port");
    const coreIdx = argv.indexOf("--core-port");
    const idIdx = argv.indexOf("--session-id");
    const frontPort = Number(argv[frontIdx + 1]);
    const corePort = Number(argv[coreIdx + 1]);
    const sessionId = argv[idIdx + 1];
    if (frontIdx < 0 || coreIdx < 0 || idIdx < 0 ||
        !validPort(frontPort) || !validPort(corePort) || frontPort === corePort ||
        !sessionId) throw new Error("Require --front-port, --core-port and --session-id");
    const { readCoreCheckpoint } = await import("./coreSupervisorCheckpoint.js");
    const { newTlineReconnectState } = await import("./tlineReconnectPolicy.js");
    const { probeTlineSessionOnce } = await import("./tlineReconnectProbe.js");
    const bearer = readCoreCheckpoint(corePort).serverToken;
    const result = await probeTlineSessionOnce({
      frontDoor: "http://127.0.0.1:" + frontPort + "/",
      bearer, state: newTlineReconnectState(sessionId),
    });
    console.log(JSON.stringify({
      phase: result.state.phase, reason: result.state.reason,
      frontDoorReady: result.frontDoorReady, coreReady: result.coreReady,
      sessionVerified: result.sessionVerified, issuedMethods: result.issuedMethods,
      automaticChatReplayAllowed: false,
    }, null, 2));
    return;
  }
  if (action === "recovery-canary") {
    const idx=argv.indexOf("--snapshot");
    const targetIdx=argv.indexOf("--target-port");
    const approveIdx=argv.indexOf("--approve");
    const folder=idx<0?undefined:argv[idx+1];
    const target=targetIdx<0?undefined:Number(argv[targetIdx+1]);
    if(!folder || target===undefined) throw new Error("Usage: superagent core recovery-canary --snapshot PATH --target-port PORT [--approve START_ISOLATED_CANARY]");
    const {preflightIsolatedCoreCanary,runIsolatedCoreCanary}=await import("./coreRecoveryCanary.js");
    if(approveIdx<0) {
      console.log(JSON.stringify({
        ...(await preflightIsolatedCoreCanary(folder,target)),
        canaryStarted:false,approvalRequired:"START_ISOLATED_CANARY",
        oldSessionsRestored:false,toolReplayAuthorized:false,
      },null,2));
      return;
    }
    const result=await runIsolatedCoreCanary({
      snapshotFolder:folder,targetPort:target,approved:argv[approveIdx+1],
    });
    console.log(JSON.stringify(result,null,2));
    return;
  }
  if (action === "recovery-cases") {
    const idx = argv.indexOf("--snapshot");
    const folder = idx < 0 ? undefined : argv[idx + 1];
    const limitIdx = argv.indexOf("--limit");
    const limit = limitIdx < 0 ? 100 : Number(argv[limitIdx + 1]);
    const offsetIdx = argv.indexOf("--offset");
    const offset = offsetIdx < 0 ? 0 : Number(argv[offsetIdx + 1]);
    if (!folder) throw new Error("Usage: superagent core recovery-cases --snapshot PATH [--limit 100] [--offset 0]");
    const { createCoreRecoveryCasebook } = await import("./coreRecoveryCasebook.js");
    const report = createCoreRecoveryCasebook(folder, limit, offset);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (action === "lifecycle-observe") {
    const idx = argv.indexOf("--samples");
    const samples = idx < 0 ? 3 : Number(argv[idx + 1]);
    const { observeCoreLifecycle } = await import("./coreLifecycleObserver.js");
    console.log(JSON.stringify(await observeCoreLifecycle({ port, samples }), null, 2));
    return;
  }
  if (action === "reconcile") {
    const idx = argv.indexOf("--snapshot");
    const folder = idx < 0 ? undefined : argv[idx + 1];
    if (!folder) throw new Error("Usage: superagent core reconcile --snapshot PATH");
    const { reconcileCoreRecoveryEvidence } = await import("./coreColdReconciliation.js");
    const report = reconcileCoreRecoveryEvidence(folder);
    if (report.port !== port && argv.includes("--port"))
      throw new Error("Snapshot port differs from selected --port");
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (action === "rollout-audit") {
    const { inspectLiveRuntimeRollout } = await import("./runtimeReleaseGateR7.js");
    console.log(JSON.stringify(await inspectLiveRuntimeRollout(port),null,2));
    return;
  }
  if (action === "ownership-inventory") {
    const { captureRuntimeOwnership } = await import("./runtimeOwnershipContract.js");
    console.log(JSON.stringify(await captureRuntimeOwnership(port),null,2));
    return;
  }
  if (action === "ownership-audit") {
    const { auditCoreMcpOwnership } = await import("./coreMcpOwnershipAudit.js");
    console.log(JSON.stringify(await auditCoreMcpOwnership({corePort:port}),null,2));
    return;
  }
  if (action === "lifecycle-plan") {
    const { buildCoreLifecyclePlan } = await import("./coreServiceLifecycle.js");
    console.log(JSON.stringify(buildCoreLifecyclePlan(), null, 2));
    return;
  }
  if (action === "evidence-snapshot") {
    const { createCoreRecoveryEvidence } = await import("./coreRecoveryEvidence.js");
    const result = await createCoreRecoveryEvidence(port);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "boot-audit") {
    const { auditCoreColdStart } = await import("./coreColdStartAudit.js");
    console.log(JSON.stringify(await auditCoreColdStart(port), null, 2));
    return;
  }
  if (action === "boot") {
    const idx = argv.indexOf("--client-mode");
    const mode = idx < 0 ? undefined : argv[idx + 1];
    if (mode !== undefined && mode !== "tline" && mode !== "chrome-extension") throw new Error("Invalid --client-mode");
    const { runCoreBoot } = await import("./coreBoot.js");
    const result = await runCoreBoot({ port, clientMode: mode });
    // start/recover binds a long-lived process: keep it running just as the
    // standalone core start/recover commands do. Already-running is a no-op.
    if (result === "recovered") await new Promise<void>(() => {});
    return;
  }
  if (action === "guard-status") {
    const { readCoreGuardianLease } = await import("./coreGuardian.js");
    const lease = readCoreGuardianLease(port);
    if (!lease) {
      console.log("Core guardian: NOT REGISTERED. No automatic Core supervisor recovery.");
      return;
    }
    let verified = false;
    try {
      const current = await requestCoreSupervisor("status", port, 1200);
      verified = current.publicPort === port && current.supervisorPid !== lease.pid &&
        (lease.supervisorPid === undefined || current.supervisorPid === lease.supervisorPid);
    } catch {}
    console.log("Core guardian registration: " + (verified ?
      "REGISTERED; supervised Core is verified" : "REGISTERED; Core unavailable or unverified") +
      " | guardian PID " + lease.pid + " | port " + port +
      " | mode " + lease.clientMode +
      (lease.ownership ? " | ownership " + lease.ownership : "") +
      ". Lease alone is not live-process proof.");
    return;
  }
  if (action === "guard") {
    const idx = argv.indexOf("--client-mode");
    const mode = idx < 0 ? "tline" : argv[idx + 1];
    if (mode !== "tline" && mode !== "chrome-extension") throw new Error("Invalid --client-mode");
    const { runCoreGuardian } = await import("./coreGuardian.js");
    const controller = argv.includes("--stop-on-stdin") ? new AbortController() : undefined;
    if (controller) {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", data => {
        if (String(data).trim() === "STOP") controller.abort();
      });
    }
    const result = await runCoreGuardian({
      port,
      clientMode: mode,
      signal: controller?.signal,
      adoptRunning: argv.includes("--adopt-running"),
    });
    console.log("Core guardian stopped: " + result.reason + " | checkpoint recoveries: " + result.recoveries);
    if (result.reason !== "stopped") throw new Error("Core guardian requires operator review: " + result.reason);
    return;
  }
  if (action === "start" || action === "recover") {
    const clientModeIdx = argv.indexOf("--client-mode");
    const mode = clientModeIdx < 0
      ? (action === "recover" ? readCoreCheckpoint(port).clientMode : "tline")
      : argv[clientModeIdx + 1];
    if (mode !== "tline" && mode !== "chrome-extension") throw new Error("Invalid --client-mode");
    await runCoreSupervisor(port, mode, action === "recover");
    return;
  }
  if (action !== "status" && action !== "restart" && action !== "rollback" && action !== "drain") throw new Error("Expected start, recover, recycle-plan, recycle, retire-legacy-retained, boot, boot-audit, reconcile, recovery-cases, recovery-canary, ownership-audit, ownership-inventory, rollout-audit, lifecycle-plan, lifecycle-observe, evidence-snapshot, reconnect-check, guard, guard-status, status, restart, rollback, drain or help");
  console.log(formatCoreSupervisorStatus(await requestCoreSupervisor(action, port)));
}
