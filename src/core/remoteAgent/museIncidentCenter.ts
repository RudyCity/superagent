/**
 * Phase 4n: isolated, owner-port-scoped incident history and opt-in alert outbox.
 * No prompts, batch IDs, credentials, filesystem paths or private payloads in
 * durable state or delivery bodies. Network sends are at-least-once, never
 * exactly-once (a crash after remote acceptance can cause re-delivery).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseRecoveryIntegrityEvents } from "./museRecoveryIntegrityEvents.js";
export type IncidentKind = "integrity" | "host_unavailable";
export type IncidentStatus = "open" | "acknowledged" | "resolved";
type Condition = "degraded" | "failed" | "offline" | "healthy" | "online";
export type Incident = {
  id: string; kind: IncidentKind; port: number; status: IncidentStatus;
  condition: Condition; openedAt: number; updatedAt: number;
  acknowledgedAt?: number; resolvedAt?: number;
};
type Notification = {
  id: string; incidentId: string; condition: Condition; observedAt: number;
  status: "pending" | "sending" | "sent"; attempts: number;
  nextAttemptAt: number; leaseUntil?: number; deliveredAt?: number;
};
type Store = {
  version: 1; port: number; integrityCursor: number;
  incidents: Incident[]; outbox: Notification[];
};
export type IncidentSummary = {
  port: number; open: number; acknowledged: number; resolved: number;
  pending: number; sent: number; lastIncidentAt: number | null;
};
type Target = { type: "webhook"; url: string } |
  { type: "telegram"; token: string; chatId: string };
const LIMIT_INCIDENTS = 250;
const LIMIT_OUTBOX = 512;
const MAX_BYTES = 700_000;
const digestId = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;
const atomic = (file: string, payload: string) => {
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("Incident state capacity exhausted");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
};
function validateEndpoint(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("Invalid alert webhook endpoint"); }
  if (u.protocol !== "https:" || !!u.username || !!u.password || u.port ||
      !u.hostname || u.hostname.length > 253 ||
      u.hostname.toLowerCase() === "localhost" ||
      u.hostname.endsWith(".local") ||
      u.hostname.endsWith(".localhost") ||
      u.hostname.endsWith(".internal") ||
      /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":") ||
      u.hash) throw new Error("Alert webhook requires public HTTPS DNS endpoint without credentials, port or fragment");
  return u.toString();
}
/** Configuration only through explicit environment settings; never written to disk. */
export function configuredIncidentTarget(env: NodeJS.ProcessEnv = process.env): Target | null {
  const url = env.SUPERAGENT_MUSE_ALERT_WEBHOOK_URL;
  const token = env.SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN;
  const chatId = env.SUPERAGENT_MUSE_ALERT_TELEGRAM_CHAT_ID;
  if (url && (token || chatId)) throw new Error("Select exactly one alert provider");
  if (url) return { type: "webhook", url: validateEndpoint(url) };
  if (!token && !chatId) return null;
  if (!token || !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token) ||
      !chatId || !/^-?\d{3,20}$/.test(chatId)) throw new Error("Invalid Telegram alert configuration");
  return { type: "telegram", token, chatId };
}
export function museIncidentsFile(port: number, root = path.join(os.homedir(), ".superagent-r")) {
  if (!validPort(port)) throw new Error("Invalid incident port");
  return path.join(root, "muse-incidents-" + port + ".json");
}
export class MuseIncidentCenter {
  private readonly file: string;
  private readonly lock: string;
  constructor(readonly port: number, readonly root = path.join(os.homedir(), ".superagent-r")) {
    this.file = museIncidentsFile(port, root);
    this.lock = this.file + ".lock";
  }
  private read(): Store {
    if (!fs.existsSync(this.file)) return {
      version: 1, port: this.port, integrityCursor: 0, incidents: [], outbox: [],
    };
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
      throw new Error("Invalid incident storage");
    }
    const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Store;
    if (!data || data.version !== 1 || data.port !== this.port ||
        !Number.isSafeInteger(data.integrityCursor) || data.integrityCursor < 0 ||
        !Array.isArray(data.incidents) || data.incidents.length > LIMIT_INCIDENTS ||
        !Array.isArray(data.outbox) || data.outbox.length > LIMIT_OUTBOX) {
      throw new Error("Invalid incident schema");
    }
    const ids = new Set<string>();
    for (const i of data.incidents) {
      if (!i || typeof i.id !== "string" || !/^[a-f0-9]{32}$/.test(i.id) || ids.has(i.id) ||
          i.port !== this.port || !["integrity", "host_unavailable"].includes(i.kind) ||
          !["open", "acknowledged", "resolved"].includes(i.status) ||
          !["healthy", "online", "offline", "degraded", "failed"].includes(i.condition) ||
          !Number.isSafeInteger(i.openedAt) || i.openedAt <= 0 ||
          !Number.isSafeInteger(i.updatedAt) || i.updatedAt < i.openedAt) {
        throw new Error("Invalid incident record");
      }
      ids.add(i.id);
    }
    const notifyIds = new Set<string>();
    for (const n of data.outbox) {
      if (!n || typeof n.id !== "string" || !/^[a-f0-9]{32}$/.test(n.id) ||
          notifyIds.has(n.id) || !ids.has(n.incidentId) ||
          !["pending", "sending", "sent"].includes(n.status) ||
          !Number.isSafeInteger(n.attempts) || n.attempts < 0 || n.attempts > 100 ||
          !Number.isSafeInteger(n.nextAttemptAt) || n.nextAttemptAt < 0 ||
          !Number.isSafeInteger(n.observedAt) || n.observedAt <= 0 ||
          !["online", "offline", "degraded", "failed", "healthy"].includes(n.condition)) {
        throw new Error("Invalid alert notification");
      }
      notifyIds.add(n.id);
    }
    return data;
  }
  private update<T>(fn: (data: Store) => T): T {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      const data = this.read();
      const answer = fn(data);
      atomic(this.file, JSON.stringify(data));
      return answer;
    } finally { fs.rmSync(this.lock, { force: true }); }
  }
  private transition(s: Store, kind: IncidentKind, condition: Condition,
    observedAt: number, eventId: string): void {
    let incident = [...s.incidents].reverse().find(i => i.kind === kind && i.status !== "resolved");
    const recovered = condition === "healthy" || condition === "online";
    if (recovered && !incident) return;
    if (!incident) {
      if (s.incidents.length >= LIMIT_INCIDENTS) throw new Error("Incident history full");
      incident = {
        id: digestId(this.port + ":" + kind + ":" + eventId),
        kind, port: this.port, status: "open",
        condition, openedAt: observedAt, updatedAt: observedAt,
      };
      s.incidents.push(incident);
    } else {
      incident.condition = condition;
      incident.updatedAt = Math.max(incident.updatedAt, observedAt);
      if (recovered) {
        incident.status = "resolved";
        incident.resolvedAt = observedAt;
      }
    }
    const id = digestId(this.port + ":alert:" + eventId);
    if (!s.outbox.some(n => n.id === id)) {
      if (s.outbox.length >= LIMIT_OUTBOX) throw new Error("Alert queue full; manual export required");
      s.outbox.push({
        id, incidentId: incident.id, condition, observedAt, status: "pending",
        attempts: 0, nextAttemptAt: observedAt,
      });
    }
  }
  /** Reconciles events after a crash, without losing or double-enqueuing events. */
  syncIntegrity(): number {
    const events = new MuseRecoveryIntegrityEvents(this.port, this.root).read();
    if (this.read().integrityCursor === events.length) return 0;
    return this.update(s => {
      if (s.integrityCursor > events.length) throw new Error("Integrity history rollback detected");
      for (const e of events.slice(s.integrityCursor)) {
        this.transition(s, "integrity", e.state, e.observedAt, "integrity:" + e.seq);
      }
      const change = events.length - s.integrityCursor;
      s.integrityCursor = events.length;
      return change;
    });
  }
  /** Dedicated watchdog inputs only; opening/closing is a persisted transition. */
  observeHost(online: boolean, observedAt = Date.now()): void {
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error("Invalid observation time");
    this.update(s => {
      const kind: IncidentKind = "host_unavailable";
      const opened = [...s.incidents].reverse().find(i => i.kind === kind && i.status !== "resolved");
      if ((online && !opened) || (!online && opened)) return;
      this.transition(s, kind, online ? "online" : "offline", observedAt,
        "watchdog:" + (online ? "online:" : "offline:") + (opened?.id || observedAt));
    });
  }
  acknowledge(id: string, confirm: string, at = Date.now()): Incident {
    if (id !== confirm || !/^[0-9a-f]{32}$/.test(id)) throw new Error("Incident ACK requires exact ID confirmation");
    return this.update(s => {
      const incident = s.incidents.find(i => i.id === id);
      if (!incident || incident.status !== "open") throw new Error("Incident is not open");
      incident.status = "acknowledged";
      incident.acknowledgedAt = at;
      incident.updatedAt = Math.max(incident.updatedAt, at);
      return { ...incident };
    });
  }
  list(): Incident[] { return this.read().incidents.map(i => ({ ...i })); }
  summary(): IncidentSummary {
    const s = this.read();
    return {
      port: this.port,
      open: s.incidents.filter(i => i.status === "open").length,
      acknowledged: s.incidents.filter(i => i.status === "acknowledged").length,
      resolved: s.incidents.filter(i => i.status === "resolved").length,
      pending: s.outbox.filter(n => n.status !== "sent").length,
      sent: s.outbox.filter(n => n.status === "sent").length,
      lastIncidentAt: s.incidents.at(-1)?.updatedAt || null,
    };
  }
  /** A per-item lease survives crashes and avoids two workers sending at once. */
  claim(now = Date.now()): (Notification & { port: number; kind: IncidentKind }) | null {
    // Avoid unnecessary fsync/renames on every periodic idle delivery tick.
    if (!this.read().outbox.some(n => n.status !== "sent" && n.nextAttemptAt <= now &&
        (n.status !== "sending" || (n.leaseUntil ?? 0) <= now) &&
        n.attempts < 100)) return null;
    return this.update(s => {
      const item = s.outbox.find(n => n.status !== "sent" && n.nextAttemptAt <= now &&
        (n.status !== "sending" || (n.leaseUntil ?? 0) <= now));
      if (!item) return null;
      if (item.attempts >= 100) return null;
      item.status = "sending";
      item.attempts++;
      item.leaseUntil = now + 30_000;
      item.nextAttemptAt = now;
      const incident = s.incidents.find(i => i.id === item.incidentId)!;
      return { ...item, port: this.port, kind: incident.kind };
    });
  }
  complete(id: string, ok: boolean, now = Date.now()) {
    this.update(s => {
      const item = s.outbox.find(n => n.id === id);
      if (!item || item.status !== "sending") throw new Error("Unknown alert lease");
      if (ok) {
        item.status = "sent";
        item.deliveredAt = now;
        delete item.leaseUntil;
      } else {
        item.status = "pending";
        delete item.leaseUntil;
        // bounded exponential retry 2s..30m with deterministic jitter.
        const delay = Math.min(1_800_000, 2000 * 2 ** Math.min(item.attempts - 1, 10));
        item.nextAttemptAt = now + delay + parseInt(item.id.slice(0, 4), 16) % 1000;
      }
    });
  }
}
/** Redacted transport payload independent of any encrypted recovery data. */
export async function sendIncidentAlert(item: {
  id: string; port: number; kind: IncidentKind; condition: Condition; observedAt: number;
}, target: Target, fetcher: typeof fetch = fetch): Promise<boolean> {
  const event = { version: 1, event_id: item.id, port: item.port, kind: item.kind,
    condition: item.condition, observed_at: item.observedAt };
  try {
    const response = target.type === "webhook"
      ? await fetcher(target.url, {
          method: "POST", headers: { "Content-Type": "application/json",
            "Idempotency-Key": item.id },
          body: JSON.stringify(event), redirect: "error", signal: AbortSignal.timeout(5000),
        })
      : await fetcher("https://api.telegram.org/bot" + target.token + "/sendMessage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: target.chatId,
            text: "SuperAgent recovery alert\n" + JSON.stringify(event),
            disable_web_page_preview: true }),
          redirect: "error", signal: AbortSignal.timeout(5000),
        });
    return response.ok;
  } catch { return false; } // NEVER expose request, endpoint or credential errors
}
export class MuseIncidentDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly center: MuseIncidentCenter,
    private readonly target: Target | null = configuredIncidentTarget(),
    private readonly fetcher: typeof fetch = fetch) {}
  async once(): Promise<boolean> {
    if (!this.target) return false; // disabled: retain pending until enabled
    const item = this.center.claim();
    if (!item) return false;
    const ok = await sendIncidentAlert(item, this.target, this.fetcher);
    this.center.complete(item.id, ok);
    return ok;
  }
  start(intervalMs = 5000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // No overlapping sends by this worker. Other workers honor leases.
      if (this.busy) return;
      this.busy = true;
      void (async () => {
        try { this.center.syncIntegrity(); } catch { /* try again next polling tick */ }
        await this.once();
      })().catch(() => {}).finally(() => { this.busy = false; });
    }, intervalMs);
    this.timer.unref?.();
  }
  private busy = false;
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
