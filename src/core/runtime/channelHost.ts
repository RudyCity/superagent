/**
 * Phase 4b: opt-in independent Muse/Telegram channel owner.
 * This process NEVER owns/restores MCP OAuth tunnels or T-Line/core listeners.
 * It has no unauthenticated mutation API; startup mode is explicit and
 * non-idle modes require configuration preflight before any network I/O.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadRemoteAgentConfig, getWatchedWorkspaces } from "../remoteAgent/config.js";
import type { RemoteAgentConfig } from "../remoteAgent/config.js";
import { getMuseWatcher, TELEGRAM_FALLBACK_KEY } from "../remoteAgent/museWatcherRegistry.js";
import { MuseBatchJournal } from "../remoteAgent/museBatchJournal.js";

export type ChannelHostMode = "idle" | "muse-ws" | "telegram-fallback";
export interface ChannelHostHealth {
  service: "superagent-channel-host";
  instanceId: string;
  pid: number;
  port: number;
  mode: ChannelHostMode;
  status: "idle" | "starting" | "running" | "error";
  watcherActive: boolean;
  taskActive: boolean;
  tasksCompleted: number;
  startedAt: number;
  /** Aggregate non-delivered batches; excludes contents and IDs. */
  reconciliationPending?: number;
  /** Never include credentials, workspace paths, group IDs, URLs or prompts. */
  errorCode?: "START_FAILED";
}
interface ChannelHostDiscovery { version: 1; instanceId: string; pid: number; port: number; ipcToken: string }
export type ChannelHostIpcOperation = "steer" | "task" | "abort";
export interface ChannelHostIpcRequest {
  operation: ChannelHostIpcOperation;
  requestId: string;
  text: string;
}
export interface ChannelHostIpcResult { ok: boolean; requestId: string; code: "OK" | "NOT_READY" | "REJECTED" }

const dir = () => path.join(os.homedir(), ".superagent-r");
const statePath = (port: number) => path.join(dir(), "channel-host-" + port + ".json");
const leasePath = (mode: ChannelHostMode) => path.join(dir(), "channel-host-lease-" + mode + ".json");
const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

export function validateChannelHostMode(mode: string, wsPort: number, config: RemoteAgentConfig): ChannelHostMode {
  if (!validPort(wsPort)) throw new Error("Invalid Muse WebSocket port");
  if (mode === "idle") return mode;
  if (mode === "muse-ws") {
    if (!config.wsToken || config.wsToken.length < 16) throw new Error("Configure Muse WebSocket token first");
    if (config.wsMode === "client") throw new Error("Channel host only supports local Muse WebSocket server mode");
    return mode;
  }
  if (mode === "telegram-fallback") {
    if (!config.botToken || !config.groupId || !config.museBotId) {
      throw new Error("Configure Telegram bot token, group and Muse bot ID before starting");
    }
    return mode;
  }
  throw new Error("Unsupported channel-host mode");
}

function readDiscovery(port: number): ChannelHostDiscovery {
  const stat = fs.lstatSync(statePath(port));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("Invalid channel host discovery file");
  const item = JSON.parse(fs.readFileSync(statePath(port), "utf8")) as ChannelHostDiscovery;
  if (item.version !== 1 || item.port !== port || !validPort(port) ||
      !Number.isSafeInteger(item.pid) || item.pid < 1 ||
      typeof item.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(item.instanceId) ||
      typeof item.ipcToken !== "string" || !/^[a-f0-9]{64}$/.test(item.ipcToken)) {
    throw new Error("Invalid channel host discovery");
  }
  return item;
}

