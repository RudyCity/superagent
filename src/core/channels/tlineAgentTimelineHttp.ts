/** Read-only T-Line agent execution event journal. Authentication and trusted workspace
 * checks happen before this handler; enforce exact active session again here.
 */
import type http from "node:http";
import type { URL } from "node:url";
import { readAgentTimeline } from "./tlineAgentTimeline.js";
const SESSION = /^[a-zA-Z0-9_-]{1,128}$/;
// Bound concurrent journal readers; streams are read-only but still consume sockets.
const activeJournalStreams = new Set<http.ServerResponse>();
const MAX_JOURNAL_STREAMS = 24;
export async function handleTlineAgentTimelineRoute(
  req: http.IncomingMessage, res: http.ServerResponse,
  pathname: string, url: URL,
  deps: {
    resolveSession: (request: http.IncomingMessage, id?: string, workspace?: string) =>
      { sessionId: string; workspace: string; clientMode: string } | null;
    sendJSON: (res: http.ServerResponse, status: number, data: any) => void;
  },
): Promise<boolean> {
  const stream = pathname === "/api/tline/agent-timeline/stream";
  if (!stream && pathname !== "/api/tline/agent-timeline") return false;
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
  const scope = { workspace: session.workspace, sessionId };
  try {
    const result = readAgentTimeline(scope, Number(cursorRaw));
    if (!stream) {
      deps.sendJSON(res, 200, { success: true, sessionId, ...result });
      return true;
    }
    if (activeJournalStreams.size >= MAX_JOURNAL_STREAMS) {
      fail(429, "Too many concurrent timeline streams");
      return true;
    }
    activeJournalStreams.add(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    try { (res.socket as any)?.setNoDelay(true); } catch {}
    let nextCursor = Number(cursorRaw);
    let closed = false;
    let lastHeartbeat = Date.now();
    let sending = false;
    const tick = () => {
      if (closed || sending || res.destroyed || res.writableEnded) return;
      if ((res.writableLength || 0) > 256 * 1024) {
        // Slow consumers reconnect by cursor; never grow an unbounded buffer.
        closed = true; activeJournalStreams.delete(res);
        clearInterval(timer); res.end();
        return;
      }
      sending = true;
      try {
        // A revoked/deleted session loses access even on a previously-open socket.
        const owner = deps.resolveSession(req, sessionId, workspace);
        if (!owner || owner.clientMode !== "tline" ||
            owner.sessionId !== sessionId ||
            owner.workspace.toLowerCase() !== workspace.toLowerCase()) {
          closed = true;
          activeJournalStreams.delete(res);
          clearInterval(timer);
          res.end();
          return;
        }
        const page = readAgentTimeline(scope, nextCursor, 100);
        if (page.gap) res.write("event: gap\ndata: {}\n\n");
        for (const event of page.events) {
          res.write("id: " + event.seq + "\ndata: " + JSON.stringify(event) + "\n\n");
        }
        nextCursor = page.nextCursor;
        if (Date.now() - lastHeartbeat > 15000) {
          res.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
      } catch {
        res.write("event: unavailable\ndata: {}\n\n");
        closed = true; activeJournalStreams.delete(res); clearInterval(timer); res.end();
      } finally { sending = false; }
    };
    const timer = setInterval(tick, 1000);
    timer.unref?.();
    res.on("close", () => {
      closed = true; activeJournalStreams.delete(res); clearInterval(timer);
    });
    tick();
  } catch {
    fail(503, "Agent timeline journal unavailable");
  }
  return true;
}
