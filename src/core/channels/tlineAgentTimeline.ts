/** Durable, sanitized, local-only agent execution metadata for T-Line.
 * No tool arguments/results, user prompts, credentials, permission tokens, URLs or paths.
 * Read is authorized separately by the HTTP session owner gate.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";

export type AgentTimelineKind =
  "tool_start" | "tool_end" | "subagent_status" | "permission_requested" |
  "permission_decided" | "agent_done";
export type AgentTimelineEvent = {
  seq: number; at: number; kind: AgentTimelineKind; actor: string;
  tool?: string; status?: string; callId?: string; parent?: string;
};
type StoredJournal = { version: 1; scope: string; nextSeq: number; events: AgentTimelineEvent[] };
type Scope = { workspace: string; sessionId: string };
export const AGENT_TIMELINE_MAX = 400;
// Only the authenticated T-Line server can bind a root agent. Delegated
// children inherit that precise scope, never a guessed workspace path.
const agentScopes = new WeakMap<object, Scope>();
const agentActors = new WeakMap<object, string>();
const agentParents = new WeakMap<object, string>();
const hashedCall = (input: unknown) => typeof input === "string" && input.length > 0 && input.length < 256
  ? createHash("sha256").update(input).digest("hex").slice(0, 20) : undefined;
export function bindTlineRootAgent(agent: object, scope: Scope) {
  if (validScope(scope)) {
    agentScopes.set(agent, { ...scope });
    agentActors.set(agent, "main");
  }
}
export function inheritTlineChildScope(parent: object | null | undefined, child: object,
  childId?: string): boolean {
  if (!parent) return false;
  const scope = agentScopes.get(parent);
  if (!scope) return false;
  agentScopes.set(child, scope);
  const parentActor = agentActors.get(parent);
  if (parentActor) agentParents.set(child, parentActor);
  if (childId) agentActors.set(child, actorId(childId) || "main");
  return true;
}
export function recordTlineChildToolEvent(
  child: object, agentId: string, event: {
    type: string; toolCall?: { name?: string; id?: string }; toolResult?: { name?: string; isError?: boolean; toolCallId?: string };
  },
): boolean {
  const scope = agentScopes.get(child);
  if (!scope || (event.type !== "tool_start" && event.type !== "tool_end")) return false;
  return recordAgentTimeline(scope, {
    kind: event.type, actor: agentId,
    parent: agentParents.get(child),
    callId: event.type === "tool_start" ? event.toolCall?.id : event.toolResult?.toolCallId,
    tool: event.type === "tool_start" ? event.toolCall?.name : event.toolResult?.name,
    status: event.type === "tool_start" ? "running" : event.toolResult?.isError ? "failed" : "completed",
  });
}
const MAX_BYTES = 256 * 1024;
const MAX_SCOPES = 96;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
let writesSinceCleanup = 0;
function pruneStoredScopes(): void {
  try {
    const list = fs.readdirSync(base()).filter(n => /^[a-f0-9]{64}\.json$/.test(n))
      .map(n => {
        const file = path.join(base(), n);
        try { const stat = fs.lstatSync(file);
          return stat.isFile() && !stat.isSymbolicLink() ? { file, stat } : null; }
        catch { return null; }
      }).filter((entry): entry is { file: string; stat: fs.Stats } => entry !== null)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const [i, item] of list.entries()) {
      if (i < MAX_SCOPES && Date.now() - item.stat.mtimeMs < MAX_AGE_MS) continue;
      if (!fs.existsSync(item.file + ".lock")) try { fs.unlinkSync(item.file); } catch {}
    }
  } catch { /* Retention maintenance never blocks execution. */ }
}
const SESSION = /^[a-zA-Z0-9_-]{1,128}$/;
const KINDS = new Set<AgentTimelineKind>([
  "tool_start", "tool_end", "subagent_status", "permission_requested",
  "permission_decided", "agent_done",
]);
const ALLOWED_STATUS = new Set([
  "running", "completed", "failed", "error", "cancelled", "terminated", "queued",
  "approved", "approved_session", "denied", "expired", "finished", "unknown",
]);
let testRoot: string | undefined;
export function setAgentTimelineRootForTests(root?: string) { testRoot = root; }
const base = () => testRoot || path.join(getRootConfigDir(), "tline-agent-timeline");
const scopeHash = ({ workspace, sessionId }: Scope) =>
  createHash("sha256").update(JSON.stringify([workspace.toLowerCase(), sessionId])).digest("hex");
