import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTlineLedgerRootForTests } from "../src/core/channels/tlineTaskLedger.js";
import { buildTlineTaskSnapshot, type TlineTaskSummary } from "../src/core/channels/tlineTaskSnapshot.js";
import { recordTaskFeed, replayTaskFeed, latestTaskFeed, encodeTlineSse, forgetTaskFeed } from "../src/core/channels/tlineTaskFeed.js";
import { buildTlineCapabilityManifest } from "../src/core/channels/tlineCapabilities.js";

const task: TlineTaskSummary = {
  schemaVersion: 1, channel: "cli", taskId: "task-1", sessionId: null,
  status: "running", evidence: "unverified", updatedAt: 10,
  authorization: "workspace_scoped", notification: "not_configured",
};
describe("T-Line task SSE journal / replay", () => {
  const root = path.join(os.tmpdir(), "tline-task-feed-vitest-" + process.pid);
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setTlineLedgerRootForTests(root);
    forgetTaskFeed();
  });
  afterAll(() => {
    forgetTaskFeed();
    setTlineLedgerRootForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("advertises authenticated SSE capability independently from snapshot", () => {
    const action = buildTlineCapabilityManifest("test").httpActions.find(a => a.id === "tasks.events");
    expect(action).toEqual({ id: "tasks.events", method: "GET",
      path: "/api/tline/tasks/events", access: "read", transport: "sse" });
  });
  it("generates monotonic event IDs for observed changes, not duplicate heartbeats", () => {
    const first = buildTlineTaskSnapshot("C:/project", [task], []);
    const entry = recordTaskFeed("C:/project", "chat1", first);
    expect(entry?.id).toMatch(/^[a-f0-9]{16}\.1$/);
    expect(recordTaskFeed("C:/project", "chat1", first)).toBeNull();
    const next = buildTlineTaskSnapshot("C:/project", [{ ...task, status: "succeeded", updatedAt: 11 }], []);
    const newer = recordTaskFeed("C:/project", "chat1", next);
    expect(newer?.id).toMatch(/^[a-f0-9]{16}\.2$/);
    expect(replayTaskFeed("C:/project", "chat1", entry!.id).events.map(e => e.id))
      .toEqual([newer!.id]);
    expect(latestTaskFeed("C:/project", "chat1")?.id).toBe(newer!.id);
    expect(encodeTlineSse("snapshot", next, newer!.id)).toContain("event: snapshot\n");
  });
  it("caps concurrent SSE watchers and releases slots idempotently", async () => {
    const { acquireTaskSseSlot } = await import("../src/core/channels/tlineTaskFeed.js");
    const releases: Array<() => void> = [];
    for (let i = 0; i < 24; i++) {
      const release = acquireTaskSseSlot();
      expect(release).not.toBeNull();
      releases.push(release!);
    }
    expect(acquireTaskSseSlot()).toBeNull();
    releases[0]();
    releases[0]();
    const next = acquireTaskSseSlot();
    expect(next).not.toBeNull();
    next!();
    for (const release of releases.slice(1)) release();
  });

  it("does not replay across workspace or session, and signals gap for unknown IDs", () => {
    const one = recordTaskFeed("C:/private", "chatA",
      buildTlineTaskSnapshot("C:/private", [task], []))!;
    expect(replayTaskFeed("C:/private", "chatB", one.id).reset).toBe(true);
    expect(replayTaskFeed("C:/public", "chatA", one.id).reset).toBe(true);
    expect(replayTaskFeed("C:/private", "chatA", "invalid").reset).toBe(true);
    expect(replayTaskFeed("C:/private", "chatA", one.id)).toEqual({ events: [], reset: false });
    forgetTaskFeed("C:/private", "chatA");
    expect(replayTaskFeed("C:/private", "chatA", one.id).reset).toBe(true);
  });
  it("signals a gap once the bounded 64-event history rotates", () => {
    let oldest: string | undefined;
    let previous: string | undefined;
    for (let i = 0; i < 75; i++) {
      const entry = recordTaskFeed("C:/project", "chat",
        buildTlineTaskSnapshot("C:/project", [{ ...task, updatedAt: i + 10 }], []))!;
      if (i === 0) oldest = entry.id;
      if (i === 73) previous = entry.id;
    }
    expect(replayTaskFeed("C:/project", "chat", oldest).reset).toBe(true);
    expect(replayTaskFeed("C:/project", "chat", previous).events).toHaveLength(1);
  });
});
