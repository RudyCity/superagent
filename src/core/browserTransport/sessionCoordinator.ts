import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { BrowserTransportError } from "./types.js";
import { type DelegateLeaseJournal, type DurableDelegateLease } from "./delegateLeaseJournal.js";

export interface DelegateLeaseOperationFence {
  assertCurrent(): void;
  beginOperation(): (completed?: boolean) => void;
}

export type DelegateParticipantRole = "observer" | "contributor";
type DelegateParticipant = {
  agentId: string;
  role: DelegateParticipantRole;
  tokenHash: string;
  joinedAt: number;
  expiresAt: number;
};
type DelegateInvitation = {
  inviteId: string;
  memberId: string;
  role: DelegateParticipantRole;
  tokenHash: string;
  expiresAt: number;
};
type DelegateSession = {
  key: string;
  clientId: string;
  tabId: number;
  agentId: string;
  tokenHash: string;
  claimedAt: number;
  expiresAt: number;
  revision: number;
  sharing: boolean;
  participants: Map<string, DelegateParticipant>;
  invitations: Map<string, DelegateInvitation>;
  recoveredEpoch: string;
};

const TTL_MS = 90_000;
const INVITE_TTL_MS = 60_000;
const MAX_MEMBERS = 16;
const MAX_INVITES = 24;
const MAX_QUEUE_PER_TARGET = 32;
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,95}$/;
const sessions = new Map<string, DelegateSession>();
let durableJournal: DelegateLeaseJournal | undefined;
let durableSequence = -1;
let durableBlocked = false;
let runtimeFence: DelegateLeaseOperationFence | undefined;
let durableBlockReason = "Lease storage is unavailable; deny CDP operations.";
type DelegateOperationContext = { active: boolean; pendingRpcs: number };
const operationScope = new AsyncLocalStorage<DelegateOperationContext>();

/** Every lower-level mutating CDP RPC must be inside a fenced target operation. */
export function enterDelegateProtectedCdpRpc(): () => void {
  assertDurableCurrent();
  if (!runtimeFence) return () => {};
  const context = operationScope.getStore();
  if (!context?.active)
    fail("DELEGATE_LEASE_LOCK_REQUIRED", "Mutating CDP RPC requires an active fenced coordinator operation.");
  context.pendingRpcs++;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    context.pendingRpcs--;
  };
}

/** Once lifecycle preflight fails, no fallback to unprotected in-memory claims. */
export function blockDelegateLeaseActivation(reason: string): void {
  durableBlocked = true;
  durableBlockReason = reason;
}
export function assertDelegateLeaseReady(): void {
  assertDurableCurrent();
}
/** Recovery may inspect a prior epoch, but NEVER bypass independent owner fencing. */
function assertDelegateRecoveryReady(): void {
  if (durableBlocked) fail("DELEGATE_LEASE_UNAVAILABLE", durableBlockReason);
  if (!durableJournal) fail("DELEGATE_LEASE_UNAVAILABLE", "Durable lease recovery is not configured.");
  try {
    runtimeFence?.assertCurrent();
    durableJournal.read(); // HMAC and physical storage still required.
  } catch (error) {
    durableBlocked = true;
    throw error;
  }
}
const IN_MEMORY_EPOCH = "00000000000000000000000000000000";

/**
 * Opt-in only. The runtime integration must provide a private directory and a
 * stable external HMAC key to create the journal; never auto-initialize live
 * state or silently discard an existing journal.
 */
