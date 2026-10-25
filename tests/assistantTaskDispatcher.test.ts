import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";
import { AssistantTaskDispatcher } from "../src/core/assistant/assistantTaskDispatcher.js";

async function fixture(run: (store: AssistantTaskStore) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-dispatch-test-"));
  try {
    await run(new AssistantTaskStore(root, { ownerId: "local", workspaceId: "sample" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("persistent assistant task dispatcher", () => {
  it("runs independent tasks concurrently, respecting the capacity bound", async () => fixture(async store => {
    const tasks = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      store.create({ goalId: "goal", title: "Task " + i, idempotencyKey: "req_" + i })));
    const dispatcher = new AssistantTaskDispatcher(store, 2);
    let running = 0, maximum = 0;
    const runs = tasks.map(task => dispatcher.submit(task, [
      { key: "file_" + task.idempotencyKey, mode: "write" },
    ], async () => {
      running++;
      maximum = Math.max(maximum, running);
      await sleep(35);
      running--;
      return ["artifact_verified"];
    }));
    const results = await Promise.all(runs);
    expect(maximum).toBe(2);
    expect(results.every(t => t.status === "completed")).toBe(true);
    expect((await store.list()).every(t => t.evidenceIds[0] === "artifact_verified")).toBe(true);
    expect(dispatcher.status.running).toBe(0);
  }));

  it("serializes write collisions but permits multiple reads", async () => fixture(async store => {
    const tasks = await Promise.all(Array.from({ length: 3 }, (_, i) =>
      store.create({ goalId: "goal", title: "Task " + i, idempotencyKey: "req_" + i })));
    const dispatcher = new AssistantTaskDispatcher(store, 3);
    let writers = 0, maxWriters = 0;
    const first = dispatcher.submit(tasks[0], [{ key: "shared", mode: "write" }], async () => {
      writers++;
      maxWriters = Math.max(maxWriters, writers);
      await sleep(55);
      writers--;
    });
    const second = dispatcher.submit(tasks[1], [{ key: "shared", mode: "write" }], async () => {
      writers++;
      maxWriters = Math.max(maxWriters, writers);
      await sleep(10);
      writers--;
    });
    const third = dispatcher.submit(tasks[2], [{ key: "unrelated", mode: "read" }], async () => {
      await sleep(10);
    });
    await Promise.all([first, second, third]);
    expect(maxWriters).toBe(1);
  }));

  it("does not execute a failed claim or replay terminal tasks", async () => fixture(async store => {
    const task = await store.create({ goalId: "goal", title: "Task", idempotencyKey: "req" });
    const dispatcher = new AssistantTaskDispatcher(store, 1);
    await store.transition({ taskId: task.taskId, expectedRevision: 1, status: "planning" });
    let executions = 0;
    await expect(dispatcher.submit(task, [], async () => { executions++; }))
      .rejects.toThrow("revision conflict");
    expect(executions).toBe(0);
  }));

  it("persists failure without auto-restarting side effects", async () => fixture(async store => {
    const task = await store.create({ goalId: "goal", title: "Task", idempotencyKey: "req" });
    const dispatcher = new AssistantTaskDispatcher(store, 1);
    let called = 0;
    await expect(dispatcher.submit(task, [], async () => {
      called++;
      throw new Error("untrusted worker secret");
    })).rejects.toThrow("untrusted worker secret");
    expect(called).toBe(1);
    const [persisted] = await store.list();
    expect(persisted.status).toBe("failed");
    expect(JSON.stringify(await store.eventsAfter())).not.toContain("untrusted worker secret");
    expect(() => dispatcher.submit(persisted, [], async () => {})).toThrow("not eligible");
  }));
});