async function probeHost(port: number): Promise<ChannelHostHealth> {
  const response = await fetch("http://127.0.0.1:" + port + "/_channel/health", {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error("Channel host unavailable");
  const status = await response.json() as ChannelHostHealth;
  if (status.service !== "superagent-channel-host" || status.port !== port) {
    throw new Error("Unrecognized channel-host process");
  }
  return status;
}

function claimModeLease(mode: ChannelHostMode, record: ChannelHostDiscovery): () => void {
  if (mode === "idle") return () => {};
  fs.mkdirSync(dir(), { recursive: true });
  const file = leasePath(mode);
  // Exclusive create: competing hosts must never poll one Telegram bot or
  // bind the same Muse socket even when their control ports differ.
  const { ipcToken: _secret, ...leaseRecord } = record;
  fs.writeFileSync(file, JSON.stringify(leaseRecord), { flag: "wx", mode: 0o600 });
  return () => {
    try {
      const contents = JSON.parse(fs.readFileSync(file, "utf8")) as ChannelHostDiscovery;
      if (contents.pid === record.pid && contents.instanceId === record.instanceId) {
        fs.rmSync(file, { force: true });
      }
    } catch {}
  };
}

function writeDiscovery(record: ChannelHostDiscovery) {
  fs.mkdirSync(dir(), { recursive: true });
  const file = statePath(record.port);
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

/** Cross-process read-only discovery. Never trust PID records without a live
 * loopback identity match; never expose private config or start channels. */
export async function listVerifiedChannelHosts(): Promise<ChannelHostHealth[]> {
  let names: string[];
  try { names = fs.readdirSync(dir()); } catch { return []; }
  const candidates = names.filter(name => /^channel-host-([1-9]\d{0,4})\.json$/.test(name)).slice(0, 16);
  const results = await Promise.all(candidates.map(async name => {
    const port = Number(name.match(/^channel-host-(\d+)\.json$/)?.[1]);
    if (!validPort(port)) return null;
    try {
      const known = readDiscovery(port);
      const live = await probeHost(port);
      if (known.pid !== live.pid || known.instanceId !== live.instanceId ||
          !["idle", "muse-ws", "telegram-fallback"].includes(live.mode) ||
          !["idle", "starting", "running", "error"].includes(live.status)) return null;
      return live;
    } catch { return null; }
  }));
  return results.filter((item): item is ChannelHostHealth => Boolean(item));
}

export function validateChannelIpcCommand(raw: unknown): ChannelHostIpcRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid IPC payload");
  const value = raw as Partial<ChannelHostIpcRequest>;
  if (!["steer", "task", "abort"].includes(value.operation || "") ||
      typeof value.requestId !== "string" || !/^[a-f0-9]{32}$/.test(value.requestId) ||
      typeof value.text !== "string" || value.text.length > 4096 ||
      value.text.includes("\0") || (value.operation !== "abort" && !value.text.trim())) {
    throw new Error("Invalid IPC command");
  }
  return value as ChannelHostIpcRequest;
}

/** Core/TUI-facing client, intentionally opt-in: no automatic legacy watcher fallback. */
export async function requestChannelHostIpc(
  port: number, operation: ChannelHostIpcOperation, text = "",
  requestId = crypto.randomBytes(16).toString("hex"),
): Promise<ChannelHostIpcResult> {
  const command = validateChannelIpcCommand({ operation, text, requestId });
  const discovery = readDiscovery(port);
  const health = await probeHost(port);
  if (health.pid !== discovery.pid || health.instanceId !== discovery.instanceId ||
      health.status !== "running" || !health.watcherActive) {
    throw new Error("Verified remote channel watcher is not active; no IPC sent");
  }
  const response = await fetch("http://127.0.0.1:" + port + "/_channel/ipc", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + discovery.ipcToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(6500),
  });
  const result = await response.json() as ChannelHostIpcResult;
  if (!result || result.requestId !== requestId || typeof result.ok !== "boolean" ||
      !["OK", "NOT_READY", "REJECTED"].includes(result.code)) {
    throw new Error("Invalid IPC response from channel host");
  }
  if (response.status !== 200 || !result.ok) throw new Error("Channel IPC refused: " + result.code);
  return result;
}

export async function runChannelHost(options: {
  port: number;
  mode: ChannelHostMode;
  wsPort: number;
  /** Test injections: never exposed through CLI. */
  startWatcher?: (mode: ChannelHostMode, wsPort: number) => Promise<void>;
  config?: RemoteAgentConfig;
  executeIpc?: (command: ChannelHostIpcRequest) => Promise<boolean>;
}): Promise<{ server: http.Server; health: () => ChannelHostHealth }> {
  const { port, mode, wsPort } = options;
  if (!validPort(port) || !validPort(wsPort) || port === wsPort || port === 7888) {
    throw new Error("Invalid or conflicting channel-host port");
  }
  const config = options.config || loadRemoteAgentConfig();
  validateChannelHostMode(mode, wsPort, config);
  // Fail closed on invalid/tampered journal before watcher/socket startup.
  const journal = mode !== "idle" ? new MuseBatchJournal(port) : null;
  // Fail closed on ANY existing registration, including stale metadata.
  // Never overwrite a PID record or adopt unrelated listener processes.
  if (fs.existsSync(statePath(port))) {
    throw new Error("Channel-host registration already exists; verify the owner before manual cleanup");
  }
  const instanceId = crypto.randomBytes(16).toString("hex");
  const startedAt = Date.now();
  const record: ChannelHostDiscovery = {
    version: 1, instanceId, ipcToken: crypto.randomBytes(32).toString("hex"),
    pid: process.pid, port,
  };
  const processed = new Map<string, { signature: string; result: Promise<boolean>; at: number }>();
  let executingId: string | null = null;
  let releaseLease: () => void = () => {};
  let state: ChannelHostHealth["status"] = mode === "idle" ? "idle" : "starting";
  let errorCode: ChannelHostHealth["errorCode"];
  const health = (): ChannelHostHealth => {
    const watcher = mode === "telegram-fallback"
      ? getMuseWatcher(TELEGRAM_FALLBACK_KEY)
      : mode === "muse-ws" ? getMuseWatcher(wsPort) : null;
    const stats = watcher?.getStats();
    return {
      service: "superagent-channel-host", instanceId, pid: process.pid, port,
      mode, status: state, watcherActive: Boolean(options.executeIpc || watcher?.isActive()),
      taskActive: Boolean(stats?.activeTaskId || (stats?.queuedBatches ?? 0) > 0),
      tasksCompleted: stats?.tasksCompleted || 0, startedAt,
      reconciliationPending: journal?.summary().requiresReconciliation || 0,
      ...(errorCode ? { errorCode } : {}),
    };
  };
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const loopback = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
    const json = (statusCode: number, value: unknown) => {
      res.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (!loopback) { res.writeHead(404); res.end(); return; }
    if (req.method === "GET" && pathname === "/_channel/health") {
      json(200, health());
      return;
    }
    if (req.method !== "POST" || pathname !== "/_channel/ipc") {
      res.writeHead(404); res.end(); return;
    }
    const bearer = req.headers.authorization || "";
    const wanted = "Bearer " + record.ipcToken;
    const given = Buffer.from(bearer);
    const expected = Buffer.from(wanted);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      json(401, { error: "Unauthorized channel IPC" });
      req.resume();
      return;
    }
    req.setTimeout(7000, () => req.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += (chunk as Buffer).length;
        if (bytes > 8192) { json(413, { error: "Payload too large" }); return; }
        chunks.push(chunk as Buffer);
      }
      const command = validateChannelIpcCommand(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (state !== "running" || mode === "idle") {
        json(409, { ok: false, code: "NOT_READY", requestId: command.requestId });
        return;
      }
      const watcher = mode === "muse-ws" ? getMuseWatcher(wsPort) : getMuseWatcher(TELEGRAM_FALLBACK_KEY);
      if (!options.executeIpc && !watcher?.isActive()) {
        json(409, { ok: false, code: "NOT_READY", requestId: command.requestId });
        return;
      }
      // Same requestId with different contents is rejected, including while
      // the first operation is still pending. A retry never repeats delivery.
      const signature = crypto.createHash("sha256")
        .update(command.operation + "\0" + command.text).digest("hex");
      const current = Date.now();
      for (const [id, entry] of processed) {
        if (current - entry.at > 600_000) processed.delete(id);
      }
      const existing = processed.get(command.requestId);
      if (existing && existing.signature !== signature) {
        json(409, { ok: false, code: "REJECTED", requestId: command.requestId });
        return;
      }
      if (!existing && (processed.size >= 256 || executingId !== null)) {
        json(503, { ok: false, code: "REJECTED", requestId: command.requestId });
        return;
      }
      const operation = async (): Promise<boolean> => {
        if (options.executeIpc) return options.executeIpc(command);
        if (!watcher) return false;
        if (command.operation === "steer") return watcher.sendSteeringMessage(command.text);
        if (command.operation === "task") return watcher.sendTaskRequest(command.text);
        return watcher.abortActiveBatch(command.text || "Cancelled through authenticated channel IPC");
      };
      if (!existing) executingId = command.requestId;
      const result = existing?.result || Promise.resolve().then(operation).catch(() => false).finally(() => {
        if (executingId === command.requestId) executingId = null;
      });
      if (!existing) processed.set(command.requestId, { signature, result, at: current });
      const ok = await result;
      json(ok ? 200 : 409, {
        ok, code: ok ? "OK" : "REJECTED", requestId: command.requestId,
      } satisfies ChannelHostIpcResult);
    } catch {
      if (!res.headersSent) json(400, { error: "Invalid IPC request" });
    }
  });
  // Claim mode ownership before any listener/network side effects.
  releaseLease = claimModeLease(mode, record);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    writeDiscovery(record);
  } catch (error) {
    releaseLease();
    try { server.close(); } catch {}
    throw error;
  }
  const cleanup = () => {
    try {
      const old = readDiscovery(port);
      if (old.pid === process.pid && old.instanceId === instanceId) fs.rmSync(statePath(port), { force: true });
    } catch {}
    releaseLease();
  };
  server.once("close", cleanup);
  process.once("exit", cleanup);
  if (mode !== "idle") {
    // Do not block the health listener while transport connection is pending.
    void (async () => {
      try {
        const starter = options.startWatcher || (async (selected: ChannelHostMode, selectedPort: number) => {
          const { startMuseWatcher } = await import("../remoteAgent/museWatcherRegistry.js");
          const watched = getWatchedWorkspaces(config);
          if (selected === "muse-ws") {
            await startMuseWatcher({ workspace: watched[0] || process.cwd(), workspaces: watched,
              transportType: "websocket", wsPort: selectedPort, tunnel: false,
              batchJournal: journal || undefined });
          } else {
            await startMuseWatcher({ workspace: watched[0] || process.cwd(), workspaces: watched,
              transportType: "telegram", fallback: true, tunnel: false,
              batchJournal: journal || undefined });
          }
        });
        await starter(mode, wsPort);
        state = "running";
      } catch {
        state = "error";
        errorCode = "START_FAILED";
      }
    })();
  }
  return { server, health };
}

