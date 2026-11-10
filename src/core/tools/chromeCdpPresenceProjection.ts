/**
 * Minimal, read-only Managed CDP presence projection for the authenticated Tray.
 * Explicit allowlist: never serialize the raw lease, capability, credential,
 * page URL, or browser content, even when upstream objects add fields.
 */
type SessionView = {
  transport: "managed";
  port: number;
  targetId: string;
  agentId: string;
  mode: "isolated" | "shared";
  revision: number;
  paused: boolean;
  expiresAt: number;
  lastAction?: { actor: string; event: string; at: number };
  cursors?: Array<{ actorId: string; kind: string; at: number; x?: number; y?: number }>;
  queued: number;
  busy: boolean;
  participants: Array<{ agentId: string; role: "owner" | "observer" | "contributor" }>;
};
const isObject = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const safeAgent = (x: unknown): x is string =>
  typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,95}$/.test(x);
const safeTarget = (x: unknown): x is string =>
  typeof x === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const safeInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const allowedAction = new Set([
  "claim", "renew", "release", "rebind", "share_enabled", "share_disabled",
  "join", "leave", "revoke", "handover", "write_success", "write_failed",
  "write_denied_observer", "write_denied_paused", "paused_by_owner", "resumed_by_owner",
]);
const statusUnknown = () => ({
  observedAt: Date.now(), status: "unknown" as const,
  sessions: [] as SessionView[], truncated: false,
  summary: { agents: 0, tabs: 0, queued: 0, busy: 0 },
});
export function projectManagedCdpPresence(source: unknown, now = Date.now()) {
  if (!isObject(source) || !Array.isArray(source.sessions) ||
      !Array.isArray(source.queue) || !Number.isFinite(now)) return statusUnknown();
  const sessions: SessionView[] = [];
  let truncated = false;
  for (const raw of source.sessions) {
    if (!isObject(raw) || !safeTarget(raw.targetId) || !safeAgent(raw.agentId) ||
        !safeInt(raw.port) || raw.port < 1024 || raw.port > 65535 ||
        !safeInt(raw.revision) || !safeInt(raw.expiresAt) || raw.expiresAt <= now) continue;
    if (sessions.length >= 128) { truncated = true; break; }
    const members = Array.isArray(raw.participants) ? raw.participants : [];
    const participants = members.filter((member: unknown) =>
      isObject(member) && safeAgent(member.agentId) &&
      ["owner", "observer", "contributor"].includes(member.role))
      .slice(0, 24).map((member: any) => ({
        agentId: member.agentId as string,
        role: member.role as "owner" | "observer" | "contributor",
      }));
    const relatedQueue = source.queue.find((item: unknown) => isObject(item) &&
      typeof raw.key === "string" && typeof item.key === "string" &&
      raw.key.slice(0, 16) === item.key);
    const queued = isObject(relatedQueue) && safeInt(relatedQueue.queued)
      ? Math.min(128, relatedQueue.queued) : 0;
    const activity = Array.isArray(source.activity) ? source.activity : [];
    const recent = activity.find((entry: unknown) => isObject(entry) &&
      entry.port === raw.port && entry.targetId === raw.targetId &&
      safeAgent(entry.actor) &&
      (entry.actor === raw.agentId || participants.some(p => p.agentId === entry.actor)) &&
      allowedAction.has(entry.event) && safeInt(entry.at) &&
      entry.at >= now - 3600000 && entry.at <= now + 10000);
    const rawCursors = Array.isArray(source.cursors) ? source.cursors : [];
    const cursors = rawCursors.filter((entry: unknown) => isObject(entry) &&
      entry.port === raw.port && entry.targetId === raw.targetId &&
      safeAgent(entry.actorId) &&
      (entry.actorId === raw.agentId || participants.some(p => p.agentId === entry.actorId)) &&
      ["move", "click", "scroll", "drag", "type"].includes(entry.kind) &&
      safeInt(entry.at) && entry.at >= now - 30000 && entry.at <= now + 10000 &&
      (entry.x === undefined || (Number.isFinite(entry.x) && Math.abs(entry.x) <= 100000)) &&
      (entry.y === undefined || (Number.isFinite(entry.y) && Math.abs(entry.y) <= 100000)))
      .slice(0, 24).map((entry: any) => ({
        actorId: entry.actorId as string, kind: entry.kind as string, at: entry.at as number,
        ...(entry.x !== undefined && entry.y !== undefined
          ? {x:entry.x as number, y:entry.y as number} : {}),
      }));
    sessions.push({
      transport: "managed",
      port: raw.port as number,
      targetId: raw.targetId,
      agentId: raw.agentId,
      mode: raw.mode === "shared" ? "shared" : "isolated",
      revision: raw.revision,
      paused: raw.paused === true,
      expiresAt: raw.expiresAt,
      queued,
      busy: isObject(relatedQueue) && relatedQueue.locked === true,
      participants,
      ...(cursors.length ? { cursors } : {}),
      ...(isObject(recent) ? { lastAction: {
        actor: recent.actor as string, event: recent.event as string, at: recent.at as number,
      } } : {}),
    });
  }
  sessions.sort((a,b) => a.port - b.port || a.targetId.localeCompare(b.targetId));
  return {
    observedAt: now,
    status: "known" as const,
    sessions,
    truncated,
    summary: {
      agents: new Set(sessions.flatMap(s=>[s.agentId,...s.participants.map(p=>p.agentId)])).size,
      tabs: sessions.length,
      queued: sessions.reduce((a,s)=>a+s.queued,0),
      busy: sessions.filter(s=>s.busy).length,
    },
  };
}