export function configureDelegateLeaseJournal(
  journal: DelegateLeaseJournal, verifiedFence?: DelegateLeaseOperationFence,
): void {
  if (durableJournal) fail("DELEGATE_LEASE_CONFIGURED", "Lease journal already configured for this process.");
  if (targetTails.size > 0 || sessions.size > 0)
    fail("DELEGATE_LEASE_IN_FLIGHT", "Cannot activate durable leases while legacy claims or operations remain.");
  if (verifiedFence) verifiedFence.assertCurrent();
  durableBlocked = true;
  const snapshot = journal.read(); // Missing/corrupt storage stays fail-closed.
  const restored = new Map<string, DelegateSession>();
  for (const lease of snapshot.leases) {
    if (lease.expiresAt <= Date.now()) continue;
    const session: DelegateSession = {
      key: keyOf(lease.clientId, lease.tabId),
      clientId: lease.clientId, tabId: lease.tabId,
      agentId: lease.agentId, tokenHash: lease.tokenHash,
      claimedAt: lease.claimedAt, expiresAt: lease.expiresAt,
      revision: lease.revision, sharing: lease.sharing,
      recoveredEpoch: lease.recoveredEpoch,
      participants: new Map(lease.participants
        .filter(m => m.expiresAt > Date.now()).map(m => [m.agentId, { ...m }])),
      invitations: new Map(lease.invitations
        .filter(i => i.expiresAt > Date.now()).map(i => [i.inviteId, { ...i }])),
    };
    restored.set(session.key, session);
  }
  sessions.clear();
  for (const [key, session] of restored) sessions.set(key, session);
  durableJournal = journal;
  durableSequence = snapshot.sequence;
  runtimeFence = verifiedFence;
  durableBlocked = false;
}
/**
 * Explicit retirement path for a journal whose ALL claims have expired.
 * The journal must independently verify the prior writer is retired.
 */
export function retireExpiredDelegateLeases(): void {
  assertDelegateRecoveryReady();
  if (!durableJournal) fail("DELEGATE_LEASE_UNAVAILABLE", "Configure the lease journal first.");
  const snapshot = durableJournal.retireExpired(durableSequence);
  sessions.clear();
  durableSequence = snapshot.sequence;
  durableBlocked = false;
}
function assertDurableCurrent(): void {
  if (durableBlocked) fail("DELEGATE_LEASE_UNAVAILABLE", durableBlockReason);
  if (!durableJournal) return;
  try {
    runtimeFence?.assertCurrent();
    const state = durableJournal.read();
    if (state.sequence !== durableSequence || state.writerEpoch !== durableJournal.epoch) {
      fail("DELEGATE_LEASE_STALE", "Stale lease state belongs to another Core epoch or revision.");
    }
  } catch (error) {
    // A VALID prior-epoch snapshot is expected during fenced restart recovery.
    // Reject ordinary operations, but keep explicit owner-token recovery possible.
    // Corruption, changed sequence and lost owner proof remain terminal failures.
    const staleEpochOnly = (error as BrowserTransportError)?.code === "DELEGATE_LEASE_STALE"
      && (() => {
        try {
          runtimeFence?.assertCurrent();
          const snapshot = durableJournal!.read();
          return snapshot.sequence === durableSequence && snapshot.writerEpoch !== durableJournal!.epoch;
        } catch { return false; }
      })();
    if (!staleEpochOnly) durableBlocked = true;
    throw error;
  }
}
function requireRecovered(session: DelegateSession): void {
  if (durableJournal && session.recoveredEpoch !== durableJournal.epoch) {
    fail("DELEGATE_LEASE_RECOVERY_REQUIRED", "Owner capability must recover this tab after Core restart.");
  }
}
function checkpoint(): void {
  if (!durableJournal) return;
  assertDurableCurrent();
  const leases: DurableDelegateLease[] = [...sessions.values()].map(session => ({
    clientId: session.clientId, tabId: session.tabId,
    agentId: session.agentId, tokenHash: session.tokenHash,
    claimedAt: session.claimedAt, expiresAt: session.expiresAt,
    revision: session.revision, sharing: session.sharing,
    recoveredEpoch: session.recoveredEpoch,
    participants: [...session.participants.values()].map(m => ({ ...m })),
    invitations: [...session.invitations.values()].map(i => ({ ...i })),
  }));
  try {
    durableSequence = durableJournal.commit(durableSequence, leases).sequence;
  } catch (error) {
    durableBlocked = true; // Never continue with possibly non-durable mutations.
    throw error;
  }
}
/**
 * Explicit owner-only recovery; never resumes in-flight browser work.
 * Participants remain token-gated; all pre-restart write revisions are fenced.
 */
