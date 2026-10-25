import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { prepareDetachedPatch } from "../src/core/assistant/assistantTaskPatch.js";
import { handleAssistantTaskHttpRoute } from "../src/core/assistant/assistantTaskHttpRoutes.js";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";

const patch = [
  "diff --git a/src/sample.txt b/src/sample.txt",
  "index 8b13789..7d8e5b7 100644",
  "--- a/src/sample.txt",
  "+++ b/src/sample.txt",
  "@@ -1 +1 @@",
  "-before",
  "+after", "",
].join("\n");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe("session-scoped isolated patch HTTP workflow", () => {
  it("creates, schedules, and reviews without changing original checkout or exposing another session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "task-patch-http-"));
    const repo = path.join(dir, "repo");
    const config = path.join(dir, "config");
    const previous = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = config;
    try {
      await mkdir(path.join(repo, "src"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args],
        { encoding: "utf8", windowsHide: true });
      git("init", "-q");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "Test Fixture");
      await writeFile(path.join(repo, "src/sample.txt"), "before\n");
      git("add", "src/sample.txt");
      git("commit", "-qm", "fixture");
      const sessionId = "session_review";
      const run = async (method: string, route: string, body: any = {}, currentSession = sessionId) => {
        const url = new URL("http://localhost/api/assistant/tasks" + route +
          "?workspace=" + encodeURIComponent(repo) + "&sessionId=" + currentSession);
        let status = 0, output: any;
        await handleAssistantTaskHttpRoute({
          method, headers: { "x-workspace-path": repo, "x-client-mode": "tline" },
        } as http.IncomingMessage, { setHeader: () => {} } as any,
        url.pathname, url, {
          resolveSession: (_req, id, ws) => id === sessionId && ws === repo ?
            { sessionId, workspace: repo, clientMode: "tline" } : null,
          readBody: async () => JSON.stringify(body),
          sendJSON: (_res, code, value) => { status = code; output = value; },
          detachedPatchWorker: (task, workspace, signal) =>
            prepareDetachedPatch(task, workspace, signal, async () => patch),
        });
        return { status, output };
      };
      const created = await run("POST", "", {
        goalId: "goal_1", title: "Fix sample", idempotencyKey: "first", domain: "coding",
      });
      expect(created.status).toBe(200);
      const taskId = created.output.task.taskId;
      const ready = await run("POST", "/" + taskId + "/prepare", { expectedRevision: 1 });
      expect(ready).toMatchObject({ status: 202,
        output: { executionPolicy: "isolated-patch-preview" } });
      const duplicate = await run("POST", "/" + taskId + "/prepare", { expectedRevision: 1 });
      expect(duplicate.status).toBe(409);
      const store = new AssistantTaskStore(config, {
        ownerId: "session_" + createHash("sha256").update(sessionId).digest("hex").slice(0,24),
        workspaceId: createHash("sha256").update(repo).digest("hex").slice(0,24),
      });
      let completed = false;
      for (let i = 0; i < 150; i++) {
        completed = (await store.get(taskId))?.status === "completed";
        if (completed) break;
        await sleep(20);
      }
      expect(completed).toBe(true);
      const review = await run("GET", "/" + taskId + "/patch");
      expect(review.status).toBe(200);
      expect(review.output.patch).toContain("+after");
      expect((await run("GET", "/" + taskId + "/patch", {}, "other_user")).status).toBe(403);
      expect(git("status", "--porcelain")).toBe("");
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = previous;
      await rm(dir, { force: true, recursive: true, maxRetries: 2, retryDelay: 50 });
    }
  });
});
