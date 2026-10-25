import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { handleAssistantTaskHttpRoute } from "../src/core/assistant/assistantTaskHttpRoutes.js";
import { saveDetachedTaskResult } from "../src/core/assistant/assistantTaskResults.js";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";

const project = path.resolve(os.tmpdir(), "detached-task-workspace");
const session = "session_detached_user";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(fn: () => Promise<T>, check: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (check(value)) return value;
    await pause(15);
  }
  throw Error("Timed out waiting for result");
}
describe("explicit detached read-only task route", () => {
  it("starts a verified scoped worker without taking over the parent chat, then returns summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "detached-tasks-"));
    const old = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = root;
    let workerCalls = 0;
    try {
      const call = async (method: string, op: string, payload: any = {},
        sessionId = session) => {
        const url = new URL("http://localhost/api/assistant/tasks" + op +
          "?workspace=" + encodeURIComponent(project) + "&sessionId=" + encodeURIComponent(sessionId));
        const request = { method, headers: {
          "x-workspace-path": project, "x-client-mode": "tline",
        } } as unknown as http.IncomingMessage;
        let result: { status: number; data: any } = { status: 0, data: null };
        const response = { setHeader: () => {} } as unknown as http.ServerResponse;
        await handleAssistantTaskHttpRoute(request, response, url.pathname, url, {
          resolveSession: (_req, id, ws) => id === session && ws === project ?
            { sessionId: id, workspace: project, clientMode: "tline" } : null,
          readBody: async () => JSON.stringify(payload),
          sendJSON: (_res, status, data) => { result = { status, data }; },
          detachedTaskWorker: async (task, workspace, signal) => {
            expect(workspace).toBe(project);
            expect(signal.aborted).toBe(false);
            workerCalls++;
            await saveDetachedTaskResult(task, "Reviewed architecture safely.");
            return ["summary_saved"];
          },
        });
        return result;
      };
      const first = await call("POST", "", {
        goalId: "goal_1", idempotencyKey: "request_1", title: "Review architecture",
      });
      const taskId = first.data.task.taskId;
      expect(first.data.task.status).toBe("queued");
      expect((await call("GET", "/" + taskId + "/result")).status).toBe(404);
      expect((await call("POST", "/" + taskId + "/run", { expectedRevision: 1 })).status).toBe(202);
      expect((await call("POST", "/" + taskId + "/run", { expectedRevision: 1 })).status).toBe(409);
      const done = await waitFor(() => call("GET", "/" + taskId),
        r => r.data?.task?.status === "completed");
      expect(done.data.task.evidenceIds).toEqual(["summary_saved"]);
      expect(workerCalls).toBe(1);
      const summary = await call("GET", "/" + taskId + "/result");
      expect(summary).toMatchObject({ status: 200,
        data: { result: "Reviewed architecture safely." } });
      expect((await call("GET", "/" + taskId + "/result", {}, "another_session")).status).toBe(403);
      expect(await call("GET", "")).toMatchObject({
        status: 200, data: { executionEnabled: true, executionPolicy: "read-only-explicit-run" },
      });
    } finally {
      if (old === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = old;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("signals cancellation to the active worker and never restarts side effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "detached-cancel-"));
    const old = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = root;
    try {
      const ownerId = "session_" + createHash("sha256").update(session).digest("hex").slice(0, 24);
      const workspaceId = createHash("sha256").update(project).digest("hex").slice(0, 24);
      const store = new AssistantTaskStore(root, { ownerId, workspaceId });
      const task = await store.create({ goalId: "goal2", title: "Long read-only work",
        idempotencyKey: "req2" });
      let calls = 0;
      const call = async (op: string, body: any = {}) => {
        const url = new URL("http://localhost/api/assistant/tasks" + op +
          "?workspace=" + encodeURIComponent(project) + "&sessionId=" + session);
        let result: { status: number; data: any } = { status: 0, data: null };
        await handleAssistantTaskHttpRoute({
          method: "POST", headers: { "x-client-mode": "tline", "x-workspace-path": project },
        } as any, { setHeader: () => {} } as any, url.pathname, url, {
          resolveSession: () => ({ sessionId: session, workspace: project, clientMode: "tline" }),
          readBody: async () => JSON.stringify(body),
          sendJSON: (_res, status, data) => { result = { status, data }; },
          detachedTaskWorker: async (_task, _ws, signal) => {
            calls++;
            await new Promise<void>(resolve => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return [];
          },
        });
        return result;
      };
      expect((await call("/" + task.taskId + "/run", { expectedRevision: 1 })).status).toBe(202);
      const running = await waitFor(() => store.get(task.taskId), v => v?.status === "running");
      expect((await call("/" + task.taskId + "/cancel", {
        expectedRevision: running!.revision,
      })).status).toBe(202);
      const cancelled = await waitFor(() => store.get(task.taskId), v => v?.status === "cancelled");
      expect(cancelled?.status).toBe("cancelled");
      expect(calls).toBe(1);
      expect((await call("/" + task.taskId + "/run", { expectedRevision: 1 })).status).toBe(409);
    } finally {
      if (old === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = old;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks orphaned active metadata as unverified without replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "detached-reconcile-"));
    const old = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = root;
    try {
      const ownerId = "session_" + createHash("sha256").update(session).digest("hex").slice(0, 24);
      const workspaceId = createHash("sha256").update(project).digest("hex").slice(0, 24);
      const store = new AssistantTaskStore(root, { ownerId, workspaceId });
      const task = await store.create({ goalId: "g", title: "Unexpected shutdown", idempotencyKey: "k" });
      await store.transition({ taskId: task.taskId, expectedRevision: 1, status: "planning" });
      const url = new URL("http://localhost/api/assistant/tasks?workspace=" +
        encodeURIComponent(project) + "&sessionId=" + session);
      let payload: any = null;
      await handleAssistantTaskHttpRoute({
        method: "GET", headers: { "x-client-mode": "tline", "x-workspace-path": project },
      } as any, { setHeader: () => {} } as any, url.pathname, url, {
        resolveSession: () => ({ sessionId: session, workspace: project, clientMode: "tline" }),
        readBody: async () => "{}",
        sendJSON: (_res, _status, value) => { payload = value; },
      });
      expect(payload.unverifiedTaskIds).toContain(task.taskId);
      expect(payload.liveTaskIds).not.toContain(task.taskId);
      expect((await store.get(task.taskId))?.status).toBe("planning");
    } finally {
      if (old === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = old;
      await rm(root, { recursive: true, force: true });
    }
  });
});
