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
import type {
  ReloadableBackendOptions, BackendWorkerReply,
} from "./mcpReloadableBackend.js";
import { MCP_TOOL_DEFINITIONS, DISABLED_MCP_TOOLS } from "../mcp/superagentMcpServer.js";

const WORKER_START_MS = 30_000;
const OLD_GENERATION_TTL = 4 * 60 * 60_000 + 5 * 60_000;
export interface ReloadableOwnerOptions {
  port: number;
  nonce: string;
  createdAt: number;
  cliEntry: string;
  authMode: "oauth" | "static-bearer";
  allowDangerous: boolean;
  auditLogPath?: string;
}

interface BackendGeneration {
  child: ChildProcess;
  pid: number;
  port: number;
  sessions: Set<string>;
  inFlight: number;
  retireAt: number | null;
  alive: boolean;
  oauthStatePersistent: boolean;
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
      if (m?.type === "mcp-reload-worker-ready" && Number.isSafeInteger(m.port) &&
          m.port > 0 && m.port <= 65535) {
        const ready: BackendGeneration = {
          child, pid: child.pid!, port: m.port,
          sessions: new Set(), inFlight: 0, retireAt: null, alive: true,
          oauthStatePersistent: m.oauthStatePersistent === true,
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
  const generations = new Set<BackendGeneration>();
  const sessions = new Map<string, BackendGeneration>();
  let draining = false;
  let closing = false;
  let reloading = false;
  let baseUrl = "";
  let oauthPersistent = true;
  let bearerToken = generateMcpBearerToken();
  const bootCode = generateBootstrapCode();
  const bootCodeHash = bootCode.codeHash;
  let initialBoot = bootCode.code;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let publicTunnelOwned = false;

  function requestCount(): number {
    return [...generations].reduce((total, gen) => total + gen.inFlight, 0);
  }
  function retireOld(): void {
    for (const gen of generations) {
      if (gen === current || gen.retireAt === null) continue;
      if (gen.sessions.size === 0 && gen.inFlight === 0 ||
          Date.now() >= gen.retireAt && gen.inFlight === 0) {
        for (const id of gen.sessions) sessions.delete(id);
        gen.sessions.clear();
        generations.delete(gen);
        try { gen.child.kill("SIGTERM"); } catch {}
      }
    }
  }
  async function launch(): Promise<BackendGeneration> {
    const gen = await createReloadWorker(opts.cliEntry, {
      port: opts.port, publicBaseUrl: baseUrl,
      authMode: opts.authMode,
      allowDangerous: opts.allowDangerous,
      bearerToken,
      bootstrapCodeHash: bootCodeHash,
      auditLogPath: opts.auditLogPath,
    });
    generations.add(gen);
    return gen;
  }
  async function reload(): Promise<{success: boolean; pid: number; previousPid: number | null; url: string}> {
    if (reloading || closing || draining) throw new Error("MCP_RELOAD_BUSY_OR_DRAINING");
    if (opts.authMode === "oauth" && !oauthPersistent) {
      throw new Error("MCP_RELOAD_OAUTH_NOT_PERSISTENT: refusing to invalidate active OAuth credentials");
    }
    if (!current) throw new Error("MCP_RELOAD_NO_BACKEND");
    reloading = true;
    try {
      // Stage the next generation before modifying the serving generation.
      const next = await launch();
      if (opts.authMode === "oauth" && !next.oauthStatePersistent) {
        generations.delete(next);
        try { next.child.kill("SIGTERM"); } catch {}
        throw new Error("MCP_RELOAD_NEW_BACKEND_OAUTH_NOT_PERSISTENT");
      }
      const previous = current;
      if (!previous.alive) {
        // A crashed generation cannot serve its old sessions.
        for (const id of previous.sessions) sessions.delete(id);
        previous.sessions.clear();
      }
      previous.retireAt = Date.now() + OLD_GENERATION_TTL;
      current = next;
      retireOld();
      return { success: true, pid: next.pid, previousPid: previous.pid,
        url: baseUrl + "/mcp" };
    } finally {
      reloading = false;
    }
  }
  function activeSessionCount(): number {
    return sessions.size;
  }
  function status() {
    return {
      version: 1, kind: "private_mcp_owner", pid: process.pid,
      port: opts.port, startedAt: opts.createdAt, mode: "managed-tunnel",
      activeSessions: activeSessionCount(), inFlightRequests: requestCount(),
      draining, inflightToolEffects: "unknown",
      safeToolsOnly: !opts.allowDangerous, oauthEnabled: opts.authMode === "oauth",
      publicTunnelStarted: publicTunnelOwned,
      backendPid: current?.pid ?? null, backendGenerations: generations.size,
      reloadable: true, publicUrl: baseUrl ? baseUrl + "/mcp" : "",
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
      if (pathname === "/_internal/owner/reload" && req.method === "POST") {
        void reload().then(out => {
          res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify(out));
        }).catch(error => {
          res.writeHead(409, {"Content-Type":"application/json", "Cache-Control":"no-store"});
          res.end(JSON.stringify({error: error instanceof Error ? error.message : "MCP_RELOAD_FAILED"}));
        }); return;
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
    const target = (sessionId && sessions.get(sessionId)) || current;
    if (!target?.alive) {
      res.writeHead(503, {"Cache-Control":"no-store"});
      res.end(JSON.stringify({error:"MCP backend unavailable"})); return;
    }
    target.inFlight++;
    let counted = true;
    const finish = () => {
      if (!counted) return;
      counted = false; target.inFlight--; retireOld();
    };
    res.once("close", finish);
    res.once("finish", finish);
    const upstream = http.request({
      hostname: "127.0.0.1", port: target.port, path: url,
      method: req.method, headers: sanitizedMcpIngressHeaders(req.headers, target.port),
    }, (reply) => {
      const newSid = reply.headers["mcp-session-id"];
      if (typeof newSid === "string" && newSid) {
        sessions.set(newSid, target);
        target.sessions.add(newSid);
      }
      if (req.method === "DELETE" && sessionId) {
        target.sessions.delete(sessionId);
        sessions.delete(sessionId);
      }
      // Never forward backend-supplied transfer framing headers explicitly.
      const headers = { ...reply.headers };
      delete headers.connection;
      delete headers["transfer-encoding"];
      res.writeHead(reply.statusCode || 502, headers);
      reply.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, {"Cache-Control":"no-store"});
      res.end(); finish();
    });
    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
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
