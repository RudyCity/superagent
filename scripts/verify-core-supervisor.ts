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

async function status(port: number, token: string, pathname = "/api/status"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1", port, path: pathname,
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
  if (await status(publicPort, initialToken, "/_core/internal/drain") !== 404) {
    throw new Error("Internal drain endpoint escaped onto public API port");
  }

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

  // Manual rollback only changes the default route; pre-existing sessions
  // on both generations MUST remain bound to their owning worker.
  const rolledBack = await requestCoreSupervisor("rollback", publicPort);
  if (rolledBack.active.pid !== initial.active.pid ||
      rolledBack.lastRollback?.reason !== "operator-requested") {
    throw new Error("Manual rollback did not switch to the verified previous generation");
  }
  if ((await jsonApi(publicPort, initialToken, "GET", "/api/status?sessionId=" + newId)).data.sessionId !== newId) {
    throw new Error("New-generation session was lost during manual rollback");
  }
  if ((await jsonApi(publicPort, initialToken, "GET", "/api/status?sessionId=" + oldId)).data.sessionId !== oldId) {
    throw new Error("Old-generation session was lost during manual rollback");
  }

  // If the newly active test worker exits, the supervisor can automatically
  // reselect a responsive previous generation. Never kill the production PID.
  const third = await requestCoreSupervisor("restart", publicPort);
  ownedPids.add(third.active.pid);
  if (third.active.pid === rolledBack.active.pid) throw new Error("Third generation did not change");
  const crashedSessionId = newId + "_crashed";
  const crashedInit = await jsonApi(publicPort, initialToken, "POST", "/api/init", {
    sessionId: crashedSessionId, mode: "single", workspace: root,
  });
  if (crashedInit.status !== 200 || crashedInit.data.sessionId !== crashedSessionId) {
    throw new Error("Third generation could not create a crash-recovery fixture");
  }
  killOwned(third.active.pid);
  let automatic: Awaited<ReturnType<typeof requestCoreSupervisor>> | undefined;
  for (let i = 0; i < 30; i++) {
    const observed = await requestCoreSupervisor("status", publicPort);
    if (observed.active.pid !== third.active.pid &&
        observed.lastRollback?.reason === "active-worker-exited") {
      automatic = observed;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!automatic) throw new Error("Supervisor failed to roll back after an owned test worker exited");
  const unavailable = await jsonApi(publicPort, initialToken, "GET", "/api/status?sessionId=" + crashedSessionId);
  if (unavailable.status !== 503) {
    throw new Error("A session owned by a crashed generation must fail closed, not migrate silently");
  }
  if ((await jsonApi(publicPort, initialToken, "GET", "/api/status?sessionId=" + oldId)).data.sessionId !== oldId) {
    throw new Error("Original session did not survive automatic failover");
  }
  if ((await jsonApi(publicPort, initialToken, "GET", "/api/status?sessionId=" + newId)).data.sessionId !== newId) {
    throw new Error("Second-generation session did not survive automatic failover");
  }
  // The vision owner and session-bearing old workers must not be reaped.
  const guarded = await requestCoreSupervisor("drain", publicPort);
  if (guarded.lastDrain?.retiredPids.length !== 0 || guarded.lastDrain.blocked.length === 0) {
    throw new Error("Draining retained workers with live sessions/helper should fail closed");
  }

  // New API-only generation with NO session or open stream may be retired.
  const fourth = await requestCoreSupervisor("restart", publicPort);
  ownedPids.add(fourth.active.pid);
  const fifth = await requestCoreSupervisor("restart", publicPort);
  ownedPids.add(fifth.active.pid);
  const verified = await requestCoreSupervisor("drain", publicPort);
  if (!verified.lastDrain?.retiredPids.includes(fourth.active.pid)) {
    throw new Error("Quiescent API-only worker was not verified and drained: " +
      JSON.stringify(verified.lastDrain));
  }
  if (verified.retained.some(w => w.pid === fourth.active.pid)) {
    throw new Error("Retired worker still occupies retained generation slot");
  }
  if (!verified.lastDrain.blocked.some(reason => reason.includes("pinned sessions"))) {
    throw new Error("Drain failed to protect workers with pre-existing sessions");
  }
  if (await status(publicPort, initialToken) !== 200) {
    throw new Error("Public API did not survive worker drain");
  }
  console.log("PASS isolated core: affinity, rollback, crash failover, fail-closed inspection, verified idle drain");
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
