/**
 * Shared, fail-closed CDP coordinator. Cross-process via atomic mkdir and
 * credential-backed leases; no browser data or plaintext capabilities on disk.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";

const TTL_MS = 5 * 60_000;
const MEMBER_TTL_MS = 2 * 60_000;
const STALE_MS = 120_000;
const dir = () => process.env.SUPERAGENT_CDP_SESSION_DIR || join(homedir(), ".superagent-r", "cdp-sessions");
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const keyFor = (port: number, targetId: string) => sha(port + ":" + targetId);
const fileFor = (key: string) => join(dir(), "owners", key + ".json");
const lockFor = (key: string) => join(dir(), "locks", key + ".lock");
const queueFor = (key: string) => join(dir(), "queues", key);
const BROWSER_LIFECYCLE_KEY = sha("browser-lifecycle-global-v1");
const browserBridgeScope = new AsyncLocalStorage<boolean>();
const browserLifecycleScope = new AsyncLocalStorage<boolean>();
const cdpExecutionScope = new AsyncLocalStorage<{ revision: number; mode: "isolated" | "shared" }>();
export const getCdpExecutionState = () => cdpExecutionScope.getStore();
const PRIORITY_AGING_MS = 12_000;
const MAX_QUEUE_ENTRIES = 128;
const auditPath = () => join(dir(), "events.jsonl");
const validAgent = (value: string) => {
  if (["__proto__", "constructor", "prototype"].includes(value) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,95}$/.test(value)) throw new Error("Invalid CDP agentId.");
};
function validate(port: number, targetId: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CDP port.");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetId)) throw new Error("CDP targetId must be explicit and valid.");
}
async function audit(event: string, key: string, actor?: string): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await appendFile(auditPath(), JSON.stringify({ time: new Date().toISOString(), event, key: key.slice(0, 16), actor: actor || "legacy" }) + "\n").catch(() => {});
}
export type CdpParticipantRole = "observer" | "contributor";
type CdpMember = { role: CdpParticipantRole; tokenHash: string; joinedAt: number; expiresAt?: number };
type CdpInvitation = { agentId: string; role: CdpParticipantRole; tokenHash: string; expiresAt: number };
export type CdpSession = {
  key: string; port: number; targetId: string; agentId: string;
  claimedAt: number; expiresAt: number; tokenHash: string; generation: string;
  mode?: "shared"; members?: Record<string, CdpMember>; invitations?: Record<string, CdpInvitation>; revision?: number;
};
export type CdpPublicSession = Omit<CdpSession, "tokenHash" | "members" | "invitations" | "mode"> & {
  mode: "isolated" | "shared"; revision: number;
  participants: Array<{ agentId: string; role: "owner" | CdpParticipantRole; joinedAt: number }>;
};
export type CdpClaim = CdpPublicSession & { sessionToken: string };
export type CdpAccess = { agentId?: string; sessionToken?: string; waitMs?: number; priority?: number; signal?: AbortSignal; ownerOnly?: boolean; sharedOnly?: boolean; expectedRevision?: number };
async function load(key: string): Promise<CdpSession | null> {
  try {
    const data = JSON.parse(await readFile(fileFor(key), "utf8"));
    if (data.key !== key || !Number.isFinite(data.expiresAt) || typeof data.agentId !== "string" || typeof data.tokenHash !== "string") {
      throw new Error("Invalid CDP lease metadata.");
    }
    return data;
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw new Error("Corrupt CDP owner state: access denied until repaired.");
  }
}
async function save(session: CdpSession): Promise<void> {
  await mkdir(join(dir(), "owners"), { recursive: true });
  const tmp = fileFor(session.key) + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(session), { mode: 0o600, flag: "wx" });
    await rename(tmp, fileFor(session.key));
  } finally { await rm(tmp, { force: true }).catch(() => {}); }
}
async function lock(key: string, opts: CdpAccess = {}): Promise<() => Promise<void>> {
  await mkdir(join(dir(), "locks"), { recursive: true });
  await mkdir(queueFor(key), { recursive: true });
  const token = randomUUID();
  const boundedWait = Math.max(0, Math.min(120000, Number(opts.waitMs ?? 8000) || 0));
  const deadline = Date.now() + boundedWait;
  const priority = Math.max(0, Math.min(9, Math.floor(Number(opts.priority ?? 5) || 0)));
  const request = join(queueFor(key), token + ".json");
  if ((await readdir(queueFor(key))).length >= MAX_QUEUE_ENTRIES)
    throw new Error("CDP target queue capacity reached.");
  // Files are named randomly; priority ordering relies on persisted timestamp.
  await writeFile(request, JSON.stringify({ token, priority, at: Date.now(), pid: process.pid }), { flag: "wx" });
  // Filesystem events wake queued agents when another process releases its
  // request. Bounded fallback handles dropped fs.watch events on Windows.
  let watcher: FSWatcher | undefined;
  let wake: (() => void) | undefined;
  try { watcher = watch(queueFor(key), () => wake?.()); watcher.on("error", () => {}); }
  catch { /* fallback to bounded polling */ }
  try {
    while (true) {
      if (opts.signal?.aborted) throw new Error("CDP action cancelled.");
      const entries = await readdir(queueFor(key));
      const waiting = await Promise.all(entries.filter(e => e.endsWith(".json")).map(async name => {
        try {
          const file = join(queueFor(key), name);
          const pending = JSON.parse(await readFile(file, "utf8"));
          const elapsed = Date.now() - Number(pending.at);
          if (!Number.isInteger(pending.pid) || !Number.isFinite(elapsed)) return null;
          let alive = true;
          try { process.kill(pending.pid, 0); } catch (e: any) { alive = e.code === "EPERM"; }
          if (!alive && elapsed > 1000) {
            await rm(file, { force: true });
            return null;
          }
          return pending;
        } catch { return null; }
      }));
      const effectivePriority = (item: any) =>
        Math.max(0, item.priority - Math.floor(Math.max(0, Date.now() - item.at) / PRIORITY_AGING_MS));
      const first = waiting.filter(Boolean).sort((a, b) =>
        effectivePriority(a) - effectivePriority(b) || a.at - b.at || a.token.localeCompare(b.token))[0];
      if (first?.token === token) {
        const path = lockFor(key);
        try {
          await mkdir(path);
          try {
            await writeFile(join(path, "owner.json"), JSON.stringify({ token, pid: process.pid, at: Date.now() }), { flag: "wx" });
          } catch (e) { await rm(path, { recursive: true, force: true }); throw e; }
          await rm(request, { force: true });
          const heartbeat = setInterval(() => { writeFile(join(path, "heartbeat"), String(Date.now())).catch(() => {}); }, 10000);
          heartbeat.unref?.();
          return async () => {
            clearInterval(heartbeat);
            try {
              const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
              if (owner.token === token) await rm(path, { recursive: true, force: true });
            } catch { /* already gone */ }
          };
        } catch (e: any) {
          if (e.code !== "EEXIST") throw e;
          try {
            const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
            const heartbeat = await stat(join(path, "heartbeat")).catch(() => stat(join(path, "owner.json")));
            const age = Date.now() - heartbeat.mtimeMs;
            let alive = true;
            try { process.kill(owner.pid, 0); } catch (err: any) { alive = err.code === "EPERM"; }
            // Never steal a lock from a live process, regardless of wall time.
            if (age > STALE_MS && !alive) {
              const check = await stat(join(path, "heartbeat")).catch(() => stat(join(path, "owner.json")));
              if (check.mtimeMs === heartbeat.mtimeMs) {
                const stale = path + ".stale-" + randomUUID();
                await rename(path, stale);
                await rm(stale, { recursive: true, force: true });
                await audit("lock_recovered", key);
              }
            }
          } catch {
            // The previous owner may have died immediately after mkdir.
            try {
              const st = await stat(path);
              if (Date.now() - st.mtimeMs > STALE_MS) {
                const moved = path + ".orphan-" + randomUUID();
                await rename(path, moved);
                await rm(moved, { recursive: true, force: true });
              }
            } catch { /* recovery race */ }
          }
        }
      }
      if (Date.now() >= deadline) throw new Error("CDP target busy: timed out in target queue.");
      await new Promise<void>(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", finish);
          if (wake === finish) wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, Math.min(200, Math.max(1, deadline - Date.now())));
        wake = finish;
        opts.signal?.addEventListener("abort", finish, { once: true });
      });
    }
  } finally {
    watcher?.close();
    await rm(request, { force: true }).catch(() => {});
  }
}
async function guarded<T>(port: number, targetId: string, opts: CdpAccess, fn: (key: string) => Promise<T>) {
  validate(port, targetId);
  const key = keyFor(port, targetId);
  const done = await lock(key, opts);
  try { return await fn(key); } finally { await done(); }
}
function validCapability(supplied: string | undefined, hash: string): boolean {
  if (!supplied || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(sha(supplied), "hex"));
}
function auth(session: CdpSession, access: CdpAccess): "owner" | CdpParticipantRole {
  if (session.expiresAt <= Date.now()) throw new Error("CDP session expired.");
  if (!access.agentId) throw new Error("CDP target claimed: valid agentId AND sessionToken required.");
  if (session.agentId === access.agentId && validCapability(access.sessionToken, session.tokenHash)) return "owner";
  const member = session.mode === "shared" ? session.members?.[access.agentId] : undefined;
  if (!access.ownerOnly && member && (member.expiresAt ?? session.expiresAt) > Date.now() && validCapability(access.sessionToken, member.tokenHash)) return member.role;
  throw new Error("CDP target claimed: valid agentId AND sessionToken required.");
}
const issue = () => randomBytes(32).toString("base64url");
export async function claimCdpTarget(port: number, targetId: string, agentId: string, sessionToken?: string): Promise<CdpClaim> {
  validAgent(agentId);
  return withBrowserLifecycleMutex(() => guarded(port, targetId, {}, async key => {
    const previous = await load(key);
    if (previous && previous.expiresAt > Date.now()) {
      auth(previous, { agentId, sessionToken, ownerOnly: true });
      const next = { ...previous, expiresAt: Date.now() + TTL_MS };
      await save(next);
      await audit("renew", key, agentId);
      return { ...publicSession(next), sessionToken: sessionToken! };
    }
    const token = issue();
    const now = Date.now();
    const session: CdpSession = {
      key, port, targetId, agentId, claimedAt: now, expiresAt: now + TTL_MS,
      tokenHash: sha(token), generation: randomUUID(), revision: 0,
    };
    await save(session);
    await audit(previous ? "reclaim_expired" : "claim", key, agentId);
    return { ...publicSession(session), sessionToken: token };
  }));
}
export async function releaseCdpTarget(port: number, targetId: string, agentId: string, sessionToken?: string): Promise<void> {
  validAgent(agentId);
  await guarded(port, targetId, {}, async key => {
    const session = await load(key);
    if (session && session.expiresAt > Date.now()) auth(session, { agentId, sessionToken, ownerOnly: true });
    await rm(fileFor(key), { force: true });
    await audit("release", key, agentId);
  });
}
function publicSession(session: CdpSession): CdpPublicSession {
  return {
    key: session.key, port: session.port, targetId: session.targetId,
    agentId: session.agentId, claimedAt: session.claimedAt,
    expiresAt: session.expiresAt, generation: session.generation,
    mode: session.mode === "shared" ? "shared" : "isolated", revision: session.revision ?? 0,
    participants: [
      { agentId: session.agentId, role: "owner", joinedAt: session.claimedAt },
      ...(session.mode === "shared" ? Object.entries(session.members || {})
        .filter(([, member]) => (member.expiresAt ?? session.expiresAt) > Date.now())
        .map(([agentId, member]) => ({ agentId, role: member.role, joinedAt: member.joinedAt })) : []),
    ],
  };
}
/** Rebind an active, credential-authenticated lease to a specifically selected new tab.
 * Chrome may replace targetId after a renderer/browser restart; we never pick an
 * arbitrary replacement or recover another agent's existing target. */
