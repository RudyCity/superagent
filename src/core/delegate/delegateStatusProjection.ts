/**
 * Minimal, privacy-safe Delegate-CDP lease projection for the LOCAL operator Tray.
 * A bearer-authenticated loopback route is the only HTTP consumer. This module
 * never renews a lease, inspects capabilities, opens a browser tab or writes a journal.
 */
import { delegateBridge } from "./bridge.js";
import { delegateTargetBusy, listDelegateSessions } from "../browserTransport/sessionCoordinator.js";
import { getDelegateMcpPrincipalId, isDelegateMcpBoundary, visibleDelegateSessions } from "../browserTransport/delegatePrincipalPolicy.js";

export type DelegateTraySession = Readonly<{
  transport: "delegate";
  clientId: string;
  tabId: number;
  agentId: string;
  ownerRole: "owner";
  revision: number;
  claimedAt: number;
  expiresAt: number;
  sharing?: boolean;
  recoveryRequired?: boolean;
  participants?: Array<Readonly<{
    agentId: string;
    role: "observer" | "contributor";
    joinedAt: number;
    expiresAt: number;
  }>>;
  /** The coordinator exposes contention, not a trustworthy queue depth. */
  lockBusy?: boolean;
  queuedOperations: null;
}>;

const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,95}$/;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number =>
  nonnegative(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pure, explicitly allowlisted status shape. Never spread raw session data. */
export function projectDelegateTrayStatus(
  source: unknown,
  options: {
    connectedClientIds: readonly string[];
    requestedClientId?: string;
    principalId?: string;
    now?: number;
    busy?: (clientId: string, tabId: number) => boolean;
  },
): { observedAt: number; sessionsStatus: "known" | "unknown"; sessions: DelegateTraySession[]; truncated: boolean } {
  const now = options.now ?? Date.now();
  if (!Array.isArray(source) || !Number.isSafeInteger(now) || now < 0) {
    return { observedAt: Date.now(), sessionsStatus: "unknown", sessions: [], truncated: false };
  }
  const connected = new Set(options.connectedClientIds.filter(id => CLIENT_ID.test(id)));
  const sessions: DelegateTraySession[] = [];
  let truncated = false;
  for (const item of source) {
    if (!record(item) || item.transport !== "delegate" ||
        typeof item.clientId !== "string" || !connected.has(item.clientId) ||
        (options.requestedClientId !== undefined && item.clientId !== options.requestedClientId) ||
        !positive(item.tabId) || typeof item.agentId !== "string" ||
        !AGENT_ID.test(item.agentId) || !nonnegative(item.revision) ||
        !positive(item.expiresAt) || item.expiresAt <= now ||
        !positive(item.claimedAt)) continue;
    const rawMembers = Array.isArray(item.participants) ? item.participants : [];
    const participants = rawMembers.filter((member): member is Record<string, unknown> =>
      record(member) && typeof member.agentId === "string" && AGENT_ID.test(member.agentId) &&
      (member.role === "observer" || member.role === "contributor") &&
      positive(member.joinedAt) && positive(member.expiresAt) && member.expiresAt > now &&
      (options.principalId === undefined || member.agentId === options.principalId))
      .slice(0, 16).map(member => ({
        agentId: member.agentId as string,
        role: member.role as "observer" | "contributor",
        joinedAt: member.joinedAt as number,
        expiresAt: member.expiresAt as number,
      }));
    if (options.principalId !== undefined &&
        item.agentId !== options.principalId && participants.length === 0) continue;
    if (sessions.length >= 256) { truncated = true; break; }
    const view: DelegateTraySession = {
      transport: "delegate",
      clientId: item.clientId,
      tabId: item.tabId,
      agentId: item.agentId,
      ownerRole: "owner",
      revision: item.revision,
      claimedAt: item.claimedAt,
      expiresAt: item.expiresAt,
      ...(typeof item.sharing === "boolean" ? { sharing: item.sharing } : {}),
      ...(typeof item.recoveryRequired === "boolean" ? { recoveryRequired: item.recoveryRequired } : {}),
      ...(Array.isArray(item.participants) ? { participants } : {}),
      ...(options.busy ? { lockBusy: options.busy(item.clientId, item.tabId) === true } : {}),
      queuedOperations: null,
    };
    sessions.push(view);
  }
  sessions.sort((a, b) => a.clientId.localeCompare(b.clientId) || a.tabId - b.tabId);
  return { observedAt: now, sessionsStatus: "known", sessions, truncated };
}

/** Reads in-memory snapshots only, with the same MCP principal visibility fence. */
export function readDelegateTrayStatus(requestedClientId?: string) {
  const boundary = isDelegateMcpBoundary();
  const principalId = getDelegateMcpPrincipalId();
  if (boundary && !principalId) {
    return { observedAt: Date.now(), sessionsStatus: "unknown" as const,
      sessions: [] as DelegateTraySession[], truncated: false };
  }
  const connections = delegateBridge.listConnections();
  const sessions = visibleDelegateSessions(listDelegateSessions());
  return projectDelegateTrayStatus(sessions, {
    connectedClientIds: connections.map(connection => connection.clientId),
    requestedClientId,
    ...(boundary ? { principalId } : {}),
    busy: delegateTargetBusy,
  });
}
