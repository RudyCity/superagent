export interface PendingPromptOwner {
  ownerAgent?: unknown;
  sessionId?: string;
  workspace?: string;
}

export interface PromptResolvingSession {
  agent: unknown;
  sessionId: string;
}

/** Prompt IDs are capabilities scoped to the session that created them. */
export function isPendingPromptOwner(
  pending: PendingPromptOwner | null | undefined,
  session: PromptResolvingSession | null | undefined,
): boolean {
  if (!pending || !session) return false;
  if (pending.ownerAgent) return session.agent === pending.ownerAgent;
  return Boolean(pending.sessionId && session.sessionId === pending.sessionId);
}
