import path from "path";

export interface SessionEventContext {
  sessionId?: string;
  workspace?: string;
}

function normalizeWorkspaceTarget(value: string): string {
  if (/^(?:ssh:|ssh:\/\/|chain:)/i.test(value)) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Keep session/workspace events private to the matching SSE client context. */
export function shouldDeliverEventToClient(
  event: { sessionId?: unknown; workspace?: unknown },
  context?: SessionEventContext,
): boolean {
  const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
  const eventWorkspace = typeof event.workspace === "string" ? event.workspace : undefined;

  if (eventSessionId) {
    if (!context?.sessionId || context.sessionId !== eventSessionId) return false;
    return !eventWorkspace || !context.workspace ||
      normalizeWorkspaceTarget(context.workspace) === normalizeWorkspaceTarget(eventWorkspace);
  }
  if (eventWorkspace) {
    return Boolean(context?.workspace &&
      normalizeWorkspaceTarget(context.workspace) === normalizeWorkspaceTarget(eventWorkspace));
  }
  return true;
}