export function recoverDelegateTarget(
  clientId: string, tabId: number, agentId: string, originalToken: string,
) {
  if (!durableJournal || durableBlocked) fail("DELEGATE_LEASE_UNAVAILABLE", durableBlockReason);
  runtimeFence?.assertCurrent();
  const snapshot = durableJournal.recover(clientId, tabId, agentId, originalToken, durableSequence);
  durableSequence = snapshot.sequence;
  const recovered = snapshot.leases.find(l => l.clientId === clientId && l.tabId === tabId)!;
  const session: DelegateSession = {
    key: keyOf(clientId, tabId), clientId, tabId,
    agentId: recovered.agentId, tokenHash: recovered.tokenHash,
    claimedAt: recovered.claimedAt, expiresAt: recovered.expiresAt,
    revision: recovered.revision, sharing: recovered.sharing,
    recoveredEpoch: recovered.recoveredEpoch,
    participants: new Map(recovered.participants
      .filter(m => m.expiresAt > Date.now()).map(m => [m.agentId, { ...m }])),
    invitations: new Map(recovered.invitations
      .filter(i => i.expiresAt > Date.now()).map(i => [i.inviteId, { ...i }])),
  };
  // Reload *all* leases to reflect the new epoch's durable state.
  sessions.set(session.key, session);
  durableBlocked = false;
  return { ...publicSession(session), sessionToken: originalToken };
}
const targetTails = new Map<string, Promise<void>>();
const targetQueued = new Map<string, number>();
const keyOf = (clientId: string, tabId: number) => `${clientId}|tab:${tabId}`;
const hash = (value: string) => createHash("sha256").update(value).digest();

