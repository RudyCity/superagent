import type http from "node:http";
import { createHash } from "node:crypto";
import type { URL } from "node:url";
import { getRootConfigDir } from "../config/paths.js";
import { AssistantTaskStore } from "./assistantTaskStore.js";

/**
 * Explicitly session-bound task metadata endpoints for trusted T-Line clients.
 * These endpoints NEVER spawn, execute, approve, resume, or replay an agent.
 * The server HTTP authorization and trusted workspace gate run before this.
 */
export async function handleAssistantTaskHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
  dependencies: {
    resolveSession: (request: http.IncomingMessage, sessionId?: string, workspace?: string) => {
      sessionId: string; workspace: string; clientMode: string;
    } | null;
    readBody: (request: http.IncomingMessage) => Promise<string>;
    sendJSON: (response: http.ServerResponse, status: number, body: unknown) => void;
  },
): Promise<boolean> {
  if (pathname !== "/api/assistant/tasks" &&
      pathname !== "/api/assistant/tasks/events" &&
      !/^\/api\/assistant\/tasks\/[a-f\d-]{36}(?:\/cancel)?$/.test(pathname)) return false;
  const { sendJSON } = dependencies;
  const respond = (status: number, data: unknown) => {
    res.setHeader("Cache-Control", "no-store");
    sendJSON(res, status, data);
  };
  if (req.method !== "GET" && req.method !== "POST") {
    respond(405, { error: "Method not supported" });
    return true;
  }
  const sessionId = url.searchParams.get("sessionId") || "";
  const workspace = url.searchParams.get("workspace") || "";
  const requestWorkspace = req.headers["x-workspace-path"];
  const clientMode = req.headers["x-client-mode"];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) ||
      !workspace || workspace.length > 4096 ||
      typeof requestWorkspace !== "string" ||
      typeof clientMode !== "string" || clientMode !== "tline") {
    respond(400, { error: "Explicit T-Line session and workspace required" });
    return true;
  }
  // Scope to the fully resolved and server-owned session, not an arbitrary
  // caller-provided ownerId, projectId, or claimed pathname.
  const session = dependencies.resolveSession(req, sessionId, workspace);
  if (!session || session.sessionId !== sessionId || session.clientMode !== "tline" ||
      session.workspace !== workspace || requestWorkspace !== workspace) {
    respond(403, { error: "No matching active session/workspace" });
    return true;
  }
  const ownerId = "session_" + createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const workspaceId = createHash("sha256").update(session.workspace).digest("hex").slice(0, 24);
  const store = new AssistantTaskStore(getRootConfigDir(), { ownerId, workspaceId });
  const suffix = pathname.slice("/api/assistant/tasks".length);
  try {
    if (req.method === "GET" && suffix === "") {
      respond(200, { success: true, sessionId, tasks: await store.list(100), executionEnabled: false });
      return true;
    }
    if (req.method === "GET" && suffix === "/events") {
      const rawCursor = url.searchParams.get("cursor") || "0";
      if (!/^\d{1,15}$/.test(rawCursor)) {
        respond(400, { error: "Invalid event cursor" });
        return true;
      }
      respond(200, { success: true, sessionId, ...await store.eventsAfter(Number(rawCursor), 100) });
      return true;
    }
    if (req.method === "GET" && /^\/[a-f\d-]{36}$/.test(suffix)) {
      const taskId = suffix.slice(1);
      const task = await store.get(taskId);
      respond(task ? 200 : 404, task ? { success: true, task } : { error: "Task not found" });
      return true;
    }
    if (req.method === "POST" && (suffix === "" || /^\/[a-f\d-]{36}\/cancel$/.test(suffix))) {
      const serialized = await dependencies.readBody(req);
      if (Buffer.byteLength(serialized) > 4096) {
        respond(413, { error: "Task request exceeds limit" });
        return true;
      }
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(serialized || "{}");
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
        body = parsed as Record<string, unknown>;
      } catch {
        respond(400, { error: "Invalid JSON object" });
        return true;
      }
      if (suffix === "") {
        if (typeof body.goalId !== "string" ||
            typeof body.title !== "string" ||
            typeof body.idempotencyKey !== "string") {
          respond(400, { error: "Missing goalId, title or idempotencyKey" });
          return true;
        }
        const task = await store.create({
          goalId: body.goalId, title: body.title, idempotencyKey: body.idempotencyKey,
        });
        respond(200, { success: true, task, executionEnabled: false });
        return true;
      }
      if (!Number.isSafeInteger(body.expectedRevision)) {
        respond(400, { error: "Expected revision required" });
        return true;
      }
      // Restrict this control to queued drafts; execution cancellation belongs
      // to the real worker runtime. The revision guard catches races after read.
      const current = await store.get(suffix.slice(1, 37));
      if (!current || current.status !== "queued") {
        respond(409, { error: "Only queued drafts may be cancelled" });
        return true;
      }
      const task = await store.transition({
        taskId: suffix.slice(1, 37), expectedRevision: body.expectedRevision as number,
        status: "cancelled",
      });
      respond(200, { success: true, task });
      return true;
    }
    respond(405, { error: "Unsupported task action" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/Invalid|Illegal transition|Idempotency|capacity|revision|Task not found|Task event/.test(message)) {
      respond(message.includes("conflict") || message.includes("Illegal") ? 409 : 400, { error: message });
    } else {
      // Neither journal internals nor arbitrary exception values cross HTTP.
      respond(503, { error: "Task journal unavailable; existing data preserved" });
    }
  }
  return true;
}
