import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { extractAndValidatePatch, prepareDetachedPatch, readDetachedPatch } from
  "../src/core/assistant/assistantTaskPatch.js";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";

const good = [
  "diff --git a/src/sample.txt b/src/sample.txt",
  "index 8b13789..7d8e5b7 100644",
  "--- a/src/sample.txt",
  "+++ b/src/sample.txt",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
describe("detached coding patch proposal", () => {
  it("permits only reviewable edits of tracked source files", () => {
    expect(extractAndValidatePatch(good).paths).toEqual(["src/sample.txt"]);
    for (const bad of [
      good.replace(/src\/sample\.txt/g, "src/../../outside.txt"),
      good.replace(/src\/sample\.txt/g, ".git/config"),
      good.replace(/src\/sample\.txt/g, "src/.env"),
      good.replace("diff --git a/", "diff --git a/../../"),
      good.replace("@@ -1 +1 @@", "new file mode 120000"),
      good.replace("+++ b/src/sample.txt", "+++ b/other.txt"),
    ]) {
      expect(() => extractAndValidatePatch(bad)).toThrow();
    }
  });
  it("creates detached worktree and persisted review diff; original checkout is not edited", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assistant-patch-"));
    const config = path.join(dir, "config");
    const repo = path.join(dir, "repo");
    const old = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = config;
    try {
      await mkdir(path.join(repo, "src"), { recursive: true });
      git(repo, "init", "-q");
      git(repo, "config", "user.name", "Local Test");
      git(repo, "config", "user.email", "local@example.invalid");
      await writeFile(path.join(repo, "src/sample.txt"), "before\n");
      git(repo, "add", "src/sample.txt");
      git(repo, "commit", "-qm", "test fixture");
      const store = new AssistantTaskStore(config, { ownerId: "owner", workspaceId: "project" });
      const task = await store.create({
        goalId: "patch", idempotencyKey: "single", title: "Change sample",
      });
      const evidence = await prepareDetachedPatch(task, repo, new AbortController().signal,
        async () => good);
      expect(evidence).toEqual(["patch_review_ready"]);
      expect(await readFile(path.join(repo, "src/sample.txt"), "utf8")).toBe("before\n");
      expect(git(repo, "status", "--porcelain")).toBe("");
      const running = await store.transition({ taskId: task.taskId,
        expectedRevision: 1, status: "planning" });
      const started = await store.transition({ taskId: task.taskId,
        expectedRevision: running.revision, status: "running" });
      const completed = await store.transition({ taskId: task.taskId,
        expectedRevision: started.revision, status: "completed", evidenceIds: evidence });
      const diff = await readDetachedPatch(completed);
      expect(diff).toContain("+after");
      expect(diff).toContain("-before");
      await expect(prepareDetachedPatch(task, repo, new AbortController().signal,
        async () => good)).rejects.toThrow("already exists");
    } finally {
      if (old === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = old;
      await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  });
});