export async function handleChannelHostCliCommand(argv: string[]): Promise<boolean> {
  const action = argv[0]?.toLowerCase() || "help";
  if (action === "help" || action === "--help") {
    console.log("superagent channel-host serve --port 7892 [--mode idle|muse-ws|telegram-fallback] [--ws-port 9225]");
    console.log("superagent channel-host status --port 7892");
    console.log("superagent channel-host checkpoint --port 7892  # inspect unconfirmed batches offline");
    console.log("Opt-in independent Muse/Telegram owner. No external channel starts in idle mode. Never owns MCP tunnels.");
    return false;
  }
  const portIdx = argv.indexOf("--port");
  const port = portIdx < 0 ? 7892 : Number(argv[portIdx + 1]);
  const wsIdx = argv.indexOf("--ws-port");
  const wsPort = wsIdx < 0 ? 9225 : Number(argv[wsIdx + 1]);
  const modeIdx = argv.indexOf("--mode");
  const mode = modeIdx < 0 ? "idle" : argv[modeIdx + 1];
  if (!validPort(port)) throw new Error("Invalid --port");
  if (action === "checkpoint") {
    // Offline inspection is intentional: operator needs this AFTER a hard
    // channel-host crash. Never loads tools or starts a watcher.
    const journal = new MuseBatchJournal(port);
    const counts = journal.summary();
    console.log("Muse batch checkpoint on owner port " + port);
    console.log("Delivered: " + counts.delivered + " | Needs reconciliation: " +
      counts.requiresReconciliation + " (started " + counts.started +
      ", result pending " + counts.resultPending + ", uncertain " + counts.uncertain + ")");
    for (const batch of journal.list().filter(record => record.stage !== "delivered")) {
      console.log("  " + JSON.stringify({
        batchId: batch.batchId, taskId: batch.taskId,
        stage: batch.stage, recordedAt: batch.recordedAt,
      }));
    }
    console.log("No automatic replay. Reconcile external effects before any manual intervention.");
    return false;
  }
  if (action === "status") {
    const known = readDiscovery(port);
    const live = await probeHost(port);
    if (known.pid !== live.pid || known.instanceId !== live.instanceId) {
      throw new Error("Channel-host ownership mismatch");
    }
    console.log("Channel host: " + live.status + " | mode " + live.mode + " | PID " + live.pid);
    console.log("Port: " + live.port + " | watcher: " + (live.watcherActive ? "active" : "inactive"));
    console.log("Active task: " + live.taskActive + " | completed: " + live.tasksCompleted);
    console.log("Checkpoint reconciliation pending: " + (live.reconciliationPending ?? 0));
    return false;
  }
  if (action === "serve") {
    if (typeof mode !== "string") throw new Error("Missing --mode");
    await runChannelHost({ port, wsPort, mode: mode as ChannelHostMode });
    console.log("Independent channel host listening on http://127.0.0.1:" + port + " (" + mode + ")");
    return true;
  }
  throw new Error("Expected channel-host serve, status, checkpoint or help");
}
