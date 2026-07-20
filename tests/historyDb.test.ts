import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("SQLite History Database (historyDb)", () => {
  let tempDir: string;
  let historyDbModule: typeof import("../src/core/storage/historyDb.js");

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-db-test-"));
    process.env.SUPERAGENT_CONFIG_DIR = tempDir;

    historyDbModule = await import("../src/core/storage/historyDb.js");
    historyDbModule.closeHistoryDb();
  });

  afterEach(() => {
    try {
      historyDbModule.closeHistoryDb();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should initialize SQLite database and save/load session", () => {
    const session = {
      id: "session-123",
      filePath: path.join(tempDir, "session-123.json"),
      displayName: "Test Session",
      messageCount: 2,
      lastModified: Date.now(),
      preview: "Hello, world!",
      workingDirectory: "/test/dir",
      planState: "IDLE",
    };

    const messages = [
      {
        sessionId: "session-123",
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
        sequenceOrder: 0,
      },
      {
        sessionId: "session-123",
        role: "assistant",
        content: "Hi there!",
        timestamp: Date.now() + 100,
        sequenceOrder: 1,
      },
    ];

    historyDbModule.saveSessionToDb(session, messages);

    const loaded = historyDbModule.loadSessionFromDb("session-123");
    expect(loaded.session).not.toBeNull();
    expect(loaded.session?.displayName).toBe("Test Session");
    expect(loaded.messages.length).toBe(2);
    expect(loaded.messages[0].content).toBe("Hello");
    expect(loaded.messages[1].content).toBe("Hi there!");
  });

  it("should list saved sessions ordered by last_modified", () => {
    const now = Date.now();
    historyDbModule.saveSessionToDb(
      {
        id: "session-a",
        filePath: "/path/a",
        displayName: "Session A",
        messageCount: 1,
        lastModified: now - 1000,
        preview: "A preview",
      },
      []
    );

    historyDbModule.saveSessionToDb(
      {
        id: "session-b",
        filePath: "/path/b",
        displayName: "Session B",
        messageCount: 1,
        lastModified: now,
        preview: "B preview",
      },
      []
    );

    const sessions = historyDbModule.listSessionsFromDb(10);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0].id).toBe("session-b");
    expect(sessions[1].id).toBe("session-a");
  });

  it("should record and retrieve compaction events", () => {
    const event = {
      id: "compact-1",
      timestamp: Date.now(),
      strategy: "summarization",
      messagesBefore: 50,
      messagesAfter: 10,
      tokensBefore: 4000,
      tokensAfter: 800,
      reason: "threshold" as const,
      summary: "Test summary",
    };

    historyDbModule.recordCompactionToDb(event);

    const history = historyDbModule.getCompactionHistoryFromDb(10);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].id).toBe("compact-1");
    expect(history[0].summary).toBe("Test summary");
  });

  it("should search messages in SQLite database", () => {
    historyDbModule.saveSessionToDb(
      {
        id: "session-search",
        filePath: "/path/search",
        displayName: "Search Session",
        messageCount: 1,
        lastModified: Date.now(),
        preview: "Search test",
      },
      [
        {
          sessionId: "session-search",
          role: "user",
          content: "Find the secret key in database",
          timestamp: Date.now(),
          sequenceOrder: 0,
        },
      ]
    );

    const results = historyDbModule.searchMessagesInDb("secret key");
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe("session-search");
    expect(results[0].content).toContain("secret key");
  });

  it("should delete session and cascade delete messages", () => {
    historyDbModule.saveSessionToDb(
      {
        id: "session-del",
        filePath: "/path/del",
        displayName: "Delete Session",
        messageCount: 1,
        lastModified: Date.now(),
        preview: "Delete test",
      },
      [
        {
          sessionId: "session-del",
          role: "user",
          content: "To be deleted",
          timestamp: Date.now(),
          sequenceOrder: 0,
        },
      ]
    );

    historyDbModule.deleteSessionFromDb("session-del");

    const loaded = historyDbModule.loadSessionFromDb("session-del");
    expect(loaded.session).toBeNull();
    expect(loaded.messages.length).toBe(0);
  });

  it("should export session to JSON and create database backup", () => {
    historyDbModule.saveSessionToDb(
      {
        id: "session-export",
        filePath: "/path/export",
        displayName: "Export Session",
        messageCount: 1,
        lastModified: Date.now(),
        preview: "Export test",
      },
      [
        {
          sessionId: "session-export",
          role: "user",
          content: "Message to export",
          timestamp: Date.now(),
          sequenceOrder: 0,
        },
      ]
    );

    const json = historyDbModule.exportSessionToJson("session-export");
    expect(json).not.toBeNull();
    expect(json).toContain("Message to export");

    const backupPath = historyDbModule.backupDatabase();
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it("should auto-migrate legacy JSON files into SQLite and clean them up", () => {
    const historySingleDir = path.join(tempDir, "history", "single", "legacy-sess");
    fs.mkdirSync(historySingleDir, { recursive: true });
    const legacyFile = path.join(historySingleDir, "legacy-sess.json");
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        messages: [{ role: "user", content: "Legacy JSON message" }],
        workingDirectory: "/legacy/dir",
      }),
      "utf-8"
    );

    const count = historyDbModule.migrateLegacyJsonToDb();
    expect(count).toBeGreaterThanOrEqual(1);

    const loaded = historyDbModule.loadSessionFromDb("legacy-sess");
    expect(loaded.session).not.toBeNull();
    expect(loaded.messages[0].content).toBe("Legacy JSON message");

    const cleanedCount = historyDbModule.cleanLegacyJsonFiles();
    expect(cleanedCount).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(legacyFile, "utf-8")).toBe("");
  });
});
