/**
 * Exact owner graph for a chat session. Workspace path is NOT ownership:
 * independent chat sessions (and their child agents) may share a workspace.
 */
export interface SessionAgentInstance {
  agent?: object | null;
  parentAgent?: object | null;
  sessionId?: string;
}
export function collectSessionOwnedAgents(
  rootAgent: object,
  sessionId: string,
  instances: ReadonlyArray<SessionAgentInstance>,
): Set<object> {
  const owned = new Set<object>([rootAgent]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const instance of instances) {
      if (!instance.agent || owned.has(instance.agent)) continue;
      const byParent = Boolean(instance.parentAgent && owned.has(instance.parentAgent));
      // Explicit session ID is acceptable only when no other known parent exists.
      const bySession = !instance.parentAgent &&
        instance.sessionId === sessionId;
      if (!byParent && !bySession) continue;
      owned.add(instance.agent);
      changed = true;
    }
  }
  return owned;
}
