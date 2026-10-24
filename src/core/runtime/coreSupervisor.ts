import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface CoreRuntimeStatus {
  supervisorPid: number;
  publicPort: number;
  active: { pid: number; port: number; since: number };
  retained: Array<{ pid: number; port: number; since: number }>;
}

/**
 * Opt-in API core supervisor.
 *
 * The public listener is owned by this process; workers bind only to loopback
 * ephemeral ports. Previous generations are intentionally retained to protect
 * running jobs and already-established SSE/WebSocket connections. This is not
 * a restart of the interactive CLI, MCP, Muse or Telegram processes.
 */
const stateDir = () => path.join(os.homedir(), ".superagent-r");
const statePath = (port: number) => path.join(stateDir(), "core-supervisor-" + port + ".json");
const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type Generation = CoreRuntimeStatus["active"] & { child: ChildProcess };

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

export async function requestCoreSupervisor(action: "status" | "restart", port = 7888): Promise<CoreRuntimeStatus> {
  let info: SupervisorDiscovery;
  try { info = readDiscovery(port); }
  catch { throw new Error("No supervised core is registered on port " + port + ". Start: superagent core start --port " + port); }
  return new Promise<CoreRuntimeStatus>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: info.controlPort, method: action === "restart" ? "POST" : "GET",
      path: "/" + action,
      timeout: 30000,
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

export async function runCoreSupervisor(port = 7888, clientMode: "tline" | "chrome-extension" = "tline"): Promise<void> {
  if (!validPort(port)) throw new Error("Invalid public port");
  // Fail closed when an instance is already healthy; never touch existing owners.
  try {
    await requestCoreSupervisor("status", port);
    throw new Error("A core supervisor is already running on port " + port);
  } catch (error) {
    if (String(error).includes("already running")) throw error;
  }

  const controlToken = crypto.randomBytes(32).toString("hex");
  // All workers use the same bearer token so reconnecting clients remain authorized.
  const serverToken = crypto.randomBytes(24).toString("hex");
  let active: Generation | undefined;
  const retained: Generation[] = [];
  let restarting = false;

  async function spawnWorker(): Promise<Generation> {
    const workerPort = await reserveLoopbackPort();
    const entry = path.resolve(process.argv[1] || "");
    const child = spawn(process.execPath, [entry, "--server", String(workerPort), "--client-mode", clientMode], {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
      detached: true,
      env: {
        ...process.env,
        SUPERAGENT_CORE_WORKER: "1",
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
    return { child, pid: child.pid, port: workerPort, since: Date.now() };
  }

  function status(): CoreRuntimeStatus {
    if (!active) throw new Error("No healthy core worker");
    return {
      supervisorPid: process.pid,
      publicPort: port,
      active: { pid: active.pid, port: active.port, since: active.since },
      retained: retained.map(({ pid, port: workerPort, since }) => ({ pid, port: workerPort, since })),
    };
  }

  async function restart(): Promise<CoreRuntimeStatus> {
    if (restarting) throw new Error("Core restart already in progress");
    restarting = true;
    try {
      const candidate = await spawnWorker();
      if (active) retained.push(active); // no SIGTERM, taskkill or process-tree cleanup
      active = candidate;                 // new requests use new version atomically
      return status();
    } finally {
      restarting = false;
    }
  }

  const listener = http.createServer((req, res) => {
    const worker = active;
    if (!worker) { res.writeHead(503); res.end("Core starting"); return; }
    const proxy = http.request({
      host: "127.0.0.1", port: worker.port,
      path: req.url, method: req.method, headers: req.headers,
    }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Core upstream unavailable");
    });
    req.pipe(proxy);
  });
  listener.on("upgrade", (req, socket, head) => {
    const worker = active;
    if (!worker) { socket.destroy(); return; }
    const upstream = net.connect(worker.port, "127.0.0.1", () => {
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
          : null;
      if (!result) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

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
    active = await spawnWorker();
    const controlAddress = control.address();
    if (!controlAddress || typeof controlAddress === "string") throw new Error("Control port missing");
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
    console.log("Worker PID " + active.pid + "; use: superagent core restart --port " + port);
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
    "Existing connections remain on their original worker. Previous workers are not killed automatically.",
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
    console.log("Requires opt-in supervisor startup; existing unsupervised processes are never replaced.");
    return;
  }
  if (action === "start") {
    const clientModeIdx = argv.indexOf("--client-mode");
    const mode = clientModeIdx < 0 ? "tline" : argv[clientModeIdx + 1];
    if (mode !== "tline" && mode !== "chrome-extension") throw new Error("Invalid --client-mode");
    await runCoreSupervisor(port, mode);
    return;
  }
  if (action !== "status" && action !== "restart") throw new Error("Expected start, status, restart or help");
  console.log(formatCoreSupervisorStatus(await requestCoreSupervisor(action, port)));
}
