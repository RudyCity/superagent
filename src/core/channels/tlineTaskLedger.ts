/**
 * Bounded local persistence for *observed* T-Line task snapshots only.
 * NOT a source-native task transition ledger. Files never contain workspace
 * paths, chat session IDs, shell output, prompt text, credentials or task logs.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import type { TaskFeedEvent } from "./tlineTaskFeed.js";

export const TLINE_LEDGER_MAX_EVENTS = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 64;
const MAX_AGE_MS = 24 * 60 * 60_000;
const EVENT_ID = /^[a-f0-9]{16}\.\d{1,12}$/;
let testRoot: string | undefined;

export type PersistedTaskFeed = {
  version: 1;
  scope: string;
  generation: string;
  seq: number;
  savedAt: number;
  events: TaskFeedEvent[];
};

export function setTlineLedgerRootForTests(root?: string) { testRoot = root; }

function ledgerRoot() {
  return testRoot || path.join(getRootConfigDir(), "tline-task-ledger");
}
export function tlineLedgerScope(workspace: string, sessionId: string) {
  return createHash("sha256").update(JSON.stringify([workspace, sessionId])).digest("hex");
}
function filePath(scope: string) {
  return path.join(ledgerRoot(), scope + ".json");
}
function secureDir() {
  fs.mkdirSync(ledgerRoot(), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(ledgerRoot()).isSymbolicLink()) throw new Error("Task ledger directory cannot be a symlink.");
}
function plausibleEvent(ev: any): ev is TaskFeedEvent {
  return ev && ev.event === "snapshot" && typeof ev.id === "string" && EVENT_ID.test(ev.id) &&
    ev.data?.success === true && ev.data?.schemaVersion === 1 &&
    ev.data?.scope === "workspace" && ev.data?.source === "bounded-polling" &&
    ev.data?.replaySupported === false &&
    Array.isArray(ev.data.tasks) && ev.data.tasks.length <= 60 &&
    /^[a-f0-9]{64}$/.test(ev.data.cursor);
}
export function loadTlineTaskLedger(workspace: string, sessionId: string): PersistedTaskFeed | null {
  const scope = tlineLedgerScope(workspace, sessionId);
  try {
    const file = filePath(scope);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedTaskFeed;
    if (parsed.version !== 1 || parsed.scope !== scope ||
      !/^[a-f0-9]{16}$/.test(parsed.generation) ||
      !Number.isSafeInteger(parsed.seq) || parsed.seq < 0 ||
      !Number.isFinite(parsed.savedAt) ||
      Date.now() - parsed.savedAt > MAX_AGE_MS ||
      parsed.savedAt > Date.now() + 60_000 ||
      !Array.isArray(parsed.events) || parsed.events.length > TLINE_LEDGER_MAX_EVENTS ||
      !parsed.events.every(plausibleEvent) ||
      parsed.events.some((event, i, events) =>
        event.id.split(".")[0] !== parsed.generation ||
        (i > 0 && Number(event.id.split(".")[1]) <= Number(events[i - 1].id.split(".")[1])))) {
      return null;
    }
    return parsed;
  } catch { return null; }
}
export function saveTlineTaskLedger(
  workspace: string, sessionId: string, generation: string, seq: number, events: TaskFeedEvent[],
): boolean {
  const scope = tlineLedgerScope(workspace, sessionId);
  if (!/^[a-f0-9]{16}$/.test(generation) ||
    !Number.isSafeInteger(seq) || seq < 0 ||
    events.length > TLINE_LEDGER_MAX_EVENTS || !events.every(plausibleEvent)) return false;
  // Projection is explicit: unexpected future source fields must never leak to disk.
  const safeEvents: TaskFeedEvent[] = events.map(ev => ({
    id: ev.id, event: "snapshot",
    data: {
      success: true, schemaVersion: 1, scope: "workspace", source: "bounded-polling",
      changed: true, cursor: ev.data.cursor, total: ev.data.total,
      incompleteSources: ev.data.incompleteSources.filter(item => typeof item === "string").slice(0, 8),
      replaySupported: false,
      tasks: ev.data.tasks!.map(task => ({
        schemaVersion: 1, channel: task.channel, taskId: String(task.taskId).slice(0, 160),
        sessionId: null, status: task.status, evidence: task.evidence,
        authorization: task.authorization, notification: task.notification, updatedAt: task.updatedAt,
      })),
    },
  }));
  const payload = JSON.stringify({
    version: 1, scope, generation, seq, savedAt: Date.now(), events: safeEvents,
  } satisfies PersistedTaskFeed);
  if (Buffer.byteLength(payload) > MAX_FILE_BYTES) return false;
  let temp: string | undefined;
  try {
    secureDir();
    const file = filePath(scope);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return false;
    temp = path.join(ledgerRoot(), scope + "." + randomBytes(6).toString("hex") + ".tmp");
    fs.writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    temp = undefined;
    // Bounded global persistence: only retain the 64 most recently updated scopes.
    const entries = fs.readdirSync(ledgerRoot()).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => {
        try { return { name, stat: fs.lstatSync(path.join(ledgerRoot(), name)) }; }
        catch { return null; }
      }).filter((entry): entry is {name: string; stat: fs.Stats} => !!entry && entry.stat.isFile());
    entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const entry of entries.slice(MAX_FILES)) {
      try { fs.unlinkSync(path.join(ledgerRoot(), entry.name)); } catch {}
    }
    return true;
  } catch { return false; }
  finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
}
export function deleteTlineTaskLedger(workspace: string, sessionId: string) {
  try {
    const file = filePath(tlineLedgerScope(workspace, sessionId));
    if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
  } catch {}
}