export async function rebindCdpTarget(
  port: number, previousTargetId: string, nextTargetId: string,
  agentId: string, sessionToken: string
): Promise<CdpClaim> {
  validate(port, previousTargetId);
  validate(port, nextTargetId);
  validAgent(agentId);
  if (previousTargetId === nextTargetId) throw new Error("New target must differ from the previous target.");
  return withBrowserLifecycleMutex(() => guarded(port, previousTargetId, {}, async oldKey => {
    const previous = await load(oldKey);
    if (!previous || previous.expiresAt <= Date.now()) throw new Error("Old CDP lease has expired. Claim the new target explicitly.");
    auth(previous, { agentId, sessionToken, ownerOnly: true });
    const next = await claimCdpTarget(port, nextTargetId, agentId);
    await rm(fileFor(oldKey), { force: true });
    await audit("rebind", oldKey, agentId);
    return next;
  }));
}

/** Sharing is opt-in. Disabling sharing revokes all member and invite capabilities. */
export async function setCdpSharing(
  port: number, targetId: string, agentId: string, sessionToken: string, enabled: boolean,
): Promise<CdpPublicSession> {
  validAgent(agentId);
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s) throw new Error("Claim the CDP target before sharing.");
    auth(s, { agentId, sessionToken, ownerOnly: true });
    const next: CdpSession = enabled
      ? { ...s, mode: "shared", members: s.members || {}, invitations: s.invitations || {} }
      : { ...s, mode: undefined, members: undefined, invitations: undefined };
    await save(next);
    await audit(enabled ? "share_enabled" : "share_disabled", key, agentId);
    return publicSession(next);
  });
}
/** Owner-issued, single-use invitation credential for a named agent. */
export async function inviteCdpAgent(
  port: number, targetId: string, ownerId: string, ownerToken: string,
  memberId: string, role: CdpParticipantRole,
): Promise<{ inviteId: string; invitationToken: string; expiresAt: number; agentId: string; role: CdpParticipantRole }> {
  validAgent(ownerId); validAgent(memberId);
  if (role !== "observer" && role !== "contributor") throw new Error("Invalid shared tab role.");
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s) throw new Error("CDP tab not claimed.");
    auth(s, { agentId: ownerId, sessionToken: ownerToken, ownerOnly: true });
    if (s.mode !== "shared") throw new Error("Enable shared mode first.");
    if (memberId === s.agentId || s.members?.[memberId]) throw new Error("Agent already owns or joined the tab.");
    s.invitations = Object.fromEntries(Object.entries(s.invitations || {}).filter(([, item]) => item.expiresAt > Date.now()));
    if (Object.keys(s.members || {}).length >= 12 || Object.keys(s.invitations || {}).length >= 12)
      throw new Error("Shared tab participant/invitation limit reached.");
    const invitationToken = issue(), inviteId = randomUUID();
    const expiresAt = Math.min(s.expiresAt, Date.now() + 120_000);
    s.invitations = { ...(s.invitations || {}), [inviteId]: { agentId: memberId, role, tokenHash: sha(invitationToken), expiresAt } };
    await save(s);
    await audit("invite_" + role, key, ownerId);
    return { inviteId, invitationToken, expiresAt, agentId: memberId, role };
  });
}
export async function joinCdpTarget(
  port: number, targetId: string, agentId: string, inviteId: string, invitationToken: string,
): Promise<CdpClaim & { role: CdpParticipantRole }> {
  validAgent(agentId);
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s || s.mode !== "shared" || s.expiresAt <= Date.now()) throw new Error("No active shared CDP session.");
    const invitation = s.invitations?.[inviteId];
    if (!invitation || invitation.agentId !== agentId || invitation.expiresAt <= Date.now() ||
        !validCapability(invitationToken, invitation.tokenHash)) throw new Error("Invalid or expired shared tab invitation.");
    if (s.members?.[agentId]) throw new Error("Agent already joined this tab.");
    const memberToken = issue();
    s.members = { ...(s.members || {}), [agentId]: { role: invitation.role, tokenHash: sha(memberToken), joinedAt: Date.now(), expiresAt: Math.min(s.expiresAt, Date.now() + MEMBER_TTL_MS) } };
    delete s.invitations![inviteId];
    await save(s);
    await audit("join_" + invitation.role, key, agentId);
    return { ...publicSession(s), sessionToken: memberToken, role: invitation.role };
  });
}

