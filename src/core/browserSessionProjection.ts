/**
 * Read-only projection for GET /api/browser/sessions.
 *
 * Local desktop clients need to know which agent claims which CDP tab. They do
 * not need session tokens, cookies, or page content. This module is pure so the
 * projection and the loopback gate can be tested without a live server.
 */

export type CdpSessionLike = {
  key?: string;
  port?: number;
  targetId?: string;
  agentId?: string;
  mode?: "isolated" | "shared";
  revision?: number;
  paused?: boolean;
  generation?: string;
  claimedAt?: number;
  expiresAt?: number;
  participants?: Array<{ agentId?: string; role?: string }>;
};

export type ProjectedCdpSession = {
  key: string;
  port: number;
  targetId: string;
  agentId: string;
  mode: "isolated" | "shared";
  revision: number;
  paused: boolean;
  generation: string;
  claimedAt: number;
  expiresAt: number;
  participants: Array<{ agentId: string; role: string }>;
};

export type CdpSessionProjection = {
  ok: true;
  sessions: ProjectedCdpSession[];
  summary: { activeTabs: number; activeAgents: number };
};

const KEY = /^[a-f0-9]{16,64}$/;
const TARGET = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT = /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,95}$/;

/** Core binds to loopback; this gate is a second, explicit check. */
export function isLoopbackRemote(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function finiteInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

/** Drops malformed entries instead of returning a partial, untrusted shape. */
export function projectCdpSessions(sessions: readonly CdpSessionLike[]): CdpSessionProjection {
  const projected: ProjectedCdpSession[] = [];
  const agents = new Set<string>();
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const { key, port, targetId, agentId, participants } = session;
    if (typeof key !== "string" || !KEY.test(key)) continue;
    if (!Number.isSafeInteger(port) || (port as number) < 1024 || (port as number) > 65535) continue;
    if (typeof targetId !== "string" || !TARGET.test(targetId)) continue;
    if (typeof agentId !== "string" || !AGENT.test(agentId)) continue;
    const projectedParticipants: Array<{ agentId: string; role: string }> = [];
    for (const member of Array.isArray(participants) ? participants : []) {
      const memberId = member?.agentId;
      if (typeof memberId !== "string" || !AGENT.test(memberId)) continue;
      const role = typeof member.role === "string" && /^[a-z_]{2,24}$/.test(member.role) ? member.role : "observer";
      projectedParticipants.push({ agentId: memberId, role });
      agents.add(memberId);
    }
    if (!projectedParticipants.some((member) => member.agentId === agentId)) {
      projectedParticipants.unshift({ agentId, role: "owner" });
      agents.add(agentId);
    }
    projected.push({
      key,
      port: port as number,
      targetId,
      agentId,
      mode: session.mode === "shared" ? "shared" : "isolated",
      revision: finiteInteger(session.revision),
      paused: session.paused === true,
      generation: typeof session.generation === "string" ? session.generation.slice(0, 96) : "",
      claimedAt: finiteInteger(session.claimedAt),
      expiresAt: finiteInteger(session.expiresAt),
      participants: projectedParticipants,
    });
  }
  return {
    ok: true,
    sessions: projected,
    summary: { activeTabs: projected.length, activeAgents: agents.size },
  };
}