const localFile = (scope: Scope) => path.join(base(), scopeHash(scope) + ".json");
const safeName = (value: unknown, fallback: string) =>
  typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/.test(value) ? value : fallback;
const safeStatus = (value: unknown) => {
  const normalized = typeof value === "string" ? value.toLowerCase() : "unknown";
  return ALLOWED_STATUS.has(normalized) ? normalized : "unknown";
};
const actorId = (raw: unknown) => typeof raw === "string" && raw.length > 0 && raw.length < 256
  ? "sub:" + createHash("sha256").update(raw).digest("hex").slice(0, 20) : null;
const validScope = (s: Scope) =>
  typeof s.workspace === "string" && s.workspace.length > 0 && s.workspace.length <= 4096 &&
  !/[\u0000-\u001f]/.test(s.workspace) && typeof s.sessionId === "string" && SESSION.test(s.sessionId);
const validEvent = (e: any): e is AgentTimelineEvent =>
  !!e && Number.isSafeInteger(e.seq) && e.seq >= 1 &&
  Number.isSafeInteger(e.at) && e.at > 0 && KINDS.has(e.kind) &&
  (e.actor === "main" || /^sub:[a-f0-9]{20}$/.test(e.actor)) &&
  (e.tool === undefined || safeName(e.tool, "") === e.tool) &&
  (e.status === undefined || ALLOWED_STATUS.has(e.status)) &&
  (e.callId === undefined || /^[a-f0-9]{20}$/.test(e.callId)) &&
  (e.parent === undefined || e.parent === "main" || /^sub:[a-f0-9]{20}$/.test(e.parent));
