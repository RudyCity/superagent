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

  it("should save, list, and migrate checkpoints in SQLite database", () => {
    const cp = {
      id: "chk_100",
      name: "Checkpoint 100",
      sessionId: "session-chk",
      sessionFilePath: "/path/session-chk.json",
      timestamp: Date.now(),
      messagesJson: JSON.stringify([{ role: "user", content: "Checkpoint test" }]),
      planState: "IDLE",
    };

    historyDbModule.saveCheckpointToDb(cp);

    const loadedCp = historyDbModule.loadCheckpointFromDb("chk_100");
    expect(loadedCp).not.toBeNull();
    expect(loadedCp?.name).toBe("Checkpoint 100");

    const list = historyDbModule.listCheckpointsFromDb("session-chk");
    expect(list.length).toBe(1);

    // Test legacy checkpoint migration and cleanup
    const checkpointsDir = path.join(tempDir, "history", "single", "legacy-chk-sess", "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const legacyChkFile = path.join(checkpointsDir, "checkpoint_1001.json");
    fs.writeFileSync(
      legacyChkFile,
      JSON.stringify({
        id: "chk_1001",
        name: "Legacy Checkpoint",
        sessionFilePath: "/path/legacy.json",
        timestamp: Date.now(),
        messages: [{ role: "user", content: "Legacy checkpoint message" }],
        planState: "IDLE",
      }),
      "utf-8"
    );

    const migratedCpCount = historyDbModule.migrateLegacyCheckpointsToDb();
    expect(migratedCpCount).toBeGreaterThanOrEqual(1);

    const loadedMigrated = historyDbModule.loadCheckpointFromDb("chk_1001");
    expect(loadedMigrated).not.toBeNull();
    expect(loadedMigrated?.name).toBe("Legacy Checkpoint");

    const cleanedCpCount = historyDbModule.cleanLegacyCheckpointsFiles();
    expect(cleanedCpCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(legacyChkFile)).toBe(false);
  });

  it("should calculate database stats, perform rolling backups, and tag sessions", () => {
    historyDbModule.saveSessionToDb(
      {
        id: "session-tag-test",
        filePath: "/path/tag-test",
        displayName: "Tag Test",
        messageCount: 1,
        lastModified: Date.now(),
        preview: "Tag preview",
      },
      []
    );

    const tagged = historyDbModule.tagSessionInDb("session-tag-test", "bug-fix");
    expect(tagged).toBe(true);

    const taggedList = historyDbModule.getSessionsByTagFromDb("bug-fix");
    expect(taggedList.length).toBe(1);
    expect(taggedList[0].id).toBe("session-tag-test");

    const backupPath = historyDbModule.performRollingBackup(3);
    expect(backupPath).not.toBeNull();
    expect(fs.existsSync(backupPath!)).toBe(true);

    const stats = historyDbModule.getDatabaseStats();
    expect(stats.sessionCount).toBeGreaterThanOrEqual(1);
    expect(stats.journalMode.toLowerCase()).toBe("wal");
    expect(stats.backupCount).toBeGreaterThanOrEqual(1);
  });

  it("should save, retrieve, migrate, and clean CLI prompt input history in SQLite", () => {
    const wsId = "ws-test-123";
    // Seed workspaces to satisfy foreign key constraints
    historyDbModule.saveWorkspaceToDb({
      id: wsId,
      path: "/workspace/ws-test-123",
      isTrusted: true
    });
    historyDbModule.saveWorkspaceToDb({
      id: "ws-legacy-456",
      path: "/workspace/ws-legacy-456",
      isTrusted: true
    });

    historyDbModule.saveInputHistoryToDb(wsId, "npm run dev");
    historyDbModule.saveInputHistoryToDb(wsId, "git status");

    const history = historyDbModule.getInputHistoryFromDb(wsId);
    expect(history.length).toBe(2);
    expect(history[0]).toBe("npm run dev");
    expect(history[1]).toBe("git status");

    // Test legacy input history migration and cleanup
    const wsDir = path.join(tempDir, "workspaces", "ws-legacy-456");
    fs.mkdirSync(wsDir, { recursive: true });
    const legacyInputFile = path.join(wsDir, "input-history.json");
    fs.writeFileSync(legacyInputFile, JSON.stringify(["/help", "bun test"]), "utf-8");

    const migratedCount = historyDbModule.migrateLegacyInputHistoryToDb();
    expect(migratedCount).toBeGreaterThanOrEqual(2);

    const migratedHistory = historyDbModule.getInputHistoryFromDb("ws-legacy-456");
    expect(migratedHistory).toContain("/help");

    const cleanedCount = historyDbModule.cleanLegacyInputHistoryFiles();
    expect(cleanedCount).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(legacyInputFile, "utf-8")).toBe("[]");
  });

  it("should save and load model caches in SQLite", () => {
    const models = {
      "test-model-1": 100000,
      "test-model-2": 200000
    };
    historyDbModule.saveModelCachesToDb(models);

    const loaded = historyDbModule.getModelCachesFromDb();
    expect(loaded["test-model-1"]).toBe(100000);
    expect(loaded["test-model-2"]).toBe(200000);

    // Verify updates (conflict resolution)
    historyDbModule.saveModelCachesToDb({ "test-model-1": 120000 });
    const updated = historyDbModule.getModelCachesFromDb();
    expect(updated["test-model-1"]).toBe(120000);
  });

  it("should save, retrieve, and bulk-load tool support cache in SQLite with TTL", async () => {
    historyDbModule.saveToolSupportCacheToDb("model-a", true);
    historyDbModule.saveToolSupportCacheToDb("model-b", false);

    // Retrieve active cache entry within TTL
    const supportA = historyDbModule.getToolSupportCacheFromDb("model-a", 60000);
    expect(supportA).toBe(true);

    const supportB = historyDbModule.getToolSupportCacheFromDb("model-b", 60000);
    expect(supportB).toBe(false);

    // Retrieve expired cache entry
    const expired = historyDbModule.getToolSupportCacheFromDb("model-a", -100);
    expect(expired).toBeNull();

    // Bulk loading
    const all = historyDbModule.loadAllToolSupportCacheFromDb(60000);
    expect(all["model-a"]).toBe(true);
    expect(all["model-b"]).toBe(false);

    const allExpired = historyDbModule.loadAllToolSupportCacheFromDb(-100);
    expect(allExpired["model-a"]).toBeUndefined();
  });

  it("should save and retrieve rate limit state in SQLite", () => {
    historyDbModule.saveRateLimitStateToDb("test-key", 45, 12345678);

    const state = historyDbModule.getRateLimitStateFromDb("test-key");
    expect(state).not.toBeNull();
    expect(state?.tokensRemaining).toBe(45);
    expect(state?.lastUpdated).toBe(12345678);

    // Conflict update
    historyDbModule.saveRateLimitStateToDb("test-key", 10, 87654321);
    const updated = historyDbModule.getRateLimitStateFromDb("test-key");
    expect(updated?.tokensRemaining).toBe(10);
    expect(updated?.lastUpdated).toBe(87654321);

    // Non-existent key
    const nonExistent = historyDbModule.getRateLimitStateFromDb("unknown-key");
    expect(nonExistent).toBeNull();
  });

  it("should perform CRUD on pinned knowledge in SQLite", () => {
    const entry = {
      id: "pk-1",
      content: "pinned content",
      role: "user",
      agentTag: { tier: "master" },
      tag: "test-tag",
      sourceSessionPath: "/session/path.json",
      workingDirectory: "/workspace/dir",
      pinnedAt: 1000,
      timestamp: 2000,
      preview: "pinned",
      toolCalls: [{ id: "c1", name: "t1", args: {} }],
      toolResults: [{ toolCallId: "c1", name: "t1", result: "r1" }],
    };

    historyDbModule.savePinnedKnowledgeToDb(entry);

    const all = historyDbModule.getAllPinnedKnowledgeFromDb();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("pk-1");
    expect(all[0].content).toBe("pinned content");
    expect(all[0].agentTag).toEqual({ tier: "master" });
    expect(all[0].tag).toBe("test-tag");

    // update tag
    historyDbModule.updatePinnedKnowledgeTagInDb("/session/path.json", "pinned", "new-tag");
    const all2 = historyDbModule.getAllPinnedKnowledgeFromDb();
    expect(all2[0].tag).toBe("new-tag");

    // delete by pin
    historyDbModule.deletePinnedKnowledgeByPinFromDb("/session/path.json", "pinned");
    expect(historyDbModule.getAllPinnedKnowledgeFromDb()).toHaveLength(0);

    // save again and delete by ID
    historyDbModule.savePinnedKnowledgeToDb(entry);
    historyDbModule.deletePinnedKnowledgeFromDb("pk-1");
    expect(historyDbModule.getAllPinnedKnowledgeFromDb()).toHaveLength(0);

    // save again and delete by session
    historyDbModule.savePinnedKnowledgeToDb(entry);
    const removedCount = historyDbModule.deleteSessionFromPinnedKnowledgeDb("/session/path.json");
    expect(removedCount).toBe(1);
    expect(historyDbModule.getAllPinnedKnowledgeFromDb()).toHaveLength(0);
  });

  it("should perform CRUD on workspace tasks in SQLite", () => {
    // Seed workspace to satisfy foreign key constraints
    historyDbModule.saveWorkspaceToDb({
      id: "ws-1",
      path: "/workspace/ws-1",
      isTrusted: true
    });
    const task = {
      id: "task-1",
      command: "sleep 1",
      pid: 12345,
      logPath: "/log/path",
      isDetachedWindow: true,
      windowLabel: "label",
      autoRetry: false,
      onExit: "on-exit-cmd",
      hasExited: true,
      exitCode: 0,
      completedAt: 5000,
      isHidden: false,
      cwd: "/workspace/cwd",
    };

    historyDbModule.saveWorkspaceTaskToDb("ws-1", task);

    const list = historyDbModule.getWorkspaceTasksFromDb("ws-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("task-1");
    expect(list[0].command).toBe("sleep 1");
    expect(list[0].isDetachedWindow).toBe(true);
    expect(list[0].hasExited).toBe(true);
    expect(list[0].exitCode).toBe(0);

    // delete
    historyDbModule.deleteWorkspaceTaskFromDb("ws-1", "task-1");
    expect(historyDbModule.getWorkspaceTasksFromDb("ws-1")).toHaveLength(0);
  });
});