export async function leaveCdpTarget(port: number, targetId: string, agentId: string, sessionToken: string): Promise<void> {
  validAgent(agentId);
  await guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s || s.mode !== "shared" || !s.members?.[agentId]) throw new Error("Agent is not a shared tab participant.");
    auth(s, { agentId, sessionToken });
    delete s.members[agentId];
    await save(s);
    await audit("leave", key, agentId);
  });
}
export async function revokeCdpAgent(
  port: number, targetId: string, ownerId: string, ownerToken: string, memberId: string,
): Promise<CdpPublicSession> {
  validAgent(memberId);
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s || s.mode !== "shared") throw new Error("No active shared CDP session.");
    auth(s, { agentId: ownerId, sessionToken: ownerToken, ownerOnly: true });
    if (!s.members?.[memberId]) throw new Error("Agent is not joined.");
    delete s.members[memberId];
    await save(s);
    await audit("revoke", key, ownerId);
    return publicSession(s);
  });
}
/** Promote a joined contributor without leaking their credential to the old owner.
 * The old owner's token is invalidated immediately under the tab lock. */
export async function handoverCdpTarget(
  port: number, targetId: string, ownerId: string, ownerToken: string, memberId: string,
): Promise<CdpPublicSession> {
  validAgent(memberId);
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s || s.mode !== "shared") throw new Error("No active shared CDP session.");
    auth(s, { agentId: ownerId, sessionToken: ownerToken, ownerOnly: true });
    const target = s.members?.[memberId];
    if (!target || target.role !== "contributor") throw new Error("Handover requires a joined contributor.");
    delete s.members![memberId];
    s.agentId = memberId; s.tokenHash = target.tokenHash;
    // Invitations from the former owner must not survive transfer of authority.
    s.invitations = {};
    s.claimedAt = Date.now(); s.generation = randomUUID();
    await save(s);
    await audit("handover", key, ownerId);
    return publicSession(s);
  });
}
/** Explicit short-lived heartbeat. A guest renews only their own membership. */
export async function heartbeatCdpSession(
  port: number, targetId: string, agentId: string, sessionToken: string,
): Promise<{ agentId: string; role: "owner" | CdpParticipantRole; expiresAt: number }> {
  validAgent(agentId);
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s) throw new Error("CDP claim required.");
    const role = auth(s, { agentId, sessionToken });
    if (role === "owner") {
      s.expiresAt = Date.now() + TTL_MS;
    } else {
      const member = s.members![agentId];
      member.expiresAt = Math.min(s.expiresAt, Date.now() + MEMBER_TTL_MS);
    }
    await save(s);
    await audit("heartbeat_" + role, key, agentId);
    return { agentId, role, expiresAt: role === "owner" ? s.expiresAt : s.members![agentId].expiresAt! };
  });
}
export async function getCdpParticipation(
  port: number, targetId: string, agentId: string, sessionToken: string,
): Promise<CdpPublicSession> {
  validAgent(agentId);
  return guarded(port, targetId, {}, async key => {
    const s = await load(key);
    if (!s || s.expiresAt <= Date.now()) throw new Error("CDP session not active.");
    auth(s, { agentId, sessionToken });
    return publicSession(s);
  });
}

