import type http from "node:http";
import { createHash } from "node:crypto";
import type { URL } from "node:url";
import { getRootConfigDir } from "../config/paths.js";
import { AssistantTaskStore } from "./assistantTaskStore.js";
import { getDetachedTaskRuntime, executeDetachedReadOnlyAgent, type DetachedTaskWorker } from "./assistantTaskRuntime.js";
import { readDetachedTaskResult } from "./assistantTaskResults.js";
import { prepareDetachedPatch, readDetachedPatch } from "./assistantTaskPatch.js";
import { TASK_DOMAIN_DESCRIPTORS, DEFAULT_ASSISTANT_TASK_DOMAIN, validAssistantTaskDomain } from "./assistantTaskDomains.js";

/**
 * Session-bound task drafts and explicit read-only worker controls for T-Line.
 * Only POST /:id/run can schedule a new isolated worker; GET is non-mutating.
 * Nothing replays a previously started task after a crash or disconnect.
 * Core HTTP auth and trusted workspace policy execute before these routes.
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
    detachedTaskWorker?: DetachedTaskWorker;
    detachedPatchWorker?: DetachedTaskWorker;
  },
): Promise<boolean> {
  if (pathname !== "/api/assistant/tasks" &&
      pathname !== "/api/assistant/tasks/events" &&
      !/^\/api\/assistant\/tasks\/[a-f\d-]{36}(?:\/(?:cancel|run|result|prepare|patch|reconcile))?$/.test(pathname)) return false;
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
  const scope = { ownerId, workspaceId };
  const store = new AssistantTaskStore(getRootConfigDir(), scope);
  const runtime = getDetachedTaskRuntime(store, scope);
  const suffix = pathname.slice("/api/assistant/tasks".length);
  try {
    if (req.method === "GET" && suffix === "") {
      const tasks = await store.list(100);
      const liveTaskIds = runtime.liveIds;
      respond(200, { success: true, sessionId, tasks, executionEnabled: true,
        executionPolicy: "read-only-explicit-run", supportedModes: ["analysis", "patch-preview"],
        domains: TASK_DOMAIN_DESCRIPTORS.map(({ id, label, description, patchPreview }) =>
          ({ id, label, description, patchPreview })), liveTaskIds,
        unverifiedTaskIds: tasks.filter(t => (t.status === "running" || t.status === "planning") &&
          !liveTaskIds.includes(t.taskId)).map(t => t.taskId) });
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
    if (req.method === "GET" && /^\/[a-f\d-]{36}\/result$/.test(suffix)) {
      const task = await store.get(suffix.slice(1, 37));
      if (!task) { respond(404, { error: "Task not found" }); return true; }
      const result = await readDetachedTaskResult(task);
      respond(result === null ? 404 : 200, result === null ?
        { error: "No verified result available" } : { success: true, taskId: task.taskId, result });
      return true;
    }
    if (req.method === "GET" && /^\/[a-f\d-]{36}\/patch$/.test(suffix)) {
      const task = await store.get(suffix.slice(1, 37));
      if (!task) { respond(404, { error: "Task not found" }); return true; }
      const patch = await readDetachedPatch(task);
      respond(patch === null ? 404 : 200, patch === null ?
        { error: "No verified patch available" } :
        { success: true, taskId: task.taskId, patch });
      return true;
    }
    if (req.method === "POST" && (suffix === "" ||
        /^\/[a-f\d-]{36}\/(?:cancel|run|prepare|reconcile)$/.test(suffix))) {
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
        const domain = body.domain ?? DEFAULT_ASSISTANT_TASK_DOMAIN;
        if (!validAssistantTaskDomain(domain)) {
          respond(400, { error: "Unsupported assistant task domain" });
          return true;
        }
        const task = await store.create({
          goalId: body.goalId, title: body.title, idempotencyKey: body.idempotencyKey, domain,
        });
        respond(200, { success: true, task, executionEnabled: true,
          executionPolicy: "read-only-explicit-run" });
        return true;
      }
      if (!Number.isSafeInteger(body.expectedRevision)) {
        respond(400, { error: "Expected revision required" });
        return true;
      }
      const taskId = suffix.slice(1, 37);
      const current = await store.get(taskId);
      if (!current || current.revision !== body.expectedRevision) {
        respond(409, { error: "Task missing or revision conflict" });
        return true;
      }
      if (suffix.endsWith("/reconcile")) {
        if (runtime.liveIds.includes(taskId)) {
          respond(409, { error: "Task worker still active; cannot reconcile" });
          return true;
        }
        if (current.status !== "planning" && current.status !== "running" &&
            current.status !== "interrupted") {
          respond(409, { error: "Only orphaned or interrupted tasks can be reconciled" });
          return true;
        }
        const task = await store.transition({ taskId, expectedRevision: current.revision,
          status: current.status === "interrupted" ? "reconcile_required" : "interrupted" });
        respond(200, { success: true, task, replayed: false });
        return true;
      }
      if (suffix.endsWith("/run") || suffix.endsWith("/prepare")) {
        if (current.status !== "queued") {
          respond(409, { error: "Only queued drafts can be started" });
          return true;
        }
        const isPatch = suffix.endsWith("/prepare");
        if (isPatch && current.domain !== "coding") {
          respond(409, { error: "Patch proposals require a coding task" });
          return true;
        }
        runtime.start(current, session.workspace,
          isPatch ? (dependencies.detachedPatchWorker ?? prepareDetachedPatch) :
            (dependencies.detachedTaskWorker ?? executeDetachedReadOnlyAgent));
        respond(202, { success: true, taskId, scheduled: true,
          executionPolicy: isPatch ? "isolated-patch-preview" : "read-only-explicit-run" });
        return true;
      }
      if (current.status === "queued") {
        const cancelled = await store.transition({
          taskId, expectedRevision: current.revision, status: "cancelled",
        });
        respond(200, { success: true, task: cancelled });
        return true;
      }
      if (current.status === "planning" || current.status === "running") {
        const requested = runtime.cancel(taskId);
        respond(requested ? 202 : 409, requested ?
          { success: true, cancellationRequested: true, taskId } :
          { error: "Worker not owned by this core; reconcile before retry" });
        return true;
      }
      respond(409, { error: "Task is not cancellable" });
      return true;
    }
    respond(405, { error: "Unsupported task action" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/Invalid|Illegal transition|Idempotency|capacity|revision|Task not found|Task event|not eligible/.test(message)) {
      respond(message.includes("conflict") || message.includes("Illegal") ||
        message.includes("not eligible") ? 409 : 400, { error: message });
    } else {
      // Neither journal internals nor arbitrary exception values cross HTTP.
      respond(503, { error: "Task journal unavailable; existing data preserved" });
    }
  }
  return true;
}
