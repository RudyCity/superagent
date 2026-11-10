/**
 * Opt-in, bounded, in-memory browser action journal.
 * Never store raw payloads, selectors, typed text, URL, cookies, responses, or tokens.
 * All entrypoints must be called inside the authenticated CDP coordinator's
 * per-target read/write gate; journal itself is not an authorization boundary.
 */
import { randomUUID } from "node:crypto";
export type SafeBrowserAction = "move_cursor" | "click" | "type" | "drag_and_drop" | "navigate" | "scroll_cursor";
export type SafeActionRecord = Readonly<{
  sequence: number;
  action: SafeBrowserAction;
  status: "dispatched";
  at: number;
  /** Only cursor movement may be replayed; all other actions are audit-only. */
  position?: Readonly<{ x: number; y: number }>;
}>;
type Trace = {
  id: string;
  targetKey: string;
  actorId: string;
  generation: string;
  startedAt: number;
  expiresAt: number;
  active: boolean;
  events: SafeActionRecord[];
};
const traces = new Map<string, Trace>();
const MAX_EVENTS = 128;
const TTL_MS = 10 * 60_000;
const MAX_TRACES = 32;
const known = new Set<SafeBrowserAction>(["move_cursor","click","type","drag_and_drop","navigate","scroll_cursor"]);

function key(targetKey: string, actorId: string): string { return targetKey + "\0" + actorId; }
function prune(now: number) {
  for (const [k, trace] of traces) {
    if (trace.expiresAt <= now) traces.delete(k);
  }
}
function inspect(targetKey: string, actorId: string, generation: string, id?: string): Trace | null {
  prune(Date.now());
  const trace=traces.get(key(targetKey,actorId));
  if (!trace || trace.generation !== generation || (id && trace.id !== id)) return null;
  return trace;
}
function summary(trace: Trace) {
  return { recordingId: trace.id, active: trace.active, startedAt: trace.startedAt,
    expiresAt: trace.expiresAt, recordedCount: trace.events.length,
    capped: trace.events.length >= MAX_EVENTS };
}
export function beginBrowserActionRecording(targetKey: string, actorId: string, generation: string) {
  const now=Date.now();
  prune(now);
  if (!targetKey || !actorId || !generation) throw new Error("Recording requires a verified target lease.");
  const k=key(targetKey,actorId);
  if (!traces.has(k) && traces.size >= MAX_TRACES)
    throw new Error("Browser action recorder capacity reached.");
  const trace: Trace={ id: randomUUID(), targetKey, actorId, generation, startedAt:now,
    expiresAt:now+TTL_MS,active:true,events:[] };
  traces.set(k, trace);
  return summary(trace);
}
export function stopBrowserActionRecording(targetKey: string, actorId: string, generation: string) {
  const trace=inspect(targetKey,actorId,generation);
  if (!trace) throw new Error("No recording belongs to this active target generation.");
  trace.active=false;
  return summary(trace);
}
export function browserActionRecordingStatus(targetKey: string, actorId: string, generation: string,
  recordingId?: string) {
  const trace=inspect(targetKey,actorId,generation,recordingId);
  return trace ? summary(trace) : { active:false, recordedCount:0 };
}
export function hasActiveBrowserActionRecording(targetKey: string, actorId: string): boolean {
  prune(Date.now());
  return traces.get(key(targetKey,actorId))?.active === true;
}
export function appendBrowserActionRecord(targetKey: string, actorId: string, generation: string,
  action: string, position?: {x:number;y:number}) {
  const trace=inspect(targetKey,actorId,generation);
  if (!trace || !trace.active || !known.has(action as SafeBrowserAction)) return false;
  if (trace.events.length >= MAX_EVENTS) { trace.active=false; return false; }
  const pos=action === "move_cursor" && position &&
    Number.isFinite(position.x) && Number.isFinite(position.y) &&
    Math.abs(position.x) <= 100000 && Math.abs(position.y) <= 100000
      ? { x:position.x, y:position.y } : undefined;
  trace.events.push({sequence:trace.events.length+1,
    action:action as SafeBrowserAction,status:"dispatched",at:Date.now(),
    ...(pos ? {position:pos} : {})});
  if (trace.events.length >= MAX_EVENTS) trace.active=false;
  return true;
}
export function readBrowserActionRecording(targetKey: string, actorId: string, generation: string,
  recordingId: string) {
  const trace=inspect(targetKey,actorId,generation,recordingId);
  if (!trace) throw new Error("Recording unavailable for the current target lease.");
  return {...summary(trace),events:trace.events.map(e=>({...e,
    ...(e.position ? {position:{...e.position}} : {})}))};
}
/** Refuse replay for all click/type/navigation/drag actions; never replay a submission blindly. */
export function previewSafeCursorReplay(targetKey: string, actorId: string,
  generation: string, recordingId: string, sequence: number) {
  const trace=inspect(targetKey,actorId,generation,recordingId);
  if (!trace) throw new Error("Replay blocked: recording or target generation mismatch.");
  const action=trace.events.find(e=>e.sequence===sequence);
  if (!action) throw new Error("Replay blocked: action not found.");
  if (action.action !== "move_cursor" || !action.position)
    throw new Error("Replay blocked: only recorded pointer movement can be safely repeated.");
  return { recordingId: trace.id, sequence, action:"move_cursor" as const,
    position:{...action.position}, requiresExplicitConfirmation:true };
}
export function resetActionRecordingTestState() { traces.clear(); }
