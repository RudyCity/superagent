import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { getRootConfigDir } from "../config/paths.js";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { CoreDrainReport } from "./coreDrainInspection.js";
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
  rollbackCandidates,
} from "./coreGenerationPolicy.js";

export interface CoreRuntimeStatus {
  supervisorPid: number;
  publicPort: number;
  active: { pid: number; port: number; since: number };
  retained: Array<{ pid: number; port: number; since: number }>;
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
): Promise<CoreRuntimeStatus> {
  let info: SupervisorDiscovery;
  try { info = readDiscovery(port); }
  catch { throw new Error("No supervised core is registered on port " + port + ". Start: superagent core start --port " + port); }
  return new Promise<CoreRuntimeStatus>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: info.controlPort, method: action === "status" ? "GET" : "POST",
      path: "/" + action,
      timeout: timeoutMs,
      headers: { Authorization: "Bearer " + info.controlToken },
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
    throw new Error("Supervisor checkpoint exists for port " + port +
      ". Use core recover --port " + port + " to verify/adopt old workers; refusing fresh overwrite.");
  }
  if (checkpoint && checkpoint.clientMode !== clientMode) {
    throw new Error("Recovery client mode differs from saved supervisor");
  }
  const controlToken = crypto.randomBytes(32).toString("hex");
  // Stable bearer across crash recovery for reconnecting clients.
  const serverToken = checkpoint?.serverToken || crypto.randomBytes(24).toString("hex");
  const inspectToken = checkpoint?.inspectToken || crypto.randomBytes(32).toString("hex");
  let active: Generation | undefined;
  const retained: Generation[] = [];
  const sessionAffinity = new CoreSessionAffinity();
  let restarting = false;
  let lastRollback: CoreRuntimeStatus["lastRollback"];
  let lastDrain: CoreRuntimeStatus["lastDrain"];
  let recovered = false;

  function persistCheckpoint(): void {
    if (!active) return;
    const workers = [active, ...retained].map(({ pid, port: workerPort, since, generationId, drainEligible }) =>
      ({ pid, port: workerPort, since, generationId, drainEligible }));
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
    // Isolated staging owns no shared helper/tunnel and may retire all of its
    // own workers after session/inflight/transport drain verification.
    const staging = process.env.SUPERAGENT_CORE_STAGING === "1";
    const drainEligible = !!active || staging;
    const entry = path.resolve(process.argv[1] || "");
    const child = spawn(process.execPath, [entry, "--server", String(workerPort), "--client-mode", clientMode], {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
      detached: true,
      env: {
        ...process.env,
        SUPERAGENT_CORE_WORKER: "1",
        SUPERAGENT_CORE_GENERATION_ID: generationId,
        SUPERAGENT_CORE_INSPECT_TOKEN: inspectToken,
        // First generation owns the fixed-port vision helper and cannot be
        // retired automatically. Others are API-only (no sidecar listeners).
        SUPERAGENT_CORE_TRANSPORT_ISOLATED: drainEligible ? "1" : "0",
        // Launch fixed-port vision helper only once from generation #1.
        // Subsequent workers can use the same helper without binding 8095 again.
        SUPERAGENT_CORE_VISION_OWNER: staging ? "0" : active ? "0" : "1",
        SUPERAGENT_SERVER_AUTH_TOKEN: serverToken,
      },
    });
    child.once("error", () => { /* readiness reports a failed spawn */ });
    child.unref();
    try { await ready(workerPort, child, serverToken); }
    catch (error) {
      // Only the candidate worker can be stopped on failure; active traffic is untouched.
      try { child.kill(); } catch {}
      throw error;
    }
    if (!child.pid) throw new Error("Worker PID unavailable");
    return { child, pid: child.pid, port: workerPort, since: Date.now(), generationId,
      drainEligible, adopted: false, verified: true };
  }

  function status(): CoreRuntimeStatus {
    if (!active) throw new Error("No healthy core worker");
    return {
      supervisorPid: process.pid,
      publicPort: port,
      active: { pid: active.pid, port: active.port, since: active.since },
      retained: retained.map(({ pid, port: workerPort, since }) => ({ pid, port: workerPort, since })),
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
          throw error;
        }
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
      if (active) retained.push(active); // never kill existing generation
      active = candidate;
      try {
        persistCheckpoint();
      } catch (error) {
        active = previous;
        if (previous) retained.pop();
        try { candidate.child?.kill(); } catch {}
        throw error;
      }
      return status();
    } finally {
      restarting = false;
    }
  }

  async function inspectForDrain(worker: Generation): Promise<CoreDrainReport | undefined> {
    if (!worker.drainEligible || workerExited(worker)) return undefined;
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
            resolve(report.pid === worker.pid && report.workerGenerationId === worker.generationId
              && report.transportIsolated && !report.visionOwner &&
              typeof report.safe === "boolean" && Array.isArray(report.blockers)
              ? report : undefined);
          } catch { resolve(undefined); }
        });
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => resolve(undefined));
    });
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
          // Keep the recorded dead generation and fail closed on its pinned
          // sessions. Process liveness alone is not a safe cleanup permission.
          blocked.push("PID " + worker.pid + ": worker already exited");
          continue;
        }
        if (!worker.drainEligible || worker.adopted) {
          blocked.push("PID " + worker.pid + ": owns helper or adopted process (cannot signal)");
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
        const first = await inspectForDrain(worker);
        if (!first?.safe) {
          blocked.push("PID " + worker.pid + ": " + (first?.blockers.join(", ") || "inspection unavailable"));
          continue;
        }
        // Observe quiescence twice after a delay; reject a newly active worker.
        await pause(300);
        const second = await inspectForDrain(worker);
        if (!second?.safe || (inflight.get(worker.pid) || 0) !== 0 ||
            sessionAffinity.countForOwner(worker) !== 0) {
          blocked.push("PID " + worker.pid + ": changed state during drain verification");
          continue;
        }
        // Only a supervisor-spawned, private, nonce-verified process with no
        // sessions, jobs, subprocesses, streams or auxiliary listeners can
        // be requested to stop. Never use taskkill /T or signal a tunnel PID.
        const stopped = await new Promise<boolean>(resolve => {
          if (!worker.child) { resolve(false); return; }
          worker.child.once("exit", () => resolve(true));
          if (!worker.child.kill("SIGTERM")) { resolve(false); return; }
          setTimeout(() => resolve(workerExited(worker)), 2500).unref();
        });
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
        res.end(JSON.stringify({ error: "Session owner is no longer available; explicitly resume the session." }));
        return;
      }
      if (workerExited(worker)) {
        // Do not reassign an existing session to a worker with no in-memory state.
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session worker unavailable; explicitly resume the session." }));
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
      const result = req.method === "GET" && req.url === "/status"
        ? status()
        : req.method === "POST" && req.url === "/restart"
          ? await restart()
          : req.method === "POST" && req.url === "/rollback"
            ? await rollback("operator-requested")
            : req.method === "POST" && req.url === "/drain"
              ? await drain()
              : null;
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
    console.log("Core supervisor listening on http://127.0.0.1:" + port);
    console.log("Worker PID " + active!.pid + "; use: superagent core restart --port " + port);
    if (recovered) console.log("Authenticated supervisor recovery completed; old sessions kept on original workers.");
    console.log("MCP, Muse and Telegram processes are not controlled by this supervisor.");
  } catch (error) {
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
    console.log("superagent core recover [--port 7888] [--client-mode tline|chrome-extension]");
    console.log("superagent core guard [--port 7888] [--client-mode tline|chrome-extension] [--stop-on-stdin]  # opt-in owned Core crash recovery");
    console.log("superagent core guard-status [--port 7888]  # conservative guardian registration and verified Core identity");
    console.log("superagent core boot [--port 7888] [--client-mode tline|chrome-extension]  # safe logon/bootstrap, never resets dead worker state");
    console.log("Requires opt-in supervisor startup; existing unsupervised processes are never replaced.");
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
      verified = current.publicPort === port && current.supervisorPid !== lease.pid;
    } catch {}
    console.log("Core guardian registration: " + (verified ?
      "REGISTERED; supervised Core is verified" : "REGISTERED; Core unavailable or unverified") +
      " | guardian PID " + lease.pid + " | port " + port +
      " | mode " + lease.clientMode + ". Lease alone is not live-process proof.");
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
    const result = await runCoreGuardian({ port, clientMode: mode, signal: controller?.signal });
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
  if (action !== "status" && action !== "restart" && action !== "rollback" && action !== "drain") throw new Error("Expected start, recover, boot, guard, guard-status, status, restart, rollback, drain or help");
  console.log(formatCoreSupervisorStatus(await requestCoreSupervisor(action, port)));
}
