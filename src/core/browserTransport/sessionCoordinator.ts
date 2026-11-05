import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BrowserTransportError } from "./types.js";

type DelegateSession = {
  key: string;
  clientId: string;
  tabId: number;
  agentId: string;
  tokenHash: string;
  claimedAt: number;
  expiresAt: number;
  revision: number;
};

const TTL_MS = 90_000;
const sessions = new Map<string, DelegateSession>();
const targetTails = new Map<string, Promise<void>>();
const keyOf = (clientId: string, tabId: number) => `${clientId}|tab:${tabId}`;
const hash = (v: string) => createHash("sha256").update(v).digest();

function clean(): void {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
}

function tokenMatches(value: string | undefined, digest: Buffer): boolean {
  if (!value) return false;
  const candidate = hash(value);
  return candidate.length === digest.length && timingSafeEqual(candidate, digest);
}

/**
 * Serialize all host-side operations for one Delegate tab. This preserves the
 * managed-CDP invariant that even legacy/unclaimed operations cannot mutate the
 * same target concurrently, while claimed targets still require capabilities.
 */
export async function withDelegateTargetLock<T>(
  clientId: string,
  tabId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = keyOf(clientId, tabId);
  const previous = targetTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  targetTails.set(key, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (targetTails.get(key) === tail) targetTails.delete(key);
  }
}

export function claimDelegateTarget(clientId: string, tabId: number, agentId: string, suppliedToken?: string) {
  clean();
  const key = keyOf(clientId, tabId);
  const previous = sessions.get(key);
  if (previous) {
    if (previous.agentId !== agentId || !tokenMatches(suppliedToken, Buffer.from(previous.tokenHash, "hex"))) {
      throw new BrowserTransportError("DELEGATE_CDP_TARGET_CLAIMED", "Delegate tab is already claimed by another owner or the capability token is invalid.");
    }
    previous.expiresAt = Date.now() + TTL_MS;
    return { ...publicSession(previous), sessionToken: suppliedToken! };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,95}$/.test(agentId)) {
    throw new BrowserTransportError("DELEGATE_CDP_AGENT_INVALID", "agentId is invalid.");
  }
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session: DelegateSession = {
    key, clientId, tabId, agentId, tokenHash: hash(token).toString("hex"),
    claimedAt: now, expiresAt: now + TTL_MS, revision: 0,
  };
  sessions.set(key, session);
  return { ...publicSession(session), sessionToken: token };
}

export function authorizeDelegateTarget(
  clientId: string,
  tabId: number,
  agentId?: string,
  sessionToken?: string,
  _write = false,
  expectedRevision?: number,
): void {
  clean();
  const session = sessions.get(keyOf(clientId, tabId));
  if (!session) {
    if (agentId) {
      throw new BrowserTransportError(
        "DELEGATE_CDP_CLAIM_REQUIRED",
        "No active Delegate-CDP claim for agent. Run claim_target first.",
      );
    }
    return;
  }
  if (!agentId || session.agentId !== agentId || !tokenMatches(sessionToken, Buffer.from(session.tokenHash, "hex"))) {
    throw new BrowserTransportError("DELEGATE_CDP_TARGET_CLAIMED", "Delegate tab is claimed; matching agentId and sessionToken are required.");
  }
  if (expectedRevision !== undefined && session.revision !== expectedRevision) {
    throw new BrowserTransportError(
      "DELEGATE_CDP_STALE_REVISION",
      "Delegate-CDP stale revision: refresh the target state before retrying.",
    );
  }
  session.expiresAt = Date.now() + TTL_MS;
}

export function noteDelegateWriteSuccess(
  clientId: string,
  tabId: number,
  agentId?: string,
  sessionToken?: string,
): void {
  clean();
  const session = sessions.get(keyOf(clientId, tabId));
  if (!session) return;
  if (!agentId || session.agentId !== agentId || !tokenMatches(sessionToken, Buffer.from(session.tokenHash, "hex"))) {
    throw new BrowserTransportError("DELEGATE_CDP_TARGET_CLAIMED", "Delegate tab is claimed; matching agentId and sessionToken are required.");
  }
  session.expiresAt = Date.now() + TTL_MS;
  session.revision++;
}

export function releaseDelegateTarget(clientId: string, tabId: number, agentId: string, sessionToken?: string): void {
  authorizeDelegateTarget(clientId, tabId, agentId, sessionToken, false);
  sessions.delete(keyOf(clientId, tabId));
}

export function listDelegateSessions() {
  clean();
  return [...sessions.values()].map(publicSession);
}

export function hasDelegateClaim(clientId: string, tabId: number): boolean {
  clean();
  return sessions.has(keyOf(clientId, tabId));
}

export function delegateTargetBusy(clientId: string, tabId: number): boolean {
  return targetTails.has(keyOf(clientId, tabId));
}

function publicSession(session: DelegateSession) {
  return {
    key: session.key, transport: "delegate" as const, connectionId: session.clientId,
    clientId: session.clientId, tabId: session.tabId, targetId: `delegate:${session.clientId}:${session.tabId}`,
    agentId: session.agentId, claimedAt: session.claimedAt, expiresAt: session.expiresAt, revision: session.revision,
  };
}