function fail(code: string, message: string): never {
  throw new BrowserTransportError(code, message);
}
function assertAgent(agentId: string): void {
  if (!AGENT_ID.test(agentId)) fail("DELEGATE_CDP_AGENT_INVALID", "agentId is invalid.");
}
function clean(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(key);
      continue;
    }
    for (const [id, member] of session.participants) {
      if (member.expiresAt <= now) session.participants.delete(id);
    }
    for (const [id, invite] of session.invitations) {
      if (invite.expiresAt <= now) session.invitations.delete(id);
    }
  }
}
function tokenMatches(value: string | undefined, digest: string): boolean {
  if (!value) return false;
  const expected = Buffer.from(digest, "hex");
  const candidate = hash(value);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function findSession(clientId: string, tabId: number): DelegateSession {
  assertDurableCurrent();
  clean();
  const session = sessions.get(keyOf(clientId, tabId));
  if (!session) fail("DELEGATE_CDP_CLAIM_REQUIRED", "The Delegate tab has no active claim.");
  return session;
}
function ownerSession(clientId: string, tabId: number, agentId: string, token?: string): DelegateSession {
  const session = findSession(clientId, tabId);
  if (session.agentId !== agentId || !tokenMatches(token, session.tokenHash)) {
    fail("DELEGATE_CDP_OWNER_REQUIRED", "This operation requires the tab owner's capability.");
  }
  requireRecovered(session);
  session.expiresAt = Date.now() + TTL_MS;
  return session;
}
function publicSession(session: DelegateSession) {
  return {
    key: session.key, transport: "delegate" as const, connectionId: session.clientId,
    clientId: session.clientId, tabId: session.tabId,
    targetId: `delegate:${session.clientId}:${session.tabId}`,
    agentId: session.agentId, claimedAt: session.claimedAt,
    expiresAt: session.expiresAt, revision: session.revision,
    sharing: session.sharing,
    participants: [...session.participants.values()].map(m => ({
      agentId: m.agentId, role: m.role, joinedAt: m.joinedAt, expiresAt: m.expiresAt,
    })),
    pendingInvitations: session.invitations.size,
    recoveryRequired: !!durableJournal && session.recoveredEpoch !== durableJournal.epoch,
  };
}

/**
 * Fair per-profile/tab FIFO lock, including unclaimed operations. Never allow
 * an unbounded backlog to consume process memory while a browser command stalls.
 */
export async function withDelegateTargetLock<T>(
  clientId: string,
  tabId: number,
  fn: () => Promise<T>,
  allowEpochRecovery = false,
): Promise<T> {
  if (allowEpochRecovery) assertDelegateRecoveryReady();
  else assertDurableCurrent();
  const key = keyOf(clientId, tabId);
  const queued = targetQueued.get(key) ?? 0;
  if (queued >= MAX_QUEUE_PER_TARGET) {
    fail("DELEGATE_CDP_QUEUE_FULL", "Too many pending operations for this Delegate tab.");
  }
  targetQueued.set(key, queued + 1);
  const previous = targetTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  targetTails.set(key, tail);
  try {
    await previous.catch(() => {});
    if (allowEpochRecovery) assertDelegateRecoveryReady();
    else assertDurableCurrent(); // Recheck AFTER waiting for the process-local FIFO.
    const finish = runtimeFence?.beginOperation();
    const scope: DelegateOperationContext = { active: true, pendingRpcs: 0 };
    try {
      const result = await operationScope.run(scope, fn);
      if (scope.pendingRpcs !== 0)
        fail("DELEGATE_LEASE_PENDING_WRITE", "A CDP RPC is still in flight after its coordinator operation returned.");
      scope.active = false;
      finish?.(true);
      return result;
    } catch (error) {
      scope.active = false;
      // A detached RPC or timeout has an unknown browser outcome. Preserve
      // the marker so an owner takeover cannot replay or overlap this action.
      const uncertain = scope.pendingRpcs !== 0 ||
        /TIMEOUT|ABORT|UNKNOWN_COMPLETION|CONNECTION_LOST|PENDING_WRITE/i.test(
          String((error as Error)?.message ?? error),
        );
      finish?.(!uncertain);
      throw error;
    }
  } finally {
    release();
    const count = (targetQueued.get(key) ?? 1) - 1;
    if (count > 0) targetQueued.set(key, count);
    else targetQueued.delete(key);
    if (targetTails.get(key) === tail) targetTails.delete(key);
  }
}

export function claimDelegateTarget(clientId: string, tabId: number, agentId: string, suppliedToken?: string) {
  assertDurableCurrent();
  clean();
  assertAgent(agentId);
  const key = keyOf(clientId, tabId);
  const previous = sessions.get(key);
  if (previous) {
    if (previous.agentId !== agentId || !tokenMatches(suppliedToken, previous.tokenHash)) {
      fail("DELEGATE_CDP_TARGET_CLAIMED", "Delegate tab belongs to another owner or the capability is invalid.");
    }
    requireRecovered(previous);
    previous.expiresAt = Date.now() + TTL_MS;
    checkpoint();
    return { ...publicSession(previous), sessionToken: suppliedToken! };
  }
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session: DelegateSession = {
    key, clientId, tabId, agentId, tokenHash: hash(token).toString("hex"),
    claimedAt: now, expiresAt: now + TTL_MS, revision: 0,
    sharing: false, participants: new Map(), invitations: new Map(),
    recoveredEpoch: durableJournal?.epoch ?? IN_MEMORY_EPOCH,
  };
  sessions.set(key, session);
  checkpoint();
  return { ...publicSession(session), sessionToken: token };
}

export function authorizeDelegateTarget(
  clientId: string,
  tabId: number,
  agentId?: string,
  sessionToken?: string,
  write = false,
  expectedRevision?: number,
  ownerOnly = false,
  requireShared = false,
): void {
  assertDurableCurrent();
  clean();
  const session = sessions.get(keyOf(clientId, tabId));
  if (!session) {
    if (durableJournal || agentId || requireShared) {
      fail("DELEGATE_CDP_CLAIM_REQUIRED", "No active Delegate-CDP claim. Run claim_target first.");
    }
    return; // Existing unclaimed-tab behavior.
  }
  requireRecovered(session);
  const isOwner = !!agentId && session.agentId === agentId && tokenMatches(sessionToken, session.tokenHash);
  const participant = !isOwner && !!agentId && session.sharing ? session.participants.get(agentId) : undefined;
  const isMember = !!participant && tokenMatches(sessionToken, participant.tokenHash);
  if (!isOwner && !isMember) {
    fail("DELEGATE_CDP_TARGET_CLAIMED", "Delegate tab is claimed; valid owner/participant agentId and sessionToken are required.");
  }
  if (ownerOnly && !isOwner) fail("DELEGATE_CDP_OWNER_REQUIRED", "Only the tab owner may perform this action.");
  if (requireShared && !session.sharing) fail("DELEGATE_CDP_NOT_SHARED", "This tab is not shared.");
  if (write && !isOwner && participant!.role !== "contributor") {
    fail("DELEGATE_CDP_READ_ONLY", "Observers may not mutate a shared tab.");
  }
  if (write && !isOwner && expectedRevision === undefined) {
    fail("DELEGATE_CDP_REVISION_REQUIRED", "Shared-tab contributor writes require expectedRevision.");
  }
  if (expectedRevision !== undefined && session.revision !== expectedRevision) {
    fail("DELEGATE_CDP_STALE_REVISION", "Delegate-CDP stale revision: refresh before retrying.");
  }
  const now = Date.now();
  session.expiresAt = now + TTL_MS;
  if (isMember) participant!.expiresAt = now + TTL_MS;
  checkpoint();
}

export function noteDelegateWriteSuccess(clientId: string, tabId: number, agentId?: string, token?: string): void {
  clean();
  const session = sessions.get(keyOf(clientId, tabId));
  if (!session) return;
  authorizeDelegateTarget(clientId, tabId, agentId, token, true,
    session.agentId === agentId ? undefined : session.revision);
  session.revision++;
  checkpoint();
}

export function releaseDelegateTarget(clientId: string, tabId: number, agentId: string, token?: string): void {
  ownerSession(clientId, tabId, agentId, token);
  sessions.delete(keyOf(clientId, tabId));
  checkpoint();
}

export function setDelegateSharing(clientId: string, tabId: number, agentId: string, token: string | undefined, enabled: boolean) {
  const session = ownerSession(clientId, tabId, agentId, token);
  if (session.sharing !== enabled) {
    session.sharing = enabled;
    if (!enabled) {
      session.participants.clear();
      session.invitations.clear();
    }
    session.revision++;
  }
  checkpoint();
  return publicSession(session);
}
export function inviteDelegateAgent(
  clientId: string, tabId: number, agentId: string, token: string | undefined,
  memberId: string, role: DelegateParticipantRole,
) {
  assertAgent(memberId);
  if (role !== "observer" && role !== "contributor") {
    fail("DELEGATE_CDP_ROLE_INVALID", "Role must be observer or contributor.");
  }
  const session = ownerSession(clientId, tabId, agentId, token);
  if (!session.sharing) fail("DELEGATE_CDP_NOT_SHARED", "Enable sharing before inviting members.");
  if (memberId === session.agentId) fail("DELEGATE_CDP_INVITATION_INVALID", "Cannot invite the tab owner.");
  if (session.participants.has(memberId)) fail("DELEGATE_CDP_ALREADY_JOINED", "Member is already present.");
  if (session.participants.size >= MAX_MEMBERS || session.invitations.size >= MAX_INVITES) {
    fail("DELEGATE_CDP_SHARE_LIMIT", "Delegate shared-tab membership limit reached.");
  }
  const inviteId = randomBytes(16).toString("hex");
  const invitationToken = randomBytes(32).toString("base64url");
  session.invitations.set(inviteId, {
    inviteId, memberId, role, tokenHash: hash(invitationToken).toString("hex"),
    expiresAt: Date.now() + INVITE_TTL_MS,
  });
  checkpoint();
  return { inviteId, invitationToken, targetId: publicSession(session).targetId,
    memberId, role, expiresAt: session.invitations.get(inviteId)!.expiresAt };
}
export function joinDelegateTarget(
  clientId: string, tabId: number, agentId: string, inviteId: string, invitationToken: string,
) {
  assertAgent(agentId);
  const session = findSession(clientId, tabId);
  if (!session.sharing) fail("DELEGATE_CDP_NOT_SHARED", "Delegate tab sharing is disabled.");
  const invitation = session.invitations.get(inviteId);
  if (!invitation || invitation.memberId !== agentId || !tokenMatches(invitationToken, invitation.tokenHash)) {
    fail("DELEGATE_CDP_INVITATION_INVALID", "Invitation is invalid, expired, or not intended for this agent.");
  }
  if (session.participants.size >= MAX_MEMBERS) fail("DELEGATE_CDP_SHARE_LIMIT", "Delegate member limit reached.");
  session.invitations.delete(inviteId); // Exactly once, even if a later call retries.
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  session.participants.set(agentId, {
    agentId, role: invitation.role, tokenHash: hash(token).toString("hex"),
    joinedAt: now, expiresAt: now + TTL_MS,
  });
  session.revision++;
  session.expiresAt = now + TTL_MS;
  checkpoint();
  return { ...publicSession(session), sessionToken: token, role: invitation.role };
}
export function leaveDelegateTarget(clientId: string, tabId: number, agentId: string, token: string | undefined) {
  const session = findSession(clientId, tabId);
  if (session.agentId === agentId) fail("DELEGATE_CDP_OWNER_REQUIRED", "Owner must release or hand over the tab.");
  authorizeDelegateTarget(clientId, tabId, agentId, token);
  session.participants.delete(agentId);
  session.revision++;
  checkpoint();
  return publicSession(session);
}
export function revokeDelegateAgent(
  clientId: string, tabId: number, agentId: string, token: string | undefined, memberId: string,
) {
  const session = ownerSession(clientId, tabId, agentId, token);
  const removed = session.participants.delete(memberId);
  for (const [id, invite] of session.invitations) {
    if (invite.memberId === memberId) session.invitations.delete(id);
  }
  if (removed) session.revision++;
  checkpoint();
  return publicSession(session);
}
export function handoverDelegateTarget(
  clientId: string, tabId: number, agentId: string, token: string | undefined, memberId: string,
) {
  const session = ownerSession(clientId, tabId, agentId, token);
  const participant = session.participants.get(memberId);
  if (!participant || participant.role !== "contributor") {
    fail("DELEGATE_CDP_HANDOVER_INVALID", "Handover requires a joined contributor.");
  }
  // Promote the contributor's existing secret, never disclose it to the old owner.
  session.agentId = memberId;
  session.tokenHash = participant.tokenHash;
  session.participants.delete(memberId);
  session.invitations.clear();
  session.expiresAt = Date.now() + TTL_MS;
  session.revision++;
  checkpoint();
  return publicSession(session);
}
export function getDelegateParticipation(clientId: string, tabId: number, agentId: string, token: string | undefined) {
  authorizeDelegateTarget(clientId, tabId, agentId, token);
  return publicSession(findSession(clientId, tabId));
}
export function heartbeatDelegateSession(clientId: string, tabId: number, agentId: string, token: string | undefined) {
  authorizeDelegateTarget(clientId, tabId, agentId, token);
  return publicSession(findSession(clientId, tabId));
}
export function listDelegateSessions() {
  clean();
  return [...sessions.values()].map(publicSession);
}
export function hasDelegateClaim(clientId: string, tabId: number): boolean {
  if (durableBlocked) return true; // Fail closed: never expose an anonymous bypass.
  if (durableJournal) {
    try { assertDurableCurrent(); } catch { return true; }
  }
  clean();
  return sessions.has(keyOf(clientId, tabId));
}
export function delegateTargetBusy(clientId: string, tabId: number): boolean {
  return targetTails.has(keyOf(clientId, tabId));
}
