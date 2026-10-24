/**
 * Strictly validated checkpoint for opt-in API supervisor crash recovery.
 * Contains owner-only bearer capabilities: NEVER log or expose in /core status.
 * This is routing/worker metadata, not an AI transcript or process migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreOwner } from "./coreSessionRouting.js";
import { validCoreSessionId } from "./coreSessionRouting.js";

export interface CoreCheckpointWorker extends CoreOwner {
  generationId: string;
  drainEligible: boolean;
}

export interface CoreSupervisorCheckpoint {
  version: 1;
  port: number;
  savedAt: number;
  clientMode: "tline" | "chrome-extension";
  serverToken: string;
  inspectToken: string;
  activePid: number;
  workers: CoreCheckpointWorker[];
  sessions: Array<{ sessionId: string; owner: CoreOwner }>;
}

export const coreCheckpointPath = (port: number): string =>
  path.join(os.homedir(), ".superagent-r", "core-checkpoint-" + port + ".json");

const goodPort = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;
const goodPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
const goodOwner = (v: any): v is CoreOwner =>
  v && goodPid(v.pid) && goodPort(v.port) && Number.isSafeInteger(v.since) && v.since > 0;

export function validateCoreCheckpoint(value: unknown, port: number): CoreSupervisorCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid checkpoint object");
  const v = value as Partial<CoreSupervisorCheckpoint>;
  if (v.version !== 1 || v.port !== port || !goodPort(port) ||
      !Number.isSafeInteger(v.savedAt) || v.savedAt! < 1 ||
      (v.clientMode !== "tline" && v.clientMode !== "chrome-extension") ||
      typeof v.serverToken !== "string" || !/^[a-f0-9]{48}$/.test(v.serverToken) ||
      typeof v.inspectToken !== "string" || !/^[a-f0-9]{64}$/.test(v.inspectToken) ||
      !goodPid(v.activePid!) || !Array.isArray(v.workers) || v.workers.length < 1 ||
      v.workers.length > 5 || !Array.isArray(v.sessions) || v.sessions.length > 20000) {
    throw new Error("Checkpoint shape or capabilities invalid");
  }
  const keys = new Set<string>();
  for (const worker of v.workers) {
    if (!goodOwner(worker) || typeof worker.generationId !== "string" ||
        !/^[a-f0-9]{32}$/.test(worker.generationId) ||
        typeof worker.drainEligible !== "boolean" ||
        keys.has(worker.pid + ":" + worker.port)) throw new Error("Invalid or duplicate checkpoint worker");
    keys.add(worker.pid + ":" + worker.port);
  }
  if (!v.workers.some(worker => worker.pid === v.activePid)) throw new Error("Missing checkpoint active worker");
  const ids = new Set<string>();
  for (const session of v.sessions) {
    if (!session || typeof session !== "object" ||
        validCoreSessionId(session.sessionId) !== session.sessionId ||
        ids.has(session.sessionId) || !goodOwner(session.owner) ||
        !keys.has(session.owner.pid + ":" + session.owner.port) ||
        !v.workers.some(worker => worker.pid === session.owner.pid &&
          worker.port === session.owner.port && worker.since === session.owner.since)) {
      throw new Error("Invalid, duplicated or unowned checkpoint session");
    }
    ids.add(session.sessionId);
  }
  return v as CoreSupervisorCheckpoint;
}

export function readCoreCheckpoint(port: number): CoreSupervisorCheckpoint {
  const file = coreCheckpointPath(port);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6 * 1024 * 1024) {
    throw new Error("Unsafe supervisor checkpoint");
  }
  return validateCoreCheckpoint(JSON.parse(fs.readFileSync(file, "utf8")), port);
}

export function writeCoreCheckpoint(state: CoreSupervisorCheckpoint): void {
  validateCoreCheckpoint(state, state.port);
  const file = coreCheckpointPath(state.port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows owner ACL differs */ }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}
