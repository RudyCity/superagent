import { describe, it, expect } from "vitest";
import { Agent } from "../src/core/agent.js";
import { HistoryManager } from "../src/core/agent/HistoryManager.js";
import { PathResolver } from "../src/core/agent/PathResolver.js";
import { generateSessionId, saveSessionToDb, deleteSessionFromDb } from "../src/core/config.js";
import path from "path";
import fs from "fs";
import os from "os";

describe("Session Synchronization and Display Invariants", () => {
  it("should update agent.sessionId and process.env.SUPERAGENT_SESSION_PATH on loadHistoryFromPath", async () => {
    const agent = new Agent(() => {});
    const initialSession = generateSessionId();
    agent.sessionId = initialSession;

    const targetSessionId = generateSessionId();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
    const targetFilePath = path.join(tempDir, `${targetSessionId}.json`);
    fs.writeFileSync(targetFilePath, JSON.stringify({ id: targetSessionId, messages: [] }));

    // Pre-save session to DB
    saveSessionToDb({
      id: targetSessionId,
      filePath: targetFilePath,
      displayName: "Target Session",
      messageCount: 5,
      lastModified: Date.now(),
      preview: "Target conversation",
      workingDirectory: process.cwd(),
    }, [
      { sessionId: targetSessionId, role: "user", content: "Hello", timestamp: Date.now(), sequenceOrder: 0 },
      { sessionId: targetSessionId, role: "assistant", content: "Hi there", timestamp: Date.now(), sequenceOrder: 1 },
    ]);

    await HistoryManager.loadHistoryFromPath(agent, targetFilePath);

    expect(agent.sessionId).toBe(targetSessionId);
    expect(agent.getSessionId()).toBe(targetSessionId);
    expect(process.env.SUPERAGENT_SESSION_PATH).toBe(targetFilePath);
    expect(PathResolver.getCurrentHistoryFilePath(agent)).toBe(targetFilePath);

    // Cleanup
    deleteSessionFromDb(targetSessionId);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("should sync agent.sessionId when getCurrentHistoryFilePath is called with a new history path", () => {
    const agent = new Agent(() => {});
    agent.sessionId = "sess_old_111111";

    const newPath = path.join(os.tmpdir(), "sess_new_222222.json");
    (agent as any).currentHistoryFilePath = newPath;

    const retrieved = PathResolver.getCurrentHistoryFilePath(agent);
    expect(retrieved).toBe(newPath);
    expect(agent.sessionId).toBe("sess_new_222222");
    expect(agent.getSessionId()).toBe("sess_new_222222");
  });

  it("should generate a fresh session ID and update agent.sessionId on clearHistory", async () => {
    const agent = new Agent(() => {});
    const oldSessionId = generateSessionId();
    agent.sessionId = oldSessionId;

    await HistoryManager.clearHistory(agent);

    expect(agent.sessionId).not.toBe(oldSessionId);
    expect(agent.sessionId).toMatch(/^sess_\d+_[a-z0-9]+$/);
    expect(process.env.SUPERAGENT_SESSION_PATH).toContain(agent.sessionId);
  });
});
