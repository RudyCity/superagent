import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTlineTaskSnapshot, type TlineTaskSummary } from "../src/core/channels/tlineTaskSnapshot.js";
import { recordTaskFeed, replayTaskFeed, __clearTaskFeedMemoryForTests, forgetTaskFeed } from "../src/core/channels/tlineTaskFeed.js";
import { deleteTlineTaskLedger, loadTlineTaskLedger, saveTlineTaskLedger,
  setTlineLedgerRootForTests, tlineLedgerScope } from "../src/core/channels/tlineTaskLedger.js";

const root = path.join(os.tmpdir(), "tline-ledger-test-" + process.pid);
const mine = "D:/alpha";
const chat = "sess_alpha";
const task: TlineTaskSummary = {
  schemaVersion: 1, channel: "cli", taskId: "safe-id", sessionId: null,
  status: "running", evidence: "unverified", authorization: "workspace_scoped",
  notification: "not_configured", updatedAt: 4,
};
describe("durable TLine observed-task ledger", () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setTlineLedgerRootForTests(root);
    __clearTaskFeedMemoryForTests();
  });
  afterAll(() => {
    __clearTaskFeedMemoryForTests();
    setTlineLedgerRootForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("persists only bounded observed task metadata and opaque scope file names", () => {
    const event = recordTaskFeed(mine, chat, buildTlineTaskSnapshot(mine,
      [{ ...task, sessionId: "sess-secret", privateField: "SECRET_OUTPUT" } as any], []));
    expect(event).not.toBeNull();
    const names = fs.readdirSync(root);
    expect(names).toEqual([tlineLedgerScope(mine, chat) + ".json"]);
    const text = fs.readFileSync(path.join(root, names[0]), "utf8");
    expect(text).not.toContain(mine);
    expect(text).not.toContain(chat);
    expect(text).not.toContain("sess-secret");
    expect(text).not.toContain("SECRET_OUTPUT");
    expect(loadTlineTaskLedger(mine, chat)?.events[0].data.tasks?.[0].sessionId).toBeNull();
    expect(loadTlineTaskLedger(mine, chat)?.events[0].id).toBe(event?.id);
    expect(loadTlineTaskLedger(mine, "sess_other")).toBeNull();
  });
  it("recovers observed event IDs after a simulated server restart, while disclosing observation gaps", () => {
    const first = recordTaskFeed(mine, chat,
      buildTlineTaskSnapshot(mine, [task], []))!;
    const second = recordTaskFeed(mine, chat,
      buildTlineTaskSnapshot(mine, [{ ...task, status: "succeeded", updatedAt: 5 }], []))!;
    __clearTaskFeedMemoryForTests();
    const recovered = replayTaskFeed(mine, chat, first.id);
    expect(recovered.reset).toBe(false);
    expect(recovered.recovered).toBe(true);
    expect(recovered.events.map(e => e.id)).toEqual([second.id]);
    expect(replayTaskFeed(mine, "foreign-chat", first.id).reset).toBe(true);
    const third = recordTaskFeed(mine, chat,
      buildTlineTaskSnapshot(mine, [{ ...task, status: "failed", updatedAt: 6 }], []))!;
    expect(third.id).toMatch(/\.3$/);
    expect(third.id.split(".")[0]).toBe(first.id.split(".")[0]);
    expect(loadTlineTaskLedger(mine, chat)?.events).toHaveLength(3);
  });
  it("rejects corrupt files and expired stores without leaking other session events", () => {
    const event = recordTaskFeed(mine, chat,
      buildTlineTaskSnapshot(mine, [task], []))!;
    const filename = path.join(root, tlineLedgerScope(mine, chat) + ".json");
    const data = JSON.parse(fs.readFileSync(filename, "utf8"));
    fs.writeFileSync(filename, JSON.stringify({ ...data, scope: tlineLedgerScope(mine, "other") }));
    expect(loadTlineTaskLedger(mine, chat)).toBeNull();
    fs.writeFileSync(filename, JSON.stringify({ ...data, savedAt: Date.now() - 25 * 60 * 60_000 }));
    expect(loadTlineTaskLedger(mine, chat)).toBeNull();
    fs.writeFileSync(filename, "not-json");
    __clearTaskFeedMemoryForTests();
    expect(replayTaskFeed(mine, chat, event.id).reset).toBe(true);
  });
  it("bounds store size, sequence, and refuses invalid metadata / symlink paths", () => {
    expect(saveTlineTaskLedger(mine, chat, "invalid", 1, [])).toBe(false);
    expect(saveTlineTaskLedger(mine, chat, "a".repeat(16), Number.MAX_SAFE_INTEGER + 1, [])).toBe(false);
    const event = recordTaskFeed(mine, chat,
      buildTlineTaskSnapshot(mine, [task], []))!;
    const file = path.join(root, tlineLedgerScope(mine, chat) + ".json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.events = Array(65).fill(event);
    fs.writeFileSync(file, JSON.stringify(data));
    expect(loadTlineTaskLedger(mine, chat)).toBeNull();
    deleteTlineTaskLedger(mine, chat);
    expect(fs.existsSync(file)).toBe(false);
  });
});
