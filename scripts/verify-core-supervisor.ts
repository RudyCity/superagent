/**
 * Explicit, isolated acceptance smoke: launches its OWN supervisor and workers.
 * Never operates on an existing 7888, MCP tunnel or application process.
 */
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolve(address.port));
    });
  });
}

async function status(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1", port, path: "/api/status",
      headers: { Authorization: "Bearer " + token }, timeout: 3500,
    }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("Status timeout")));
  });
}

async function jsonApi(
  port: number, token: string, method: string, pathname: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, any> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method, timeout: 9000,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("API request timed out")));
    req.end(payload);
  });
}

function killOwned(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", timeout: 3000 });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {}
}

const publicPort = await freePort();
if (publicPort === 7888) throw new Error("Refusing to run test on production default port");
const root = process.cwd();
const owner = spawn(process.execPath, [path.join(root, "src", "cli.tsx"), "core", "start", "--port", String(publicPort)], {
  cwd: root, stdio: "ignore", windowsHide: true,
});
owner.once("error", () => {});
const ownedPids = new Set<number>();
const discoveryFile = path.join(os.homedir(), ".superagent-r", "core-supervisor-" + publicPort + ".json");
const infoFile = path.join(os.homedir(), ".superagent-r", "server-info-" + publicPort + ".json");

try {
  let initial: Awaited<ReturnType<typeof requestCoreSupervisor>> | undefined;
  for (let i = 0; i < 150; i++) {
    try {
      initial = await requestCoreSupervisor("status", publicPort);
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!initial) throw new Error("Supervisor did not start; inspect local server log");
  if (initial.supervisorPid !== owner.pid) throw new Error("Unexpected supervisor owner; stopping verification");
  ownedPids.add(initial.active.pid);

  const initialToken = JSON.parse(fs.readFileSync(infoFile, "utf8")).authToken as string;
  if (await status(publicPort, initialToken) !== 200) throw new Error("Front-door proxy auth/status failed");

  // Initialize a real in-memory session before swapping the code generation.
  const oldId = "core_acceptance_" + process.pid + "_" + Date.now();
  const initialized = await jsonApi(publicPort, initialToken, "POST", "/api/init", {
    sessionId: oldId, mode: "single", workspace: root,
  });
  if (initialized.status !== 200 || initialized.data.sessionId !== oldId) {
    throw new Error("First generation did not create session: " + JSON.stringify(initialized));
  }
  if ((await requestCoreSupervisor("status", publicPort)).affinitySessions !== 1) {
    throw new Error("Core supervisor did not pin initialized session");
  }
  const next = await requestCoreSupervisor("restart", publicPort);
  if (next.supervisorPid !== owner.pid) throw new Error("Supervisor ownership changed unexpectedly");
  ownedPids.add(next.active.pid);
  if (next.active.pid === initial.active.pid) throw new Error("Worker generation did not change");
  if (next.retained.every(p => p.pid !== initial.active.pid)) throw new Error("Previous generation not retained");
  if (await status(publicPort, initialToken) !== 200) throw new Error("Public port lost auth after restart");
  if (await status(initial.active.port, initialToken) !== 200) throw new Error("Previous worker lost its listener");
  if (await status(next.active.port, initialToken) !== 200) throw new Error("New worker did not respond");
  const afterToken = JSON.parse(fs.readFileSync(infoFile, "utf8")).authToken;
  if (afterToken !== initialToken) throw new Error("Public auth token unexpectedly rotated");

  // A named old session stays on the previous worker and new sessions go to
  // the newly selected worker. No LLM is called by this smoke scenario.
  const oldStatus = await jsonApi(publicPort, initialToken, "GET", "/api/status?sessionId=" + oldId);
  if (oldStatus.status !== 200 || oldStatus.data.sessionId !== oldId) {
    throw new Error("Session affinity lost after restart: " + JSON.stringify(oldStatus));
  }
  const oldChat = await jsonApi(publicPort, initialToken, "POST", "/api/chat", { sessionId: oldId, message: "" });
  if (oldChat.status !== 400 || oldChat.data.error === "Session not initialized") {
    throw new Error("POST chat body affinity failed: " + JSON.stringify(oldChat));
  }

  const newId = oldId + "_new";
  const newInit = await jsonApi(publicPort, initialToken, "POST", "/api/init", {
    sessionId: newId, mode: "single", workspace: root,
  });
  if (newInit.status !== 200 || newInit.data.sessionId !== newId) {
    throw new Error("Second generation could not create a new session: " + JSON.stringify(newInit));
  }
  const afterStatus = await requestCoreSupervisor("status", publicPort);
  if (afterStatus.affinitySessions !== 2) throw new Error("Wrong session-affinity count after handover");
  console.log("PASS isolated core handover: auth/port stable, old session+chat pinned, new session on new worker");
} finally {
  killOwned(owner.pid ?? 0);
  for (const pid of ownedPids) killOwned(pid);
  try {
    const disc = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
    if (disc.supervisorPid === owner.pid) fs.rmSync(discoveryFile, { force: true });
  } catch {}
  try {
    const state = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    if (state.pid === owner.pid) fs.rmSync(infoFile, { force: true });
  } catch {}
}