export async function listCdpSessions(): Promise<CdpPublicSession[]> {
  try {
    const entries = await readdir(join(dir(), "owners"));
    const sessions = await Promise.all(entries.filter(e => /^[a-f0-9]{64}\.json$/.test(e)).map(e => load(e.slice(0, -5))));
    return sessions.filter((s): s is CdpSession => !!s && s.expiresAt > Date.now()).map(publicSession);
  } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
}
/** Serialize pending cross-IDE approvals across independent Bun/MCP processes.
 * The lock uses the existing cross-process filesystem queue and never grants CDP access itself. */
export async function withCdpGatewayRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const done = await lock(sha("cross-ide-cdp-registry-v1"), { waitMs: 12000 });
  try { return await fn(); } finally { await done(); }
}
export const cdpGatewayRoot = () => join(dir(), "gateway");
export async function withCdpTargetRead<T>(port: number, targetId: string, opts: CdpAccess, fn: () => Promise<T>): Promise<T> {
  return guarded(port, targetId, opts, async key => {
    const current = await load(key);
    if (current && current.expiresAt > Date.now()) {
      const role = auth(current, opts);
      if (opts.sharedOnly && current.mode !== "shared") throw new Error("Shared snapshot requires shared mode.");
      if (role === "owner") await save({ ...current, expiresAt: Date.now() + TTL_MS });
    } else if (current || opts.sharedOnly || opts.agentId) {
      throw new Error("CDP read denied: expired or unclaimed tab; claim target explicitly.");
    }
    return cdpExecutionScope.run({ revision: current?.revision ?? 0, mode: current?.mode === "shared" ? "shared" : "isolated" }, fn);
  });
}
export async function withCdpTargetWrite<T>(
  port: number, targetId: string, agentId: string | undefined, fn: () => Promise<T>, options: Omit<CdpAccess, "agentId"> = {}
): Promise<T> {
  if (agentId !== undefined) validAgent(agentId);
  return guarded(port, targetId, { ...options, agentId }, async key => {
    const current = await load(key);
    if (current && current.expiresAt > Date.now()) {
      const role = auth(current, { ...options, agentId });
      if (role === "observer") {
        await audit("write_denied_observer", key, agentId);
        throw new Error("CDP observer cannot modify tab.");
      }
      if (options.expectedRevision !== undefined && (current.revision ?? 0) !== options.expectedRevision)
        throw new Error("CDP stale revision: refresh snapshot and retry.");
      if (role === "owner") await save({ ...current, expiresAt: Date.now() + TTL_MS });
    } else if (agentId || current) {
      // Mutations never silently create a session; claim first.
      throw new Error("No active CDP claim for agent. Run claim_target.");
    }
    try {
      const result = await cdpExecutionScope.run({
        revision: current?.revision ?? 0, mode: current?.mode === "shared" ? "shared" : "isolated",
      }, fn);
      if (current && current.expiresAt > Date.now()) {
        const after = await load(key);
        if (after && after.generation === current.generation)
          await save({ ...after, revision: (after.revision ?? 0) + 1 });
      }
      await audit("write_success", key, agentId);
      return result;
    } catch (e) { await audit("write_failed", key, agentId); throw e; }
  });
}
export async function cdpCoordinatorStatus(port?: number): Promise<{
  sessions: CdpPublicSession[];
  queue: Array<{ key: string; queued: number; locked: boolean; oldestWaitMs: number; port?: number; targetId?: string }>;
  summary: { activeAgents: number; activeTabs: number; queued: number; busyTargets: number; extensionBlocked: boolean };
}> {
  const sessions = (await listCdpSessions()).filter(s => port === undefined || s.port === port);
  const queue: Array<{ key: string; queued: number; locked: boolean; oldestWaitMs: number; port?: number; targetId?: string }> = [];
  const now = Date.now();
  try {
    for (const key of await readdir(join(dir(), "queues"))) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      let files: string[];
      try { files = (await readdir(queueFor(key))).filter(x => x.endsWith(".json")).slice(0, 512); }
      catch { continue; }
      let queued = 0, earliest = now;
      for (const name of files) {
        try {
          const request = JSON.parse(await readFile(join(queueFor(key), name), "utf8"));
          if (typeof request.at === "number" && request.at <= now && now - request.at <= 120_000) {
            queued++;
            earliest = Math.min(earliest, request.at);
          }
        } catch { /* concurrent cleanup */ }
      }
      const locked = await stat(lockFor(key)).then(() => true).catch(() => false);
      if (!queued && !locked) continue;
      const owner = sessions.find(s => s.key === key);
      // Hashes do not disclose private tab URLs or agent capabilities.
      queue.push({
        key: key.slice(0, 16), queued, locked,
        oldestWaitMs: queued ? now - earliest : 0,
        ...(owner ? { port: owner.port, targetId: owner.targetId } : {}),
      });
    }
  } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  return {
    sessions, queue,
    summary: {
      activeAgents: new Set(sessions.flatMap(s => s.participants.map(p => p.agentId))).size,
      activeTabs: sessions.length,
      queued: queue.reduce((total, item) => total + item.queued, 0),
      busyTargets: queue.filter(item => item.locked).length,
      extensionBlocked: sessions.length > 0,
    },
  };
}

