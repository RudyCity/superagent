/**
 * Privacy-preserving, owner-scoped Brain operational metrics.
 * Stores only allowlisted event types, bounded durations and outcome flags.
 * NEVER stores prompts, artifact paths, content, credentials or exception text.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const BRAIN_EVENT_TYPES = [
  "transfer.begin", "transfer.append", "transfer.resume", "transfer.finish",
  "transfer.abort", "transfer.gc", "artifact.import", "artifact.read",
  "artifact.search", "artifact.annotate", "delegate.start", "delegate.promote",
  "cleanup.prepare", "cleanup.confirm", "publish.prepare", "publish.confirm",
] as const;
export type BrainEventType = typeof BRAIN_EVENT_TYPES[number];
type EventOutcome = "ok" | "error";
interface EventRow { at: string; event: BrainEventType; outcome: EventOutcome; durationMs: number }
const ALLOWED = new Set<string>(BRAIN_EVENT_TYPES);
const MAX_EVENTS = 2000;
const MAX_BYTES = 256 * 1024;
function location(principal: string, configRoot: string) {
  if (!principal || principal.length > 2048) throw new Error("Invalid Brain principal.");
  const hash = crypto.createHash("sha256").update(principal).digest("hex").slice(0, 24);
  const dir = path.join(configRoot, "brain-telemetry", hash);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe Brain telemetry directory.");
  return { dir, file: path.join(dir, "events.jsonl") };
}
function boundedDuration(duration: number): number {
  return Number.isFinite(duration) ? Math.min(600000, Math.max(0, Math.round(duration))) : 0;
}
export function recordBrainEvent(
  principal: string, event: string, outcome: EventOutcome,
  durationMs: number, configRoot: string,
): void {
  if (!ALLOWED.has(event) || (outcome !== "ok" && outcome !== "error")) return;
  // Instrumentation must never fail a real Brain operation.
  try {
    const { dir, file } = location(principal, configRoot);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
      if (stat.size > MAX_BYTES) {
        const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-MAX_EVENTS / 2);
        const tmp = path.join(dir, "events-" + crypto.randomBytes(8).toString("hex") + ".tmp");
        try { fs.writeFileSync(tmp, rows.join("\n") + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, file); }
        finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
      }
    }
    const row: EventRow = {
      at: new Date().toISOString(), event: event as BrainEventType,
      outcome, durationMs: boundedDuration(durationMs),
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { encoding: "utf8", flag: "a", mode: 0o600 });
  } catch { /* Telemetry cannot alter user-visible success/failure. */ }
}
export function summarizeBrainEvents(principal: string, configRoot: string) {
  const { dir, file } = location(principal, configRoot);
  if (!fs.existsSync(file)) return { events: 0, failures: 0, types: [], windowDays: 7, incomplete: false };
  if (fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) throw new Error("Invalid Brain telemetry path.");
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid Brain telemetry file.");
  const data = fs.readFileSync(file, "utf8");
  const rows = data.split("\n").filter(Boolean).slice(-MAX_EVENTS);
  const cutoff = Date.now() - 7 * 86400000;
  const groups = new Map<string, { event: string; count: number; failures: number; avgDurationMs: number; maxDurationMs: number }>();
  let total = 0, failures = 0;
  for (const raw of rows) {
    try {
      const row = JSON.parse(raw) as EventRow;
      if (!ALLOWED.has(row.event) || !["ok", "error"].includes(row.outcome) ||
        !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) < cutoff ||
        !Number.isFinite(row.durationMs) || row.durationMs < 0) continue;
      total++;
      if (row.outcome === "error") failures++;
      const prior = groups.get(row.event) ?? { event: row.event, count: 0, failures: 0, avgDurationMs: 0, maxDurationMs: 0 };
      const duration = boundedDuration(row.durationMs);
      prior.avgDurationMs = (prior.avgDurationMs * prior.count + duration) / (prior.count + 1);
      prior.count++;
      prior.failures += row.outcome === "error" ? 1 : 0;
      prior.maxDurationMs = Math.max(prior.maxDurationMs, duration);
      groups.set(row.event, prior);
    } catch { /* Malformed telemetry rows should not break the UI. */ }
  }
  return {
    events: total, failures, windowDays: 7,
    types: [...groups.values()].sort((a,b) => b.count - a.count)
      .map(x => ({...x, avgDurationMs: Math.round(x.avgDurationMs)})),
    incomplete: stat.size > MAX_BYTES || rows.length >= MAX_EVENTS,
  };
}
