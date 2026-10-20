/** Bounded per-workspace, per-chat SSE journal; not a durable task event ledger. */
import { randomBytes } from "node:crypto";
import type { TlineTaskSnapshot } from "./tlineTaskSnapshot.js";

const generation = randomBytes(8).toString("hex");
const MAX_EVENTS = 64;
const TTL_MS = 10 * 60_000;
const MAX_SCOPES = 64;
const MAX_ACTIVE_STREAMS = 24;
let activeStreams = 0;
export function acquireTaskSseSlot(): (() => void) | null {
  if (activeStreams >= MAX_ACTIVE_STREAMS) return null;
  activeStreams++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeStreams = Math.max(0, activeStreams - 1);
  };
}
export interface TaskFeedEvent {
  id: string;
  event: "snapshot";
  data: TlineTaskSnapshot;
}
type Journal = { events: TaskFeedEvent[]; cursor: string | null; at: number; seq: number };
const journals = new Map<string, Journal>();
function key(workspace: string, sessionId: string): string {
  return JSON.stringify([workspace, sessionId]);
}
export function encodeTlineSse(event: string, data: unknown, id?: string): string {
  return (id ? `id: ${id}\n` : "") + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
export function recordTaskFeed(
  workspace: string, sessionId: string, snapshot: TlineTaskSnapshot,
): TaskFeedEvent | null {
  const now = Date.now();
  for (const [k, journal] of journals) {
    if (now - journal.at > TTL_MS) journals.delete(k);
  }
  const k = key(workspace, sessionId);
  let journal = journals.get(k);
  if (!journal) {
    if (journals.size >= MAX_SCOPES) {
      const oldest = [...journals.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) journals.delete(oldest[0]);
    }
    journal = { events: [], cursor: null, at: now, seq: 0 };
    journals.set(k, journal);
  }
  journal.at = now;
  if (snapshot.cursor === journal.cursor) return null;
  if (!snapshot.changed || !snapshot.tasks) {
    throw new Error("Cannot journal a delta-only task snapshot without task metadata.");
  }
  journal.cursor = snapshot.cursor;
  const entry: TaskFeedEvent = {
    id: `${generation}.${++journal.seq}`,
    event: "snapshot", data: snapshot,
  };
  journal.events.push(entry);
  if (journal.events.length > MAX_EVENTS) journal.events.splice(0, journal.events.length - MAX_EVENTS);
  return entry;
}
export function replayTaskFeed(workspace: string, sessionId: string, lastId?: string): {
  events: TaskFeedEvent[];
  reset: boolean;
} {
  const journal = journals.get(key(workspace, sessionId));
  if (!lastId || !/^[0-9a-f]{16}\.\d{1,12}$/.test(lastId)) {
    return { events: [], reset: true };
  }
  if (!journal || Date.now() - journal.at > TTL_MS) return { events: [], reset: true };
  const index = journal.events.findIndex(e => e.id === lastId);
  if (index < 0) return { events: [], reset: true };
  journal.at = Date.now();
  return { events: journal.events.slice(index + 1), reset: false };
}
export function latestTaskFeed(workspace: string, sessionId: string): TaskFeedEvent | null {
  return journals.get(key(workspace, sessionId))?.events.at(-1) ?? null;
}
export function forgetTaskFeed(workspace?: string, sessionId?: string): void {
  if (workspace && sessionId) journals.delete(key(workspace, sessionId));
  else if (!workspace && !sessionId) journals.clear();
}
