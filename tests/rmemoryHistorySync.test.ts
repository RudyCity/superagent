import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const harness = vi.hoisted(() => ({
  rootDir: "",
  sessions: [] as Array<{ id: string; filePath: string }>,
  stored: new Map<string, any>(),
  addConversation: vi.fn(),
  enabled: true,
}));

vi.mock("../src/core/config.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getSettings: () => ({ enableRmemory: harness.enabled }),
  listHistorySessions: () => harness.sessions,
}));
vi.mock("../src/core/config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getRootConfigDir: () => harness.rootDir,
}));
vi.mock("../src/core/storage/historyDb.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  loadSessionFromDb: (id: string) => harness.stored.get(id) ?? { session: null, messages: [] },
}));
vi.mock("../src/core/rmemoryUtil.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getRMemoryClient: () => ({ addConversation: harness.addConversation }),
  getRMemoryProjectId: (cwd: string) => "project:" + cwd,
  getRMemorySessionKey: (historyPath: string) => "session:" + historyPath,
}));

import { syncAllHistoryToRMemory } from "../src/core/historySearch.js";

describe("resumable RMemory history backfill", () => {
  beforeEach(() => {
    harness.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rmemory-sync-regression-"));
    harness.sessions = [{ id: "s1", filePath: "C:/workspace/history/s1.json" }];
    harness.stored = new Map([["s1", {
      session: { id: "s1", workingDirectory: "C:/workspace", filePath: "C:/workspace/history/s1.json" },
      messages: [{ role: "user", content: "hello", timestamp: 1761000000000 }],
    }]]);
    harness.enabled = true;
    harness.addConversation.mockReset().mockResolvedValue({ accepted_ids: ["one"], total_count: 1 });
  });
  afterEach(() => {
    fs.rmSync(harness.rootDir, { recursive: true, force: true });
  });

  it("reindexes legacy session arrays with explicit project scope, then skips unchanged sessions", async () => {
    const root = path.join(harness.rootDir, "rmemory");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "synced_sessions.json"), JSON.stringify(["s1"]));
    await syncAllHistoryToRMemory();
    expect(harness.addConversation).toHaveBeenCalledTimes(1);
    expect(harness.addConversation).toHaveBeenCalledWith({
      session_id: "session:C:/workspace/history/s1.json",
      projectId: "project:C:/workspace",
      messages: [{ role: "user", content: "hello", timestamp: new Date(1761000000000).toISOString() }],
    });
    const registry = JSON.parse(fs.readFileSync(path.join(root, "synced_sessions.json"), "utf8"));
    expect(registry.version).toBe(2);
    expect(Object.keys(registry.sessions)).toEqual(["project:C:/workspace:s1"]);
    await syncAllHistoryToRMemory();
    expect(harness.addConversation).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, "history-sync.lock"))).toBe(false);
  });

  it("imports appended messages on subsequent syncs, retaining stable identity", async () => {
    await syncAllHistoryToRMemory();
    harness.stored.get("s1").messages.push({ role: "assistant", content: "answer", timestamp: 1761000001000 });
    await syncAllHistoryToRMemory();
    expect(harness.addConversation).toHaveBeenCalledTimes(2);
    expect(harness.addConversation.mock.calls[1][0].messages).toHaveLength(1);
    expect(harness.addConversation.mock.calls[1][0].messages[0].content).toBe("answer");
    expect(harness.addConversation.mock.calls[1][0].session_id)
      .toBe(harness.addConversation.mock.calls[0][0].session_id);
  });

  it("fails closed if old session scope is unknown", async () => {
    harness.stored.get("s1").session.workingDirectory = "";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await syncAllHistoryToRMemory();
    } finally {
      warn.mockRestore();
    }
    expect(harness.addConversation).not.toHaveBeenCalled();
  });

  it("does not race with a live backfill owner", async () => {
    const root = path.join(harness.rootDir, "rmemory");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "history-sync.lock"), JSON.stringify({ pid: process.pid }));
    await syncAllHistoryToRMemory();
    expect(harness.addConversation).not.toHaveBeenCalled();
  });
});
