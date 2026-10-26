import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-task-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const owner = { ownerId: "local", workspaceId: "project_1" };
describe("assistant persistent task journal", () => {
  it("deduplicates a create attempt and retains status across store instances", async () => fixture(async root => {
    const a = new AssistantTaskStore(root, owner);
    const one = await a.create({ goalId: "g1", idempotencyKey: "idem_1", title: "Audit app" });
    const two = await new AssistantTaskStore(root, owner)
      .create({ goalId: "g1", idempotencyKey: "idem_1", title: "Audit app" });
    expect(two.taskId).toBe(one.taskId);
    const next = await a.transition({ taskId: one.taskId, expectedRevision: 1, status: "planning" });
    const running = await a.transition({ taskId: one.taskId, expectedRevision: 2, status: "running" });
    expect(running.revision).toBe(3);
    const restored = await new AssistantTaskStore(root, owner).list();
    expect(restored).toHaveLength(1);
    expect(restored[0].status).toBe("running");
    expect(next.status).toBe("planning");
    const e = await a.eventsAfter(1);
    expect(e.events.map(v => v.status)).toEqual(["planning", "running"]);
    expect(e.nextCursor).toBe(3);
  }));
  it("rejects stale revisions, illegal transitions and conflicting idempotency", async () => fixture(async root => {
    const store = new AssistantTaskStore(root, owner);
    const task = await store.create({ goalId: "g1", title: "Review", idempotencyKey: "request_1" });
    await expect(store.create({ goalId: "g2", title: "Other", idempotencyKey: "request_1" }))
      .rejects.toThrow("Idempotency");
    await expect(store.transition({ taskId: task.taskId, expectedRevision: 1, status: "completed" }))
      .rejects.toThrow("Illegal transition");
    await store.transition({ taskId: task.taskId, expectedRevision: 1, status: "planning" });
    await expect(store.transition({ taskId: task.taskId, expectedRevision: 1, status: "running" }))
      .rejects.toThrow("revision conflict");
    const current = (await store.list())[0];
    expect(current.revision).toBe(2);
  }));
  it("isolates task records by owner and workspace", async () => fixture(async root => {
    const first = new AssistantTaskStore(root, owner);
    await first.create({ goalId: "g1", title: "Private", idempotencyKey: "req" });
    expect(await new AssistantTaskStore(root, { ownerId: "other", workspaceId: "project_1" }).list()).toEqual([]);
    expect(await new AssistantTaskStore(root, { ownerId: "local", workspaceId: "project_2" }).list()).toEqual([]);
    expect(() => new AssistantTaskStore(root, { ownerId: "../escape", workspaceId: "project_1" }))
      .toThrow("Invalid ownerId");
  }));
  it("fails closed on corrupted journal and preserves it", async () => fixture(async root => {
    const store = new AssistantTaskStore(root, owner);
    await store.create({ goalId: "g1", title: "Task", idempotencyKey: "req" });
    const dir = path.join(root, "assistant-tasks");
    const { readdir, writeFile } = await import("node:fs/promises");
    const file = path.join(dir, (await readdir(dir))[0]);
    await writeFile(file, '{"schemaVersion":999}');
    await expect(store.list()).rejects.toThrow("Unsupported or corrupted");
    expect(await readFile(file, "utf8")).toContain("999");
  }));
  it("serializes concurrent independent submissions across store instances", async () => fixture(async root => {
    const tasks = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      new AssistantTaskStore(root, owner).create({
        goalId: "g1", title: "Task " + index, idempotencyKey: "req_" + index,
      })));
    expect(new Set(tasks.map(t => t.taskId)).size).toBe(8);
    const store = new AssistantTaskStore(root, owner);
    expect(await store.list()).toHaveLength(8);
    expect((await store.eventsAfter(0)).events).toHaveLength(8);
  }));
  it("persists each selected assistant domain and rejects idempotency domain changes", async () => fixture(async root => {
    const store = new AssistantTaskStore(root, owner);
    const research = await store.create({
      goalId: "research", title: "Look up sources", idempotencyKey: "domain1", domain: "research",
    });
    expect(research.domain).toBe("research");
    expect((await new AssistantTaskStore(root, owner).get(research.taskId))?.domain).toBe("research");
    await expect(store.create({
      goalId: "research", title: "Look up sources", idempotencyKey: "domain1", domain: "coding",
    })).rejects.toThrow("Idempotency");
    await expect(store.create({
      goalId: "other", title: "Unsupported", idempotencyKey: "domain2", domain: "browser" as any,
    })).rejects.toThrow("Invalid assistant task domain");
  }));
  it("persists a paused pre-execution checkpoint and resumes only to an unstarted draft", async () =>
    fixture(async root => {
      const store = new AssistantTaskStore(root, owner);
      const draft = await store.create({ goalId: "g_checkpoint", title: "Plan report",
        idempotencyKey: "pause_one" });
      const paused = await store.transition({
        taskId: draft.taskId, expectedRevision: draft.revision, status: "paused",
      });
      expect(paused.status).toBe("paused");
      const restarted = new AssistantTaskStore(root, owner);
      expect((await restarted.get(draft.taskId))?.status).toBe("paused");
      await expect(restarted.transition({
        taskId: draft.taskId, expectedRevision: paused.revision, status: "planning",
      })).rejects.toThrow("Illegal transition");
      await expect(restarted.transition({
        taskId: draft.taskId, expectedRevision: draft.revision, status: "queued",
      })).rejects.toThrow("revision conflict");
      const resumed = await restarted.transition({
        taskId: draft.taskId, expectedRevision: paused.revision, status: "queued",
      });
      expect(resumed.revision).toBe(3);
      expect((await store.eventsAfter(0)).events.map(e => e.status))
        .toEqual(["queued", "paused", "queued"]);
      expect((await store.get(draft.taskId))?.status).toBe("queued");
    }));
  it("clones only terminal attempts to unique, unstarted, idempotent retry drafts", async () =>
    fixture(async root => {
      const store = new AssistantTaskStore(root, owner);
      const source = await store.create({ goalId: "retry_goal", title: "Check logs",
        idempotencyKey: "old_attempt", domain: "research" });
      await expect(store.retryAsDraft({
        taskId: source.taskId, expectedRevision: source.revision, idempotencyKey: "retry1",
      })).rejects.toThrow("terminal reviewed");
      const planning = await store.transition({ taskId: source.taskId,
        expectedRevision: source.revision, status: "planning" });
      const running = await store.transition({ taskId: source.taskId,
        expectedRevision: planning.revision, status: "running" });
      const failed = await store.transition({ taskId: source.taskId,
        expectedRevision: running.revision, status: "failed" });
      await expect(store.retryAsDraft({taskId: source.taskId,
        expectedRevision: running.revision, idempotencyKey: "retry1"}))
        .rejects.toThrow("revision conflict");
      const created = await store.retryAsDraft({taskId: source.taskId,
        expectedRevision: failed.revision, idempotencyKey: "retry1"});
      const replay = await new AssistantTaskStore(root, owner).retryAsDraft({
        taskId: source.taskId, expectedRevision: failed.revision, idempotencyKey: "retry1",
      });
      expect(created.taskId).not.toBe(source.taskId);
      expect(replay.taskId).toBe(created.taskId);
      expect(created.retryOfTaskId).toBe(source.taskId);
      expect(created.domain).toBe("research");
      expect(created.status).toBe("queued");
      expect(created.revision).toBe(1);
      expect(created.evidenceIds).toEqual([]);
      expect((await store.eventsAfter(0)).events.at(-1)?.taskId).toBe(created.taskId);
      const foreign = new AssistantTaskStore(root, {ownerId:"other",workspaceId:owner.workspaceId});
      await expect(foreign.retryAsDraft({taskId:source.taskId,
        expectedRevision:failed.revision,idempotencyKey:"retry_other"}))
        .rejects.toThrow("revision conflict");
      await expect(store.retryAsDraft({taskId:source.taskId,
        expectedRevision:failed.revision,idempotencyKey:"old_attempt"}))
        .rejects.toThrow("Idempotency");
    }));
  it("opens legacy domainless v1 journals without reclassifying their tasks", async () => fixture(async root => {
    const store = new AssistantTaskStore(root, owner);
    const created = await store.create({
      goalId: "legacy", title: "Old task", idempotencyKey: "old1",
    });
    const { readdir, writeFile } = await import("node:fs/promises");
    const directory = path.join(root, "assistant-tasks");
    const file = path.join(directory, (await readdir(directory))[0]);
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    delete snapshot.tasks[0].domain;
    await writeFile(file, JSON.stringify(snapshot));
    expect((await new AssistantTaskStore(root, owner).get(created.taskId))?.domain).toBe("analysis");
    // A read does not silently replace or rewrite the original journal.
    expect((await readFile(file, "utf8"))).not.toContain('"domain"');
  }));
  it("does not steal an unknown writer lock", async () => fixture(async root => {
    const store = new AssistantTaskStore(root, owner);
    await store.create({ goalId: "g1", title: "Task", idempotencyKey: "req" });
    const dir = path.join(root, "assistant-tasks");
    const { readdir, writeFile, unlink } = await import("node:fs/promises");
    const file = (await readdir(dir)).find(name => name.endsWith(".json"))!;
    const lock = path.join(dir, file + ".lock");
    await writeFile(lock, "other writer");
    await expect(store.create({ goalId: "g2", title: "Waiting", idempotencyKey: "req2" }))
      .rejects.toThrow("Task journal busy");
    await unlink(lock);
    expect(await store.list()).toHaveLength(1);
  }));
});
