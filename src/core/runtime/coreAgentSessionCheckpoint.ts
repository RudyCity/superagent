/**
 * Durable, owner-scoped *metadata* for safe explicit conversation resumption.
 * Does not serialize an Agent, grants no permissions, and never replays tools.
 * History contents and chat-turn lifecycle remain in existing historyDb.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { validCoreSessionId } from "./coreSessionRouting.js";

export interface CoreAgentSessionReceipt {
  version: 1;
  sessionId: string;
  workspace: string;
  mode: "single" | "multi";
  clientMode: "tline" | "chrome-extension";
  createdAt: number;
  lastAcceptedTurnAt?: number;
  lastAcceptedTurnId?: string;
}
const validSession = (v: unknown) => typeof v === "string" &&
  validCoreSessionId(v) === v && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const validWorkspace = (v: unknown) => typeof v === "string" &&
  v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const sameWorkspace = (a: string, b: string) =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
  b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function validate(value: unknown): CoreAgentSessionReceipt {
  const r = value as CoreAgentSessionReceipt;
  if (!r || typeof r !== "object" || Array.isArray(r) ||
      r.version !== 1 || !validSession(r.sessionId) || !validWorkspace(r.workspace) ||
      !["single", "multi"].includes(r.mode) ||
      !["tline", "chrome-extension"].includes(r.clientMode) ||
      !Number.isSafeInteger(r.createdAt) || r.createdAt <= 0 ||
      (r.lastAcceptedTurnId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(r.lastAcceptedTurnId)) ||
      (r.lastAcceptedTurnAt !== undefined && (!Number.isSafeInteger(r.lastAcceptedTurnAt) || r.lastAcceptedTurnAt < r.createdAt))) {
    throw new Error("Invalid durable session metadata");
  }
  return r;
}
export function coreAgentSessionReceiptPath(sessionId: string): string {
  if (!validSession(sessionId)) throw new Error("Invalid session ID");
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex");
  return path.join(getRootConfigDir(), "core-session-receipts", hash.slice(0, 2), hash + ".json");
}
export function readCoreAgentSessionReceipt(sessionId: string): CoreAgentSessionReceipt | null {
  const file = coreAgentSessionReceiptPath(sessionId);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unable to read session checkpoint");
  }
  for (const directory of [getRootConfigDir(), path.dirname(path.dirname(file)), path.dirname(file)]) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe session checkpoint directory");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 8192) {
    throw new Error("Unsafe session checkpoint");
  }
  let value: CoreAgentSessionReceipt;
  try { value = validate(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { throw new Error("Corrupt session checkpoint"); }
  if (value.sessionId !== sessionId) throw new Error("Session checkpoint identity mismatch");
  return value;
}
function atomicWrite(file: string, value: CoreAgentSessionReceipt, createOnly = false): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const candidate of [getRootConfigDir(), path.dirname(dir), dir]) {
    const info = fs.lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe session checkpoint directory");
  }
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    const handle = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(value));
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    if (createOnly) {
      // Atomic exclusive publish: two worker processes must never both
      // silently create/replace the same session's registration.
      fs.linkSync(tmp, file);
      fs.rmSync(tmp);
    } else {
      fs.renameSync(tmp, file);
    }
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
export function writeCoreAgentSessionReceipt(input: {
  sessionId: string; workspace: string; mode: "single" | "multi";
  clientMode: "tline" | "chrome-extension";
}): CoreAgentSessionReceipt {
  const existing = readCoreAgentSessionReceipt(input.sessionId);
  if (existing) {
    if (!sameWorkspace(existing.workspace, input.workspace) ||
        existing.mode !== input.mode || existing.clientMode !== input.clientMode) {
      throw new Error("Session checkpoint belongs to different workspace or mode");
    }
    return existing;
  }
  const value = validate({ ...input, version: 1, createdAt: Date.now() });
  const file = coreAgentSessionReceiptPath(value.sessionId);
  if (fs.existsSync(file)) throw new Error("Session checkpoint already exists");
  atomicWrite(file, value, true);
  return value;
}
export function noteCoreAgentSessionTurn(sessionId: string, turnId: string): void {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(turnId)) throw new Error("Invalid turn ID");
  const saved = readCoreAgentSessionReceipt(sessionId);
  if (!saved) throw new Error("Durable session receipt missing; refusing execution");
  atomicWrite(coreAgentSessionReceiptPath(sessionId), validate({
    ...saved, lastAcceptedTurnId: turnId, lastAcceptedTurnAt: Math.max(Date.now(), saved.createdAt),
  }));
}
export type ExplicitResumeDecision = "allow" | "missing_checkpoint" |
  "scope_mismatch" | "history_missing" | "history_stale" | "requires_review";
export function decideExplicitCoreSessionResume(input: {
  receipt: CoreAgentSessionReceipt | null;
  sessionId: string; workspace: string; mode: "single" | "multi";
  clientMode: "tline" | "chrome-extension";
  hasSavedHistory: boolean;
  historyLastModified?: number;
  historyMessageCount?: number;
  turns: Array<{ state: string; count: number }>;
}): ExplicitResumeDecision {
  const r = input.receipt;
  if (!r || r.sessionId !== input.sessionId) return "missing_checkpoint";
  if (!sameWorkspace(r.workspace, input.workspace) || r.mode !== input.mode ||
      r.clientMode !== input.clientMode) return "scope_mismatch";
  if (!input.hasSavedHistory) return "history_missing";
  if (input.turns.some(t => !Number.isSafeInteger(t.count) || t.count < 0 ||
    (t.count > 0 && !["completed", "failed", "cancelled"].includes(t.state)))) {
    return "requires_review";
  }
  // An acknowledged chat turn is NOT equivalent to durable conversation
  // context. If the last accepted turn is newer than the saved history, the
  // next worker must not silently continue from an older conversation.
  if (r.lastAcceptedTurnAt !== undefined &&
      (!Number.isSafeInteger(input.historyLastModified) ||
       input.historyLastModified! < r.lastAcceptedTurnAt ||
       !Number.isSafeInteger(input.historyMessageCount) ||
       input.historyMessageCount! < 1)) return "history_stale";
  return "allow";
}
export function mayRouteExplicitCoreResume(input: {
  id: string | undefined; postedResume: unknown; postedSessionId: unknown;
  oldWorkerUnavailable: boolean; candidateDifferent: boolean;
}): boolean {
  return Boolean(input.id && input.oldWorkerUnavailable && input.candidateDifferent &&
    input.postedResume === input.id &&
    (input.postedSessionId === undefined || input.postedSessionId === input.id));
}