/** Hold a global coordination lock across profile/window shutdown. New claims are
 * serialized against the destructive operation, preventing check-then-kill races. */
async function withBrowserLifecycleMutex<T>(fn: () => Promise<T>): Promise<T> {
  if (browserLifecycleScope.getStore()) return fn();
  const release = await lock(BROWSER_LIFECYCLE_KEY);
  try { return await browserLifecycleScope.run(true, fn); }
  finally { await release(); }
}
/** Coordinate extension calls with CDP claims without guessing Chrome extension
 * tab identity. Internal wrapper re-entry reuses the already acquired gate. */
export async function withBrowserBridgeOperation<T>(fn: () => Promise<T>): Promise<T> {
  if (browserBridgeScope.getStore()) {
    await assertNoExternalBrowserMutation();
    return fn();
  }
  return withBrowserLifecycleMutex(async () => browserBridgeScope.run(true, async () => {
    await assertNoExternalBrowserMutation();
    return fn();
  }));
}
export async function withBrowserLifecycleOperation<T>(fn: () => Promise<T>): Promise<T> {
  return withBrowserLifecycleMutex(async () => {
    await assertNoExternalBrowserMutation();
    return fn();
  });
}
export async function assertNoExternalBrowserMutation(): Promise<void> {
  if ((await listCdpSessions()).length > 0) {
    throw new Error("Chrome Extension browser writes blocked while CDP agent sessions exist; use the SuperAgent CDP gateway or release CDP sessions.");
  }
}
