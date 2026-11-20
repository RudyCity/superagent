/**
 * Independent HTTP control & health server for Managed Core Guardian.
 * Exposes /guardian/health and Bearer-authenticated /guardian/control.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { readCoreGuardianLease } from "./coreGuardian.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";
import { readCoreCheckpoint } from "./coreSupervisorCheckpoint.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { callCoreWorkerDelegateBridge } from "./coreDelegateHandover.js";

export type ManagedGuardianOwner = {
  version: 1;
  port: number;
  pid: number;
  instanceId: string;
  token: string;
  controlPort: number;
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export function managedGuardianOwnerPath(port: number): string {
  return path.join(getRootConfigDir(), "managed-guardian-" + port + ".json");
}

export function readManagedGuardianOwner(port: number): ManagedGuardianOwner | null {
  const file = managedGuardianOwnerPath(port);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 2048) {
    throw new Error("MANAGED_GUARDIAN_OWNER_FILE_UNSAFE");
  }
  const x = JSON.parse(fs.readFileSync(file, "utf8")) as ManagedGuardianOwner;
  if (
    x.version !== 1 || x.port !== port || !Number.isSafeInteger(x.pid) || x.pid <= 0 ||
    !/^[a-f0-9]{32}$/.test(x.instanceId) || !/^[a-f0-9]{64}$/.test(x.token) ||
    !Number.isSafeInteger(x.controlPort) || x.controlPort < 1024 || x.controlPort > 65535
  ) {
    throw new Error("MANAGED_GUARDIAN_OWNER_FILE_INVALID");
  }
  return x;
}

export async function startManagedGuardianControlServer(options: {
  port: number;
  controller: AbortController;
}): Promise<{ owner: ManagedGuardianOwner; close: () => Promise<void> }> {
  const { port, controller } = options;
  let owner: ManagedGuardianOwner;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/guardian/health") {
      const lease = readCoreGuardianLease(port);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        service: "superagent-managed-guardian",
        pid: process.pid,
        corePort: port,
        instanceId: owner.instanceId,
        guardianRegistered: lease?.pid === process.pid,
        supervisorPid: lease?.supervisorPid ?? null,
      }));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/guardian/control") {
      res.writeHead(404);
      res.end();
      return;
    }
    const remote = req.socket.remoteAddress;
    const provided = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from("Bearer " + owner.token);
    if (
      (remote !== "127.0.0.1" && remote !== "::1") ||
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      res.writeHead(401);
      res.end();
      req.resume();
      return;
    }
    req.setTimeout(2500, () => req.destroy());
    let raw = "";
    for await (const chunk of req) {
      raw += String(chunk);
      if (raw.length > 256) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    let request: any = null;
    try {
      request = JSON.parse(raw);
    } catch {}
    if (
      !["stop", "recycle_core_owner"].includes(String(request?.action)) ||
      request.instanceId !== owner.instanceId
    ) {
      res.writeHead(400);
      res.end();
      return;
    }
    let live: any;
    let lease: any;
    try {
      live = await requestCoreSupervisor("status", port, 1200);
      lease = readCoreGuardianLease(port);
      if (
        !lease || lease.pid !== process.pid || live.supervisorPid !== lease.supervisorPid ||
        readListenerOwners()?.get(port) !== live.supervisorPid
      ) {
        throw new Error("Core supervisor or Guardian identity changed");
      }
    } catch {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "GUARDIAN_CORE_UNHEALTHY_OR_OWNER_CHANGED" }));
      return;
    }
    if (request.action === "stop") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, stopping: true, coreUnaffected: true }));
      controller.abort();
      return;
    }
    try {
      const checkpoint = readCoreCheckpoint(port);
      if (checkpoint.activePid !== live.active.pid || live.affinitySessions !== 0) {
        throw new Error("GUARDIAN_CORE_OWNER_RECYCLE_NOT_QUIESCENT");
      }
      const worker = checkpoint.workers.find((item: any) => item.pid === live.active.pid);
      if (!worker) throw new Error("GUARDIAN_CORE_OWNER_RECYCLE_CHECKPOINT_MISMATCH");
      const delegateState = await callCoreWorkerDelegateBridge(
        worker.port, "status", checkpoint.serverToken);
      if ((delegateState.pendingRequests ?? 0) !== 0) {
        throw new Error("GUARDIAN_CORE_OWNER_RECYCLE_DELEGATE_INFLIGHT");
      }
      const previousSupervisorPid = live.supervisorPid;
      process.kill(previousSupervisorPid, "SIGTERM");
      res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, recycling: true, previousSupervisorPid }));
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message : "GUARDIAN_CORE_OWNER_RECYCLE_REFUSED";
      res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, code }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MANAGED_GUARDIAN_LISTENER_MISSING");
  }
  owner = {
    version: 1,
    port,
    pid: process.pid,
    instanceId: crypto.randomBytes(16).toString("hex"),
    token: crypto.randomBytes(32).toString("hex"),
    controlPort: address.port,
  };
  const file = managedGuardianOwnerPath(port);
  const existing = readManagedGuardianOwner(port);
  if (existing) {
    if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
      throw new Error("MANAGED_GUARDIAN_ALREADY_REGISTERED");
    }
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    throw new Error("MANAGED_GUARDIAN_UNSAFE_DIRECTORY");
  }
  fs.writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });

  return {
    owner,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        const current = readManagedGuardianOwner(port);
        if (current?.pid === owner.pid && current.instanceId === owner.instanceId) {
          fs.rmSync(file, { force: true });
        }
      } catch {}
    },
  };
}
