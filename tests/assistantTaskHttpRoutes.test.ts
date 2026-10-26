import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { handleAssistantTaskHttpRoute } from "../src/core/assistant/assistantTaskHttpRoutes.js";

const workspace = path.resolve(os.tmpdir(), "assistant-scope-project");
const sessionId = "session_12345";
type Result = { status: number; body: any; headers: Record<string, string> };
async function scenario(run: (call: (
  method: string, session: string, operation: string, body?: object, options?: {
    workspace?: string; headerWorkspace?: string; validSession?: boolean;
  }) => Promise<Result>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-http-test-"));
  const previous = process.env.SUPERAGENT_CONFIG_DIR;
  process.env.SUPERAGENT_CONFIG_DIR = root;
  try {
    const call = async (
      method: string, session: string, operation: string, body?: object,
      options?: { workspace?: string; headerWorkspace?: string; validSession?: boolean },
    ): Promise<Result> => {
      const ws = options?.workspace ?? workspace;
      const url = new URL("http://localhost/api/assistant/tasks" + operation +
        "?sessionId=" + encodeURIComponent(session) + "&workspace=" + encodeURIComponent(ws));
      const request = {
        method,
        headers: { "x-client-mode": "tline", "x-workspace-path": options?.headerWorkspace ?? ws },
      } as unknown as http.IncomingMessage;
      const captured: Result = { status: 0, body: null, headers: {} };
      const response = {
        setHeader: (key: string, value: string) => { captured.headers[key] = value; },
      } as unknown as http.ServerResponse;
      const handled = await handleAssistantTaskHttpRoute(request, response, url.pathname, url, {
        resolveSession: (_req, id, targetWorkspace) =>
          options?.validSession !== false &&
          (id === sessionId || id === "session_other") && targetWorkspace === workspace
            ? { sessionId: id, workspace, clientMode: "tline" } : null,
        readBody: async () => JSON.stringify(body || {}),
        sendJSON: (_res, status, content) => { captured.status = status; captured.body = content; },
      });
      expect(handled).toBe(true);
      return captured;
    };
    await run(call);
  } finally {
    if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

describe("session-scoped assistant metadata routes", () => {
  it("creates idempotent drafts and reads durable event cursor", async () => scenario(async call => {
    const input = { goalId: "goal1", idempotencyKey: "command1", title: "Audit safely" };
    const first = await call("POST", sessionId, "", input);
    expect(first.status).toBe(200);
    expect(first.body.executionEnabled).toBe(true);
    expect(first.body.executionPolicy).toBe("read-only-explicit-run");
    const second = await call("POST", sessionId, "", input);
    expect(second.body.task.taskId).toBe(first.body.task.taskId);
    const list = await call("GET", sessionId, "");
    expect(list.body.tasks).toHaveLength(1);
    const events = await call("GET", sessionId, "/events");
    expect(events.body.events).toHaveLength(1);
    const cancelled = await call("POST", sessionId, "/" + first.body.task.taskId + "/cancel", {
      expectedRevision: 1,
    });
    expect(cancelled.body.task.status).toBe("cancelled");
    expect((await call("GET", sessionId, "")).body.tasks[0].status).toBe("cancelled");
  }));
  it("keeps a general research task scoped and refuses coding-only patch operations", async () => scenario(async call => {
    const bad = await call("POST", sessionId, "", {
      goalId: "g_bad", idempotencyKey: "bad_mode", title: "Search", domain: "browser",
    });
    expect(bad.status).toBe(400);
    const created = await call("POST", sessionId, "", {
      goalId: "g_research", idempotencyKey: "research1", title: "Compare sources", domain: "research",
    });
    expect(created.status).toBe(200);
    expect(created.body.task.domain).toBe("research");
    const listed = await call("GET", sessionId, "");
    expect(listed.body.tasks[0].domain).toBe("research");
    expect(listed.body.domains.map((d: any) => d.id)).toContain("general");
    expect(listed.body.domains.map((d: any) => d.id)).toContain("planning");
    expect(listed.body.domains.map((d: any) => d.id)).toContain("files");
    expect((await call("POST", sessionId, "/" + created.body.task.taskId + "/prepare",
      { expectedRevision: 1 })).status).toBe(409);
    expect((await call("GET", sessionId, "")).body.tasks[0].status).toBe("queued");
  }));
  it("rejects caller-supplied wrong session/workspace and mismatched workspace header", async () => scenario(async call => {
    expect((await call("GET", "otherSession", "")).status).toBe(403);
    expect((await call("GET", sessionId, "", {}, { workspace: "another-project" })).status).toBe(403);
    expect((await call("GET", sessionId, "", {}, { headerWorkspace: "another-project" })).status).toBe(403);
    expect((await call("GET", sessionId, "", {}, { validSession: false })).status).toBe(403);
  }));
  it("keeps two legitimate concurrent sessions in the same workspace isolated", async () => scenario(async call => {
    const first = await call("POST", sessionId, "", {
      goalId: "goal_1", title: "Only in first", idempotencyKey: "shared_request",
    });
    const second = await call("POST", "session_other", "", {
      goalId: "goal_2", title: "Only in second", idempotencyKey: "shared_request",
    });
    expect(first.body.task.taskId).not.toBe(second.body.task.taskId);
    expect((await call("GET", sessionId, "")).body.tasks.map((t: any) => t.title)).toEqual(["Only in first"]);
    expect((await call("GET", "session_other", "")).body.tasks.map((t: any) => t.title)).toEqual(["Only in second"]);
    expect((await call("GET", "session_other", "/" + first.body.task.taskId)).status).toBe(404);
  }));
  it("never treats a running task as a cancelable draft", async () => scenario(async call => {
    const input = { goalId: "goal2", idempotencyKey: "req2", title: "Existing worker" };
    const created = await call("POST", sessionId, "", input);
    const ownerId = "session_" + createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const workspaceId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
    const store = new AssistantTaskStore(process.env.SUPERAGENT_CONFIG_DIR!, { ownerId, workspaceId });
    const planning = await store.transition({
      taskId: created.body.task.taskId, expectedRevision: 1, status: "planning",
    });
    await store.transition({
      taskId: planning.taskId, expectedRevision: planning.revision, status: "running",
    });
    const rejected = await call("POST", sessionId, "/" + planning.taskId + "/cancel", { expectedRevision: 3 });
    expect(rejected.status).toBe(409);
    expect((await store.get(planning.taskId))?.status).toBe("running");
  }));
  it("exposes exact-scope checkpoint and manual pause/resume without running a worker", async () =>
    scenario(async call => {
      const created = await call("POST", sessionId, "", {
        goalId: "cp_goal", title: "Check task", idempotencyKey: "cp_draft",
      });
      const id = created.body.task.taskId;
      const checkpoint = await call("GET", sessionId, "/" + id + "/checkpoint");
      expect(checkpoint.body.checkpoint).toBe("draft-boundary");
      expect(checkpoint.body.executionResumptionSupported).toBe(false);
      const paused = await call("POST", sessionId, "/" + id + "/pause", {
        expectedRevision: 1,
      });
      expect(paused.status).toBe(200);
      expect(paused.body.task.status).toBe("paused");
      expect(paused.body.executed).toBe(false);
      expect((await call("POST", sessionId, "/" + id + "/run",
        { expectedRevision: 2 })).status).toBe(409);
      expect((await call("POST", "session_other", "/" + id + "/resume",
        { expectedRevision: 2 })).status).toBe(409);
      expect((await call("POST", sessionId, "/" + id + "/resume",
        { expectedRevision: 1 })).status).toBe(409);
      const resumed = await call("POST", sessionId, "/" + id + "/resume",
        { expectedRevision: 2 });
      expect(resumed.body.task.status).toBe("queued");
      expect(resumed.body.task.revision).toBe(3);
      expect(resumed.body.executed).toBe(false);
      expect((await call("GET", sessionId, "/events")).body.events.map((e:any) => e.status))
        .toEqual(["queued","paused","queued"]);
    }));
  it("retries failed work only as a separate draft with explicit idempotency", async () =>
    scenario(async call => {
      const original = await call("POST", sessionId, "", {
        goalId:"retry_goal", title:"Research", idempotencyKey:"first", domain:"research",
      });
      const id = original.body.task.taskId;
      const ownerId = "session_" + createHash("sha256").update(sessionId).digest("hex").slice(0,24);
      const workspaceId = createHash("sha256").update(workspace).digest("hex").slice(0,24);
      const store = new AssistantTaskStore(process.env.SUPERAGENT_CONFIG_DIR!, { ownerId, workspaceId });
      const planning = await store.transition({taskId:id, expectedRevision:1, status:"planning"});
      const running = await store.transition({taskId:id, expectedRevision:planning.revision,status:"running"});
      const failed = await store.transition({taskId:id, expectedRevision:running.revision,status:"failed"});
      const operation = "/" + id + "/retry";
      expect((await call("POST", sessionId, operation, {
        expectedRevision:failed.revision, idempotencyKey: "bad/path",
      })).status).toBe(400);
      const retry = await call("POST", sessionId, operation, {
        expectedRevision:failed.revision, idempotencyKey:"retry_once",
      });
      expect(retry.status).toBe(200);
      expect(retry.body.executed).toBe(false);
      expect(retry.body.task.retryOfTaskId).toBe(id);
      expect(retry.body.task.status).toBe("queued");
      const again = await call("POST", sessionId, operation, {
        expectedRevision:failed.revision,idempotencyKey:"retry_once",
      });
      expect(again.body.task.taskId).toBe(retry.body.task.taskId);
      expect((await call("POST", "session_other", operation, {
        expectedRevision:failed.revision,idempotencyKey:"other_retry",
      })).status).toBe(409);
      const preview = await call("GET", sessionId, "/" + id + "/checkpoint");
      expect(preview.body.checkpoint).toBe("manual-review-only");
      expect(preview.body.executionResumptionSupported).toBe(false);
      expect((await store.list()).filter(task => task.retryOfTaskId === id)).toHaveLength(1);
    }));
  it("blocks unsafe mutation and unknown transition", async () => scenario(async call => {
    const created = await call("POST", sessionId, "", {
      goalId: "goal1", idempotencyKey: "id1", title: "Review",
    });
    const id = created.body.task.taskId;
    expect((await call("POST", sessionId, "/" + id + "/cancel", { expectedRevision: 999 })).status).toBe(409);
    const cancel = await call("POST", sessionId, "/" + id + "/cancel", { expectedRevision: 1 });
    expect(cancel.status).toBe(200);
    expect((await call("POST", sessionId, "/" + id + "/cancel", { expectedRevision: 2 })).status).toBe(409);
    expect((await call("POST", sessionId, "/events", {})).status).toBe(405);
  }));
});