function load(scope: Scope): StoredJournal {
  const empty: StoredJournal = { version: 1, scope: scopeHash(scope), nextSeq: 1, events: [] };
  const file = localFile(scope);
  if (!fs.existsSync(file)) return empty;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error("Invalid journal file");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as StoredJournal;
  if (data.version !== 1 || data.scope !== empty.scope ||
      !Number.isSafeInteger(data.nextSeq) || data.nextSeq < 1 ||
      !Array.isArray(data.events) || data.events.length > AGENT_TIMELINE_MAX ||
      !data.events.every(validEvent) ||
      data.events.some((event, i) => (i > 0 && event.seq <= data.events[i-1].seq) ||
        event.seq >= data.nextSeq)) throw Error("Invalid agent timeline journal");
  return data;
}
function ensureDir() {
  fs.mkdirSync(base(), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(base()).isSymbolicLink()) throw Error("Journal directory is a symlink");
}
export function recordAgentTimeline(
  scope: Scope, input: { kind: AgentTimelineKind; actor?: string; tool?: unknown;
    status?: unknown; callId?: unknown; parent?: string },
): boolean {
  if (!validScope(scope) || !KINDS.has(input.kind)) return false;
  let lock: number | undefined;
  let tmp: string | undefined;
  try {
    ensureDir();
    const file = localFile(scope);
    const lockFile = file + ".lock";
    // Cross-process, fail-closed writer guard. Never steal an uncertain owner lease.
    lock = fs.openSync(lockFile, "wx", 0o600);
    try {
      const record = load(scope);
      const actor = input.actor === "main" ? "main" : actorId(input.actor);
      if (!actor) return false;
      const event: AgentTimelineEvent = {
        seq: record.nextSeq, at: Date.now(), kind: input.kind, actor,
        ...(input.tool === undefined ? {} : { tool: safeName(input.tool, "tool") }),
        ...(input.status === undefined ? {} : { status: safeStatus(input.status) }),
        ...(hashedCall(input.callId) ? { callId: hashedCall(input.callId) } : {}),
        ...(input.parent === "main" || /^sub:[a-f0-9]{20}$/.test(input.parent || "")
          ? { parent: input.parent } : {}),
      };
      // Repeated subagent snapshots often only change logs. Don't invent state transitions.
      if (input.kind === "subagent_status" && record.events.some(e =>
        e.kind === "subagent_status" && e.actor === actor && e.status === event.status &&
        !record.events.slice(record.events.indexOf(e) + 1).some(next =>
          next.kind === "subagent_status" && next.actor === actor))) return true;
      record.events.push(event);
      record.nextSeq += 1;
      if (record.events.length > AGENT_TIMELINE_MAX)
        record.events.splice(0, record.events.length - AGENT_TIMELINE_MAX);
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > MAX_BYTES) return false;
      tmp = file + "." + randomBytes(6).toString("hex") + ".tmp";
      fs.writeFileSync(tmp, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, file);
      tmp = undefined;
      if (++writesSinceCleanup >= 32) {
        writesSinceCleanup = 0;
        pruneStoredScopes();
      }
      return true;
    } finally { fs.closeSync(lock); lock = undefined; fs.unlinkSync(lockFile); }
  } catch { return false; }
  finally {
    if (lock !== undefined) try { fs.closeSync(lock); } catch {}
    if (tmp) try { fs.unlinkSync(tmp); } catch {}
  }
}
export function readAgentTimeline(scope: Scope, cursor: number, limit = 100): {
  schemaVersion: 1; events: AgentTimelineEvent[]; nextCursor: number; gap: boolean;
} {
  if (!validScope(scope) || !Number.isSafeInteger(cursor) || cursor < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("Invalid timeline request");
  const record = load(scope); // Corruption must fail closed, never invent an empty trace.
  const first = record.events[0]?.seq;
  const gap = first !== undefined && cursor < first - 1;
  const events = record.events.filter(e => e.seq > cursor).slice(0, limit);
  return { schemaVersion: 1, events, nextCursor: events.at(-1)?.seq || cursor, gap };
}
export function projectAgentTimelineEnvelope(raw: any): Array<{
  kind: AgentTimelineKind; actor?: string; tool?: unknown; status?: unknown; callId?: unknown
}> {
  if (!raw || typeof raw !== "object") return [];
  if (raw.type === "agent_event" && raw.event && typeof raw.event === "object") {
    const ev = raw.event;
    if (ev.type === "tool_start") return [{
      kind: "tool_start", actor: "main", tool: ev.toolCall?.name, callId: ev.toolCall?.id,
      status: "running",
    }];
    if (ev.type === "tool_end") return [{
      kind: "tool_end", actor: "main", tool: ev.toolResult?.name || ev.toolCall?.name,
      callId: ev.toolResult?.toolCallId || ev.toolCall?.id,
      status: ev.toolResult?.isError === true ? "failed" : "completed",
    }];
    if (ev.type === "done" || ev.type === "goal_done") return [
      { kind: "agent_done", actor: "main", status: "finished" }];
  }
  if (raw.type === "permission_required") return [{
    kind: "permission_requested", actor: "main",
    tool: raw.toolCall?.name, status: "queued",
  }];
  if (raw.type === "subagents_update" && Array.isArray(raw.subagents)) {
    return raw.subagents.slice(0, 40).filter((a: any) =>
      !!a && typeof a.id === "string" && a.id.length > 0).map((a: any) => ({
        kind: "subagent_status" as const, actor: a.id, status: a.status,
      }));
  }
  return [];
}
