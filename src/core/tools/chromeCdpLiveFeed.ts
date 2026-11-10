/**
 * Bounded live managed-CDP change feed for an authenticated native Tray.
 * Long-polling avoids exposing the Core bearer token to webview JavaScript.
 * The cursor is a digest of strictly projected data, not page contents.
 */
import { createHash } from "node:crypto";
import { cdpCoordinatorStatus } from "./chromeCdpSessionManager.js";
import { projectManagedCdpPresence } from "./chromeCdpPresenceProjection.js";
import { listManagedBrowserRegistrations } from "./managedBrowserRegistry.js";
import { readManagedControlStatus } from "./managedBrowserControl.js";
import { listPendingReplayApprovals } from "./chromeCdpReplayApprovals.js";

export type ManagedCdpLiveSnapshot = Awaited<ReturnType<typeof currentManagedCdpLiveSnapshot>>;
export const MAX_CDP_LIVE_CONNECTIONS = 6;
let liveConnections = 0;
export function activeManagedCdpLiveConnections() { return liveConnections; }

export async function currentManagedCdpLiveSnapshot() {
  const projected = projectManagedCdpPresence(await cdpCoordinatorStatus());
  if (projected.status !== "known") return projected;
  const managed = new Set(listManagedBrowserRegistrations().map(r => r.port + ":" + r.targetId));
  const sessions = await Promise.all(projected.sessions.map(async session => {
    const registered = managed.has(session.port + ":" + session.targetId);
    let humanControl: "human" | "agent" | "unknown" = "unknown";
    if (registered) {
      try { humanControl = await readManagedControlStatus(session.port, session.targetId); }
      catch { humanControl = "unknown"; }
    }
    return { ...session, registered, humanControl };
  }));
  return { ...projected, sessions,
    replayApprovals: await listPendingReplayApprovals() };
}

export function managedCdpLiveDigest(snapshot: unknown): string {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown> : {};
  // observedAt changes on every poll and must not force artificial events.
  const { observedAt: _ignored, ...stable } = source;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
export async function watchManagedCdpLive(
  since: string | null, opts: {
    waitMs?: number; signal?: AbortSignal;
    read?: () => Promise<ManagedCdpLiveSnapshot>;
  } = {},
): Promise<{status:"changed"|"heartbeat";cursor:string;managedCdp:ManagedCdpLiveSnapshot}> {
  if (since !== null && !/^[a-f0-9]{64}$/.test(since))
    throw new Error("Invalid live feed cursor.");
  if (liveConnections >= MAX_CDP_LIVE_CONNECTIONS)
    throw new Error("Live feed subscriber capacity reached.");
  liveConnections++;
  try {
    const read = opts.read ?? currentManagedCdpLiveSnapshot;
    const waitMs = Math.max(0, Math.min(10000, Math.floor(opts.waitMs ?? 8500)));
    const deadline = Date.now() + waitMs;
    while (true) {
      if (opts.signal?.aborted) throw new Error("Live feed disconnected.");
      const managedCdp = await read();
      const cursor = managedCdpLiveDigest(managedCdp);
      if (!since || since !== cursor)
        return { status:"changed", cursor, managedCdp };
      if (Date.now() >= deadline)
        return { status:"heartbeat", cursor, managedCdp };
      await new Promise<void>((resolve, reject) => {
        const delay = Math.max(1, Math.min(250, deadline - Date.now()));
        const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
        const onAbort = () => { cleanup(); reject(new Error("Live feed disconnected.")); };
        function cleanup() { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); }
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener("abort", onAbort, { once:true });
      });
    }
  } finally { liveConnections--; }
}
