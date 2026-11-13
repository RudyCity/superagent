/**
 * Durable public MCP ingress: the owner keeps Cloudflare's Quick Tunnel,
 * OAuth issuer and the listening socket stable while private backend
 * processes are replaced from the current compiled SuperAgent source.
 *
 * This is NOT the R3 staging ingress: it manages one private worker per
 * generation and preserves existing MCP session affinity across swaps.
 */
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { startQuickTunnel, stopQuickTunnel, getTunnelStatus } from "../remoteAgent/cloudflareTunnel.js";
import { getMcpStateFile, type McpTunnelInfo } from "../mcp/mcpTunnel.js";
import { generateMcpBearerToken, getDefaultSafeTools } from "../mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../mcp/mcpOAuthRoutes.js";
import {
  sanitizedMcpIngressHeaders, isPermittedMcpIngressPath,
} from "./mcpIngressStage.js";
import {
  DISABLED_BOOTSTRAP_HASH,
  type ReloadableBackendOptions, type BackendWorkerReply,
  type BootstrapRotateRequest,
} from "./mcpReloadableBackend.js";
import { MCP_TOOL_DEFINITIONS, DISABLED_MCP_TOOLS } from "../mcp/superagentMcpServer.js";
import { appendMcpOwnerLog } from "./mcpOwnerLog.js";
import {
  assessMemoryTrend, trimMemoryTrendSamples,
  type MemoryTrendAssessment, type MemoryTrendSample,
} from "./memoryTrend.js";
import { decideMcpMemoryRecovery } from "./mcpMemoryRecoveryPolicy.js";
import { verifyMcpBackendRelease, type VerifiedMcpBackendRelease } from "./mcpBackendReleasePolicy.js";
import { findOrphanedMcpAffinities } from "./mcpSessionReconcile.js";

const WORKER_START_MS = 30_000;
const OLD_GENERATION_TTL = 4 * 60 * 60_000 + 5 * 60_000;
const AUTO_RECOVERY_LIMIT_PER_HOUR = 2;
const AUTO_RECOVERY_DELAY_MS = 750;
export interface ReloadableOwnerOptions {
  port: number;
  nonce: string;
  createdAt: number;
  cliEntry: string;
  authMode: "oauth" | "static-bearer";
  allowDangerous: boolean;
  auditLogPath?: string;
}

type BackendHealthReply = Extract<BackendWorkerReply, {type:"mcp-reload-worker-health"}>;

interface BackendGeneration {
  child: ChildProcess;
  pid: number;
  port: number;
  sessions: Set<string>;
  inFlight: number;
  retireAt: number | null;
  alive: boolean;
  oauthStatePersistent: boolean;
  lastHealth: BackendHealthReply | null;
  memorySamples: MemoryTrendSample[];
  memoryTrend: MemoryTrendAssessment;
}

function bearerMatches(provided: string, secret: string): boolean {
  if (!provided || !secret) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function createReloadWorker(
  entry: string, options: ReloadableBackendOptions,
): Promise<BackendGeneration> {
  const executable = path.resolve(entry);
  const child = fork(executable, ["mcp", "backend-worker"], {
    execPath: process.execPath,
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    ...({ windowsHide: true } as any),
    env: { ...process.env, SUPERAGENT_MCP_RELOAD_WORKER: "1" },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, ready?: BackendGeneration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) {
        try { child.kill("SIGTERM"); } catch {}
        reject(error);
      } else resolve(ready!);
    };
    const onError = (e: Error) => finish(e);
    const onExit = (code: number | null) => finish(new Error("MCP backend exited during startup: " + code));
    const onMessage = (msg: unknown) => {
      const m = msg as BackendWorkerReply | null;
      if (m?.type === "mcp-reload-worker-error") {
        finish(new Error("MCP backend refused startup: " + m.message));
      }
      if (m?.type === "mcp-reload-worker-ready" && m.protocolVersion === 1 &&
          Number.isSafeInteger(m.port) && m.port > 0 && m.port <= 65535) {
        const ready: BackendGeneration = {
          child, pid: child.pid!, port: m.port,
          sessions: new Set(), inFlight: 0, retireAt: null, alive: true,
          oauthStatePersistent: m.oauthStatePersistent === true,
          lastHealth: null, memorySamples: [], memoryTrend: assessMemoryTrend([]),
        };
        child.once("exit", () => { ready.alive = false; });
        finish(undefined, ready);
      }
    };
    const timer = setTimeout(() => finish(new Error("MCP backend did not become ready before deadline")), WORKER_START_MS);
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
    child.send({ type: "mcp-reload-worker-start", options });
  });
}

export interface ReloadableMcpOwnerHandle {
  info: McpTunnelInfo;
  close: () => Promise<void>;
}

