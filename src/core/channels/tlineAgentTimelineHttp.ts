/** Read-only T-Line agent execution event journal. Authentication and trusted workspace
 * checks happen before this handler; enforce exact active session again here.
 */
import type http from "node:http";
import type { URL } from "node:url";
import { readAgentTimeline } from "./tlineAgentTimeline.js";
const SESSION = /^[a-zA-Z0-9_-]{1,128}$/;
export async function handleTlineAgentTimelineRoute(
  req: http.IncomingMessage, res: http.ServerResponse,
  pathname: string, url: URL,
  deps: {
    resolveSession: (request: http.IncomingMessage, id?: string, workspace?: string) =>
      { sessionId: string; workspace: string; clientMode: string } | null;
    sendJSON: (res: http.ServerResponse, status: number, data: any) => void;
  },
): Promise<boolean> {
  if (pathname !== "/api/tline/agent-timeline") return false;
  res.setHeader("Cache-Control", "no-store");
  const fail = (code: number, message: string) => {
    deps.sendJSON(res, code, { success: false, error: message });
  };
  if (req.method !== "GET") { fail(405, "GET required"); return true; }
  const workspace = url.searchParams.get("workspace");
  const sessionId = url.searchParams.get("sessionId");
  const cursorRaw = url.searchParams.get("cursor") || "0";
  if (!workspace || workspace.length > 4096 || /[\u0000-\u001f]/.test(workspace) ||
      !sessionId || !SESSION.test(sessionId) || !/^\d{1,15}$/.test(cursorRaw) ||
      typeof req.headers["x-workspace-path"] !== "string" ||
      req.headers["x-workspace-path"] !== workspace ||
      req.headers["x-client-mode"] !== "tline") {
    fail(400, "Exact T-Line session, workspace and cursor required");
    return true;
  }
  const session = deps.resolveSession(req, sessionId, workspace);
  if (!session || session.sessionId !== sessionId || session.clientMode !== "tline" ||
      session.workspace.toLowerCase() !== workspace.toLowerCase()) {
    fail(403, "Active session/workspace not verified");
    return true;
  }
  try {
    const result = readAgentTimeline({ workspace: session.workspace, sessionId }, Number(cursorRaw));
    deps.sendJSON(res, 200, { success: true, sessionId, ...result });
  } catch {
    fail(503, "Agent timeline journal unavailable");
  }
  return true;
}