export async function startReloadableMcpTunnelOwner(
  opts: ReloadableOwnerOptions,
): Promise<ReloadableMcpOwnerHandle> {
  if (!Number.isSafeInteger(opts.port) || opts.port < 1024 || opts.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(opts.nonce) ||
      !Number.isSafeInteger(opts.createdAt) || opts.createdAt <= 0) {
    throw new Error("Invalid reloadable MCP owner identity");
  }
  const established = getTunnelStatus(opts.port);
  if (established.isRunning) {
    // Never attach to an unowned or wrong-target cloudflared process.
    throw new Error("Existing tunnel on MCP port must be examined and stopped before initial reloadable-owner migration");
  }

  let current: BackendGeneration | undefined;
  let activeBackendEntry = path.resolve(opts.cliEntry);
  let activeReleaseDigest: string | null = null;
  const generations = new Set<BackendGeneration>();
  const sessions = new Map<string, BackendGeneration>();
  const sessionRegisteredAt = new Map<string, number>();
  const sessionInFlight = new Map<string, number>();
  let activeSseStreams = 0;
  let draining = false;
  let closing = false;
  let reloading = false;
  let rotatingBootstrap = false;
  let baseUrl = "";
  let oauthPersistent = true;
  let bearerToken = generateMcpBearerToken();
  const bootCode = generateBootstrapCode();
  let bootCodeHash = bootCode.codeHash;
  let initialBoot = bootCode.code;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let publicTunnelOwned = false;
  let reloadCount = 0;
  let lastReloadAt: number | undefined;
  let lastAutoRecoveryAt: number | undefined;
  let lastMemoryRecoveryAt: number | undefined;
  let staleAffinityReclaimed = 0;
  let autoRecoveryAttempts: number[] = [];
  function record(event: Parameters<typeof appendMcpOwnerLog>[1], fields: {
    backendPid?: number; previousBackendPid?: number;
    durationMs?: number; code?: string;
  } = {}): void {
    try { appendMcpOwnerLog(opts.port, event, {ownerPid:process.pid, ...fields}); }
    catch { /* Logging must not affect MCP operation */ }
  }
  function updateOwnerState(): void {
    try {
      const file = getMcpStateFile(opts.port);
      const state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (state.pid !== process.pid || state.publicUrl !== baseUrl + "/mcp") return;
      fs.writeFileSync(file, JSON.stringify({
        ...state, reloadable:true, backendPid:current?.pid ?? null,
        backendGeneration:reloadCount + 1,
        ...(lastReloadAt !== undefined ? {lastReloadAt} : {}),
      }, null, 2) + String.fromCharCode(10), {mode:0o600});
    } catch { /* keep serving even if status persistence fails */ }
  }

  function requestCount(): number {
    return [...generations].reduce((total, gen) => total + gen.inFlight, 0);
  }
  function forgetSession(sessionId: string, expected?: BackendGeneration): boolean {
    const generation = sessions.get(sessionId);
    if (!generation || (expected && generation !== expected)) return false;
    generation.sessions.delete(sessionId);
    sessions.delete(sessionId);
    sessionRegisteredAt.delete(sessionId);
    return true;
  }
  function rememberSession(sessionId: string, generation: BackendGeneration): void {
    const previous = sessions.get(sessionId);
    if (previous && previous !== generation) previous.sessions.delete(sessionId);
    sessions.set(sessionId, generation);
    generation.sessions.add(sessionId);
    if (previous !== generation) sessionRegisteredAt.set(sessionId, Date.now());
  }
  function onBackendSessionClosed(gen: BackendGeneration, message: unknown): void {
    const event = message as Partial<BackendWorkerReply> | null;
    if (event?.type !== "mcp-reload-worker-session-closed" ||
        typeof event.sessionId !== "string" || !event.sessionId) return;
    forgetSession(event.sessionId, gen);
  }
  function onBackendHealth(gen: BackendGeneration, message: unknown): void {
    const event = message as BackendHealthReply | null;
    if (event?.type !== "mcp-reload-worker-health" ||
        !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0 ||
        !Number.isFinite(event.rssBytes) || event.rssBytes < 0 ||
        !Number.isFinite(event.heapUsedBytes) || event.heapUsedBytes < 0 ||
        !event.sessionStats ||
        !Number.isSafeInteger(event.sessionStats.activeSessions) ||
        event.sessionStats.activeSessions < 0) return;
    if (gen.lastHealth && event.timestamp < gen.lastHealth.timestamp) return;
    gen.lastHealth = event;
    // Health/affinity is sampled every 5s, but preserve the existing 60s
    // memory-trend window. Faster memory samples would change auto-recovery
    // thresholds and could cause unnecessary live backend reloads.
    if (!gen.memorySamples.length ||
        event.timestamp - gen.memorySamples[gen.memorySamples.length - 1].at >= 60_000) {
      gen.memorySamples = trimMemoryTrendSamples([
        ...gen.memorySamples,
        {at:event.timestamp, rssBytes:event.rssBytes, heapUsedBytes:event.heapUsedBytes},
      ], 12);
      gen.memoryTrend = assessMemoryTrend(gen.memorySamples);
    }

    // The worker registry is authoritative. Reconcile exact private IPC IDs
    // per generation, never from counts alone. Do not discard sessions created
    // after the snapshot or sessions with live requests (including SSE).
    const orphaned = findOrphanedMcpAffinities({
      ownerIds: [...gen.sessions], workerIds: event.activeSessionIds,
      workerCount: event.sessionStats.activeSessions,
      registeredAt: sessionRegisteredAt, inFlight: sessionInFlight,
      snapshotAt: event.timestamp,
    });
    for (const id of orphaned) {
      if (forgetSession(id, gen)) staleAffinityReclaimed++;
    }
    if (gen === current) void recoverBackendFromMemoryTrend(gen);
  }
  /** Update a single trusted child over IPC and wait for an explicit ACK.
   * No bootstrap plaintext ever enters child messages or log files.
   */
  async function setBootstrapHash(gen: BackendGeneration, hash: string): Promise<void> {
    if (!gen.alive) throw new Error("MCP_BOOTSTRAP_BACKEND_UNAVAILABLE");
    const requestId = crypto.randomBytes(8).toString("hex");
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true; clearTimeout(timeout);
        gen.child.off("message", onMessage);
        gen.child.off("exit", onExit);
        if (err) reject(err); else resolve();
      };
      const onExit = () => finish(new Error("MCP_BOOTSTRAP_BACKEND_UNAVAILABLE"));
      const onMessage = (data: unknown) => {
        const ack = data as Partial<BackendWorkerReply> | null;
        if (ack?.type === "mcp-reload-worker-bootstrap-rotated" &&
            ack.requestId === requestId) finish();
      };
      const timeout = setTimeout(
        () => finish(new Error("MCP_BOOTSTRAP_ACK_TIMEOUT")), 4_000,
      );
      gen.child.on("message", onMessage);
      gen.child.once("exit", onExit);
      try {
        gen.child.send({
          type:"mcp-reload-worker-bootstrap-rotate",
          requestId, codeHash:hash,
        } satisfies BootstrapRotateRequest, error => {
          if (error) finish(new Error("MCP_BOOTSTRAP_IPC_FAILED"));
        });
      } catch { finish(new Error("MCP_BOOTSTRAP_IPC_FAILED")); }
    });
  }
  function onBootstrapConsumed(gen: BackendGeneration, message: unknown): void {
    const event = message as Partial<BackendWorkerReply> | null;
    if (event?.type !== "mcp-reload-worker-bootstrap-consumed" ||
        gen !== current || event.hash !== bootCodeHash) return;
    bootCodeHash = DISABLED_BOOTSTRAP_HASH;
    record("bootstrap_consumed", {backendPid:gen.pid});
    // Old OAuth authorization endpoints are routed to the current worker only.
  }
  async function rotateBootstrap(): Promise<{ success:true; code:string; url:string; backendPid:number }> {
    if (opts.authMode !== "oauth") throw new Error("MCP_BOOTSTRAP_OAUTH_REQUIRED");
    if (closing || draining || reloading || rotatingBootstrap) {
      throw new Error("MCP_BOOTSTRAP_ROTATION_BUSY");
    }
    const serving = current;
    if (!serving?.alive) throw new Error("MCP_BOOTSTRAP_BACKEND_UNAVAILABLE");
    rotatingBootstrap = true;
    try {
      const next = generateBootstrapCode();
      await setBootstrapHash(serving, next.codeHash);
      bootCodeHash = next.codeHash;
      record("bootstrap_rotated", {backendPid:serving.pid});
      return {
        success:true, code:next.code, url:baseUrl + "/mcp",
        backendPid:serving.pid,
      };
    } finally { rotatingBootstrap = false; }
  }
  function retireOld(): void {
    for (const gen of generations) {
      if (gen === current || gen.retireAt === null) continue;
      if (gen.sessions.size === 0 && gen.inFlight === 0 ||
          Date.now() >= gen.retireAt && gen.inFlight === 0) {
        for (const id of [...gen.sessions]) forgetSession(id, gen);
        generations.delete(gen);
        try { gen.child.kill("SIGTERM"); } catch {}
      }
    }
  }

  function pruneAutoRecoveryAttempts(now = Date.now()): void {
    autoRecoveryAttempts = autoRecoveryAttempts.filter(at => at > now - 60 * 60_000);
  }

  function scheduleBackendAutoRecovery(failed: BackendGeneration): void {
    if (closing || draining || failed !== current || failed.alive || recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void recoverBackendAfterExit(failed);
    }, AUTO_RECOVERY_DELAY_MS);
    recoveryTimer.unref?.();
  }

  async function recoverBackendAfterExit(failed: BackendGeneration): Promise<void> {
    if (closing || draining || reloading || rotatingBootstrap ||
        failed !== current || failed.alive) return;
    const now = Date.now();
    pruneAutoRecoveryAttempts(now);
    if (autoRecoveryAttempts.length >= AUTO_RECOVERY_LIMIT_PER_HOUR) {
      record("backend_auto_recovery_blocked", {
        backendPid: failed.pid, code: "MCP_AUTO_RECOVERY_RATE_LIMIT",
      });
      return;
    }
    if (opts.authMode === "oauth" && !oauthPersistent) {
      record("backend_auto_recovery_blocked", {
        backendPid: failed.pid, code: "MCP_AUTO_RECOVERY_OAUTH_NOT_PERSISTENT",
      });
      return;
    }

    reloading = true;
    const started = Date.now();
    try {
      const next = await launch();
      if (opts.authMode === "oauth" && !next.oauthStatePersistent) {
        generations.delete(next);
        try { next.child.kill("SIGTERM"); } catch {}
        throw new Error("MCP_AUTO_RECOVERY_OAUTH_NOT_PERSISTENT");
      }
      failed.retireAt = Date.now() + OLD_GENERATION_TTL;
      current = next;
      reloadCount++;
      lastReloadAt = Date.now();
      lastAutoRecoveryAt = lastReloadAt;
      autoRecoveryAttempts.push(lastReloadAt);
      retireOld();
      updateOwnerState();
      record("backend_auto_recovered", {
        backendPid: next.pid,
        previousBackendPid: failed.pid,
        durationMs: Date.now() - started,
      });
    } catch {
      record("backend_auto_recovery_blocked", {
        backendPid: failed.pid, code: "MCP_AUTO_RECOVERY_FAILED",
        durationMs: Date.now() - started,
      });
    } finally {
      reloading = false;
    }
  }

  async function recoverBackendFromMemoryTrend(gen: BackendGeneration): Promise<void> {
    pruneAutoRecoveryAttempts();
    const decision = decideMcpMemoryRecovery({
      trend: gen.memoryTrend,
      backendCurrent: gen === current,
      backendAlive: gen.alive,
      ownerBusy: closing || draining || reloading || rotatingBootstrap,
      ownerSessions: gen.sessions.size,
      backendSessions: gen.lastHealth?.sessionStats.activeSessions ?? null,
      inFlight: gen.inFlight,
      inFlightToolCalls: gen.lastHealth?.inFlightToolCalls ?? 0,
      oauthPersistent: opts.authMode !== "oauth" || oauthPersistent,
      attemptsLastHour: autoRecoveryAttempts.length,
      maxAttemptsPerHour: AUTO_RECOVERY_LIMIT_PER_HOUR,
    });
    if (!decision.recover) return;

    const started = Date.now();
    const previousPid = gen.pid;
    try {
      const result = await reload();
      const recoveredAt = Date.now();
      autoRecoveryAttempts.push(recoveredAt);
      lastAutoRecoveryAt = recoveredAt;
      lastMemoryRecoveryAt = recoveredAt;
      record("backend_auto_recovered", {
        backendPid: result.pid,
        previousBackendPid: previousPid,
        durationMs: recoveredAt - started,
        code: "MCP_MEMORY_GROWTH",
      });
    } catch {
      record("backend_auto_recovery_blocked", {
        backendPid: previousPid,
        durationMs: Date.now() - started,
        code: "MCP_MEMORY_RECOVERY_FAILED",
      });
    }
  }

  async function launch(entry = activeBackendEntry): Promise<BackendGeneration> {
    const gen = await createReloadWorker(entry, {
      port: opts.port, publicBaseUrl: baseUrl,
      authMode: opts.authMode,
      allowDangerous: opts.allowDangerous,
      bearerToken,
      bootstrapCodeHash: bootCodeHash,
      auditLogPath: opts.auditLogPath,
    });
    gen.child.on("message", message => {
      onBootstrapConsumed(gen, message);
      onBackendSessionClosed(gen, message);
      onBackendHealth(gen, message);
    });
    gen.child.once("exit", () => {
      // Fail closed if this worker dies before delivering a successful
      // one-time-code consumption event. A later backend reload must not
      // resurrect a possibly already-used approval code.
      if (!closing && opts.authMode === "oauth" && gen === current &&
          bootCodeHash !== DISABLED_BOOTSTRAP_HASH) {
        bootCodeHash = DISABLED_BOOTSTRAP_HASH;
        record("bootstrap_invalidated_on_crash", {backendPid:gen.pid});
      }
      scheduleBackendAutoRecovery(gen);
    });
    generations.add(gen);
    return gen;
  }
  async function reload(candidate?: VerifiedMcpBackendRelease, expectedBackendPid?: number): Promise<{success: boolean; pid: number; previousPid: number | null; url: string; releaseDigest: string | null}> {
    if (reloading || closing || draining || rotatingBootstrap) {
      record("backend_reload_failed", {backendPid:current?.pid, code:"MCP_RELOAD_BUSY_OR_DRAINING"});
      throw new Error("MCP_RELOAD_BUSY_OR_DRAINING");
    }
    if (opts.authMode === "oauth" && !oauthPersistent) {
      record("backend_reload_failed", {backendPid:current?.pid, code:"MCP_RELOAD_OAUTH_NOT_PERSISTENT"});
      throw new Error("MCP_RELOAD_OAUTH_NOT_PERSISTENT: refusing to invalidate active OAuth credentials");
    }
    if (!current) {
      record("backend_reload_failed", {code:"MCP_RELOAD_NO_BACKEND"});
      throw new Error("MCP_RELOAD_NO_BACKEND");
    }
    if (candidate && (!Number.isSafeInteger(expectedBackendPid) ||
        current.pid !== expectedBackendPid)) throw new Error("MCP_RELEASE_BACKEND_PID_CHANGED");
    reloading = true;
    const started = Date.now();
    record("backend_reload_started", {backendPid:current.pid});
    try {
      // Stage the next generation before modifying the serving generation.
      const expectedBootstrapHash = bootCodeHash;
      // The release candidate is re-hashed at activation, after the owner
      // serializes mutations, so an old plan cannot select changed bytes.
      const selected = candidate ? verifyMcpBackendRelease(candidate.digest) : null;
      const next = await launch(selected?.entry ?? activeBackendEntry);
      // A successful approval might consume the code while next was starting.
      if (opts.authMode === "oauth" && expectedBootstrapHash !== bootCodeHash) {
        await setBootstrapHash(next, bootCodeHash);
      }
      if (opts.authMode === "oauth" && !next.oauthStatePersistent) {
        generations.delete(next);
        try { next.child.kill("SIGTERM"); } catch {}
        throw new Error("MCP_RELOAD_NEW_BACKEND_OAUTH_NOT_PERSISTENT");
      }
      const previous = current;
      if (!previous.alive) {
        // A crashed generation cannot serve its old sessions.
        for (const id of [...previous.sessions]) forgetSession(id, previous);
      }
      previous.retireAt = Date.now() + OLD_GENERATION_TTL;
      current = next;
      if (selected) {
        activeBackendEntry = selected.entry;
        activeReleaseDigest = selected.digest;
      }
      reloadCount++;
      lastReloadAt = Date.now();
      retireOld();
      updateOwnerState();
      record("backend_reload_succeeded", {
        backendPid:next.pid, previousBackendPid:previous.pid,
        durationMs:Date.now()-started,
      });
      return { success: true, pid: next.pid, previousPid: previous.pid,
        url: baseUrl + "/mcp", releaseDigest: activeReleaseDigest };
    } catch (error) {
      const match = error instanceof Error ? error.message.match(/^MCP_[A-Z0-9_]+/) : null;
      record("backend_reload_failed", {
        backendPid:current?.pid, durationMs:Date.now()-started,
        code:match?.[0] || "MCP_BACKEND_RELOAD_FAILED",
      });
      throw error;
    } finally {
      reloading = false;
    }
  }
  function activeSessionCount(): number {
    return sessions.size;
  }
  function status() {
    const now = Date.now();
    pruneAutoRecoveryAttempts(now);
    const currentHealth = current?.lastHealth ?? null;
    const currentStats = currentHealth?.sessionStats ?? null;
    const backendActiveSessions = [...generations].reduce(
      (sum, gen) => sum + (gen.lastHealth?.sessionStats.activeSessions ?? 0), 0,
    );
    const trend = current?.memoryTrend ?? assessMemoryTrend([]);
    return {
      version: 1, kind: "private_mcp_owner", pid: process.pid,
      port: opts.port, startedAt: opts.createdAt, mode: "managed-tunnel",
      activeSessions: activeSessionCount(), inFlightRequests: requestCount(),
      activeSseStreams, nonStreamInFlightRequests: Math.max(0, requestCount() - activeSseStreams),
      inFlightToolCalls: currentHealth?.inFlightToolCalls ?? 0,
      draining, inflightToolEffects: "unknown",
      safeToolsOnly: !opts.allowDangerous, oauthEnabled: opts.authMode === "oauth",
      publicTunnelStarted: publicTunnelOwned,
      backendPid: current?.pid ?? null, backendGenerations: generations.size,
      backendHealthy: current?.alive === true,
      backendGenerationDetails: [...generations].map(gen => ({
        pid: gen.pid,
        current: gen === current,
        alive: gen.alive,
        sessions: gen.sessions.size,
        backendSessions: gen.lastHealth?.sessionStats.activeSessions ?? null,
        inFlight: gen.inFlight,
        inFlightToolCalls: gen.lastHealth?.inFlightToolCalls ?? null,
        retireAt: gen.retireAt,
        rssBytes: gen.lastHealth?.rssBytes ?? null,
        heapUsedBytes: gen.lastHealth?.heapUsedBytes ?? null,
        healthAgeMs: gen.lastHealth ? Math.max(0, now - gen.lastHealth.timestamp) : null,
        memoryTrendSuspicious: gen.memoryTrend.suspicious,
      })),
      sessionTelemetry: {
        backendActiveSessions: currentStats?.activeSessions ?? null,
        activePrincipals: currentStats?.activePrincipals ?? null,
        largestPrincipalSessionCount: currentStats?.largestPrincipalSessionCount ?? null,
        oldestSessionAgeMs: currentStats?.oldestSessionAgeMs ?? null,
        oldestIdleMs: currentStats?.oldestIdleMs ?? null,
        rejectedTotal: currentStats
          ? currentStats.rejectedGlobal + currentStats.rejectedPrincipal : null,
        affinityDrift: currentStats
          ? Math.max(0, activeSessionCount() - backendActiveSessions) : null,
        staleAffinityReclaimed,
      },
      memoryTelemetry: {
        rssBytes: currentHealth?.rssBytes ?? null,
        heapUsedBytes: currentHealth?.heapUsedBytes ?? null,
        externalBytes: currentHealth?.externalBytes ?? null,
        arrayBuffersBytes: currentHealth?.arrayBuffersBytes ?? null,
        healthAgeMs: currentHealth ? Math.max(0, now - currentHealth.timestamp) : null,
        trend: {
          suspicious: trend.suspicious,
          sampleCount: trend.sampleCount,
          windowMs: trend.windowMs,
          rssGrowthBytes: trend.rssGrowthBytes,
          heapGrowthBytes: trend.heapGrowthBytes,
          rssSlopeBytesPerMinute: trend.rssSlopeBytesPerMinute,
          heapSlopeBytesPerMinute: trend.heapSlopeBytesPerMinute,
          reasons: trend.reasons,
        },
      },
      autoRecovery: {
        enabled: true,
        maxPerHour: AUTO_RECOVERY_LIMIT_PER_HOUR,
        attemptsLastHour: autoRecoveryAttempts.length,
        lastRecoveredAt: lastAutoRecoveryAt ?? null,
        lastMemoryRecoveredAt: lastMemoryRecoveryAt ?? null,
      },
      reloadable: true, publicUrl: baseUrl ? baseUrl + "/mcp" : "",
      backendGeneration:reloadCount + 1, lastReloadAt:lastReloadAt ?? null,
      backendReleaseDigest:activeReleaseDigest,
    };
  }

  const proxy = http.createServer((req, res) => {
    const url = req.url || "/";
    let pathname: string;
    try { pathname = new URL(url, "http://127.0.0.1").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname.startsWith("/_internal/owner/")) {
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "");
      const host = String(req.headers.host || "").toLowerCase();
      const expected = host === "127.0.0.1:" + opts.port || host === "localhost:" + opts.port;
      if (!local || !expected) { res.writeHead(404); res.end(); return; }
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      if (!bearerMatches(token, opts.nonce)) { res.writeHead(401); res.end(); return; }
      if (pathname === "/_internal/owner/status" && req.method === "GET") {
        res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
        res.end(JSON.stringify(status())); return;
      }
      if (pathname === "/_internal/owner/drain" && req.method === "POST") {
        draining = true;
        res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
        res.end(JSON.stringify(status())); return;
      }
      if (pathname === "/_internal/owner/bootstrap/rotate" && req.method === "POST") {
        // The owner control lease is only accepted on loopback. This is an
        // explicit privileged operator action: never auto-rotate on failure.
        void rotateBootstrap().then(out => {
          res.writeHead(200, {
            "Content-Type":"application/json", "Cache-Control":"no-store",
            "Pragma":"no-cache", "Referrer-Policy":"no-referrer",
          });
          res.end(JSON.stringify(out)); // only time plaintext is returned
        }).catch(error => {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({
            error:error instanceof Error ? error.message : "MCP_BOOTSTRAP_ROTATION_FAILED",
          }));
        }); return;
      }
      if (pathname === "/_internal/owner/reload" && req.method === "POST") {
        void reload().then(out => {
          res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify(out));
        }).catch(error => {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({error: error instanceof Error ? error.message : "MCP_RELOAD_FAILED"}));
        }); return;
      }
      // Strict private control plane: never expose release file paths or
      // operator-controlled upgrade switches on /mcp or public OAuth routes.
      if (pathname === "/_internal/owner/backend/plan" && req.method === "GET") {
        try {
          const digest = new URL(url, "http://127.0.0.1").searchParams.get("digest") || "";
          const candidate = verifyMcpBackendRelease(digest);
          if (!current?.alive || reloading || draining || closing || rotatingBootstrap)
            throw new Error("MCP_RELEASE_OWNER_NOT_READY");
          res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({ready:true, digest:candidate.digest, fileCount:candidate.fileCount,
            ownerPid:process.pid, expectedBackendPid:current.pid, publicUrl:baseUrl + "/mcp",
            noTunnelRestart:true, noImplicitReplay:true}));
        } catch (error) {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({error:error instanceof Error ? error.message : "MCP_RELEASE_PLAN_FAILED"}));
        }
        return;
      }
      if (pathname === "/_internal/owner/backend/activate" && req.method === "POST") {
        const p = new URL(url, "http://127.0.0.1").searchParams;
        const digest = p.get("digest") || "";
        const expectedBackendPid = Number(p.get("expectedBackendPid"));
        const expectedPublicUrl = p.get("expectedPublicUrl");
        if (!Number.isSafeInteger(expectedBackendPid) || expectedBackendPid <= 0 ||
            expectedPublicUrl !== baseUrl + "/mcp" || p.get("reviewed") !== "1") {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({error:"MCP_RELEASE_REVIEW_OR_IDENTITY_REQUIRED"})); return;
        }
        try {
          const candidate = verifyMcpBackendRelease(digest);
          void reload(candidate, expectedBackendPid).then(out => {
            res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
            res.end(JSON.stringify(out));
          }).catch(error => {
            res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
            res.end(JSON.stringify({error:error instanceof Error ? error.message : "MCP_RELEASE_ACTIVATE_FAILED"}));
          });
        } catch (error) {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({error:error instanceof Error ? error.message : "MCP_RELEASE_UNVERIFIED"}));
        }
        return;
      }
      if (pathname === "/_internal/owner/stop" && req.method === "POST") {
        const force = new URL(url,"http://127.0.0.1").searchParams.get("force") === "1";
        if (!force && (!draining || activeSessionCount() > 0 || requestCount() > 0)) {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({error:"MCP_OWNER_NOT_DRAINED", ...status()})); return;
        }
        res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
        res.end(JSON.stringify(status()));
        setImmediate(() => { void close().then(() => process.exit(0)); });
        return;
      }
      res.writeHead(404); res.end(); return;
    }
    if (draining || closing) {
      res.writeHead(503, {"Cache-Control":"no-store"});
      res.end(JSON.stringify({error:"MCP owner draining"})); return;
    }
    if (!isPermittedMcpIngressPath(req.method || "", url)) {
      res.writeHead(404, {"Cache-Control":"no-store"});
      res.end(); return;
    }
    const sid = req.headers["mcp-session-id"];
    const sessionId = typeof sid === "string" ? sid : "";
    // OAuth pairing never goes to a retired generation, even when the
    // request presents an MCP session ID from that old generation.
    const oauthPairingRoute = pathname === "/oauth/authorize";
    const target = (!oauthPairingRoute && sessionId && sessions.get(sessionId)) || current;
    if (!target?.alive) {
      res.writeHead(503, {"Cache-Control":"no-store"});
      res.end(JSON.stringify({error:"MCP backend unavailable"})); return;
    }
    target.inFlight++;
    const trackedSession = sessionId && sessions.get(sessionId) === target ? sessionId : "";
    if (trackedSession) sessionInFlight.set(trackedSession, (sessionInFlight.get(trackedSession) ?? 0) + 1);
    let counted = true;
    let sseStream = false;
    const finish = () => {
      if (!counted) return;
      counted = false;
      target.inFlight--;
      if (sseStream) activeSseStreams = Math.max(0, activeSseStreams - 1);
      if (trackedSession) {
        const remaining = (sessionInFlight.get(trackedSession) ?? 1) - 1;
        if (remaining > 0) sessionInFlight.set(trackedSession, remaining);
        else sessionInFlight.delete(trackedSession);
      }
      retireOld();
    };
    res.once("close", finish);
    res.once("finish", finish);
    const upstream = http.request({
      hostname: "127.0.0.1", port: target.port, path: url,
      method: req.method, headers: sanitizedMcpIngressHeaders(req.headers, target.port),
    }, (reply) => {
      const contentType = String(reply.headers["content-type"] ?? "");
      if (/^text\/event-stream(?:;|$)/i.test(contentType)) {
        sseStream = true;
        activeSseStreams++;
      }
      const newSid = reply.headers["mcp-session-id"];
      if (typeof newSid === "string" && newSid) {
        rememberSession(newSid, target);
      }
      if (pathname === "/mcp" && req.method === "DELETE" && sessionId &&
          (reply.statusCode === 200 || reply.statusCode === 404)) {
        forgetSession(sessionId, target);
      } else if (pathname === "/mcp" && reply.statusCode === 404 && sessionId) {
        // Preserve backend 404 for explicit client initialization, never replay calls.
        if (forgetSession(sessionId, target)) staleAffinityReclaimed++;
      }
      // Never forward backend-supplied transfer framing headers explicitly.
      const headers = { ...reply.headers };
      delete headers.connection;
      delete headers["transfer-encoding"];
      res.writeHead(reply.statusCode || 502, headers);
      reply.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.destroyed) {
        if (!res.headersSent) res.writeHead(502, {"Cache-Control":"no-store"});
        res.end();
      }
      finish();
    });
    req.once("aborted", () => upstream.destroy());
    // SSE can outlive the request body. Release the upstream socket when the
    // downstream client disappears, without replaying any tool side effect.
    res.once("close", () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    record("owner_stopping", {backendPid:current?.pid});
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    if (publicTunnelOwned) await stopQuickTunnel(opts.port, "mcp-http").catch(() => {});
    for (const gen of generations) {
      try { gen.child.kill("SIGTERM"); } catch {}
    }
    generations.clear();
    sessions.clear();
    try {
      const file = getMcpStateFile(opts.port);
      const info = JSON.parse(fs.readFileSync(file, "utf8"));
      if (info.pid === process.pid && info.port === opts.port) {
        fs.rmSync(file, {force:true});
      }
    } catch {}
    await new Promise<void>(resolve => {
      proxy.close(() => resolve());
      // Only during explicit shutdown: do not disturb connections on reload.
      proxy.closeAllConnections?.();
    });
  };

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(opts.port, "127.0.0.1", resolve);
  });
  try {
    const tunnel = await startQuickTunnel({
      port: opts.port, host: "127.0.0.1", path: "", serviceKind: "mcp-http",
    });
    publicTunnelOwned = true;
    if (!tunnel.publicUrl || !/^https:\/\/[^/]+$/.test(tunnel.publicUrl.replace(/\/$/, ""))) {
      throw new Error("MCP Quick Tunnel returned an invalid public HTTPS URL");
    }
    baseUrl = tunnel.publicUrl.replace(/\/$/, "");
    current = await launch();
    oauthPersistent = current.oauthStatePersistent;
    cleanupTimer = setInterval(retireOld, 60_000);
    cleanupTimer.unref?.();

    const startedAt = opts.createdAt;
    fs.writeFileSync(getMcpStateFile(opts.port), JSON.stringify({
      port: opts.port, pid: process.pid,
      publicUrl: baseUrl + "/mcp", localUrl: "http://127.0.0.1:" + opts.port + "/mcp",
      startedAt, workspace: process.cwd(),
      toolMode: opts.allowDangerous ? "dangerous" : "safe",
      authMode: opts.authMode, tunnelProvider: "cloudflare",
      oauthStatePersistent: oauthPersistent,
    }, null, 2) + "\n", { mode: 0o600 });

    updateOwnerState();
    record("owner_started", {backendPid:current.pid});

    const info: McpTunnelInfo = {
      publicUrl: baseUrl + "/mcp",
      localUrl: "http://127.0.0.1:" + opts.port + "/mcp",
      bearerToken: opts.authMode === "oauth" ? "" : bearerToken,
      dangerous: opts.allowDangerous,
      toolCount: opts.allowDangerous
        ? MCP_TOOL_DEFINITIONS.filter(t=>!DISABLED_MCP_TOOLS.has(t.name)).length
        : getDefaultSafeTools().length,
      authMode: opts.authMode,
      auditLogPath: opts.auditLogPath || "default",
      bootstrapCode: opts.authMode === "oauth" ? initialBoot : undefined,
      oauthDiscoveryUrl: opts.authMode === "oauth" ? baseUrl + "/.well-known/oauth-authorization-server" : undefined,
      tunnelProvider: "cloudflare",
      oauthStatePersistent: oauthPersistent,
    };
    // Do not retain the plaintext bootstrap code in the owner.
    initialBoot = "";
    return { info, close };
  } catch (error) {
    await close();
    throw error;
  }
}
