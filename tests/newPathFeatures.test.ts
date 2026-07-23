import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";

// Import config and checkpoints functions
import {
  getRootConfigDir,
  getGlobalConfigDir,
  ensureGlobalConfigDir,
} from "../src/core/config/paths.js";
import {
  listHistorySessions,
  getWorkspaceTasksLogDir,
  closeHistoryDb,
  clearHistoryCache,
} from "../src/core/config.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
  restoreCheckpoint,
  deleteCheckpointsForSession,
} from "../src/core/checkpoints.js";
import { runBackgroundProcessTool } from "../src/core/tools/shellTools.js";
import { backgroundTasks } from "../src/core/tools/state.js";

// Mock child_process and execa
vi.mock("child_process", () => ({
  execSync: vi.fn().mockReturnValue("mockSha12"),
}));

vi.mock("execa", () => {
  const mockPromise: any = Promise.resolve({
    stdout: "mocked process stdout",
    exitCode: 0,
    all: "mocked process stdout and stderr",
  });
  mockPromise.on = vi.fn().mockImplementation((event, callback) => {
    if (event === "close") {
      setTimeout(() => callback(0), 10);
    }
    return mockPromise;
  });
  mockPromise.all = {
    on: vi.fn().mockImplementation((event, callback) => {
      if (event === "data") {
        setTimeout(() => callback(Buffer.from("mock task output")), 10);
      }
      return mockPromise.all;
    }),
  };
  mockPromise.kill = vi.fn();
  return {
    execa: vi.fn().mockReturnValue(mockPromise),
  };
});

describe("New Path Features (Checkpoint, Resume History, and Background Tasks)", () => {
  const tempHomeDir = path.join(process.cwd(), "tests", "tmp_new_path_test");
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    closeHistoryDb();
    clearHistoryCache();
    originalEnv = { ...process.env };
    delete process.env.SUPERAGENT_HOME;
    delete process.env.SUPERAGENT_SESSION_ID;
    delete process.env.SUPERAGENT_CONFIG_DIR;
    vi.restoreAllMocks();

    // Mock os.homedir to use our temp directory inside the workspace
    vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);

    // Clean up temp dir if exists, then recreate
    if (fs.existsSync(tempHomeDir)) {
      try {
        fs.rmSync(tempHomeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
    fs.mkdirSync(tempHomeDir, { recursive: true });

    // Initialize global config directory structure
    ensureGlobalConfigDir();

    try {
      const { getHistoryDb } = await import("../src/core/storage/historyDb.js");
      const db = getHistoryDb();
      db.exec("DELETE FROM sessions; DELETE FROM messages; DELETE FROM checkpoints;");
    } catch {}
  });

  afterEach(() => {
    closeHistoryDb();
    clearHistoryCache();
    // Restore environment variables
    process.env = originalEnv;

    // Clean up temp dir
    if (fs.existsSync(tempHomeDir)) {
      try {
        fs.rmSync(tempHomeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
    
    // Clear background tasks map
    backgroundTasks.clear();
  });

  describe("Checkpoint Path", () => {
    it("should save checkpoint files under SQLite database and list/delete them", async () => {
      // 1. Setup session file path
      const mode = "single";
      const sessionId = "session_test_checkpoint";
      const sessionDir = path.join(getGlobalConfigDir(), "history", mode, sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFilePath = path.join(sessionDir, `${sessionId}.json`);

      // 2. Create checkpoint
      const checkpoint = await createCheckpoint(
        sessionFilePath,
        "Checkpoint 1",
        [{ role: "user", content: "test content", timestamp: Date.now() }],
        "IDLE"
      );

      // 3. List checkpoints
      const checkpoints = await listCheckpointsForSession(sessionFilePath);
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0].name).toBe("Checkpoint 1");
      expect(checkpoints[0].gitSha).toBe("mocked process stdout");

      // 4. Delete checkpoints
      await deleteCheckpointsForSession(sessionFilePath);
      const remainingCheckpoints = await listCheckpointsForSession(sessionFilePath);
      expect(remainingCheckpoints.length).toBe(0);
    });

    it("should restore plan/task/walkthrough files relative to the session parent directory", async () => {
      const mode = "single";
      const sessionId = "session_test_restore";
      const sessionDir = path.join(getGlobalConfigDir(), "history", mode, sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFilePath = path.join(sessionDir, `${sessionId}.json`);

      // Write mock implementation plan, task and walkthrough
      const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
      const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
      const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");

      await fsPromises.writeFile(planPath, "# Initial Plan", "utf-8");
      await fsPromises.writeFile(taskPath, "- [ ] Initial Task", "utf-8");
      await fsPromises.writeFile(walkthroughPath, "# Initial Walkthrough", "utf-8");

      // Create checkpoint
      const checkpoint = await createCheckpoint(
        sessionFilePath,
        "Checkpoint Restore Test",
        [],
        "APPROVED"
      );

      // Modify the plan and task files on disk
      await fsPromises.writeFile(planPath, "# Modified Plan", "utf-8");
      await fsPromises.writeFile(taskPath, "- [x] Modified Task", "utf-8");
      await fsPromises.writeFile(walkthroughPath, "# Modified Walkthrough", "utf-8");

      // Restore the checkpoint
      await restoreCheckpoint(checkpoint.id, sessionFilePath);

      // Verify they are rolled back to checkpoint content
      expect(await fsPromises.readFile(planPath, "utf-8")).toBe("# Initial Plan");
      expect(await fsPromises.readFile(taskPath, "utf-8")).toBe("- [ ] Initial Task");
      expect(await fsPromises.readFile(walkthroughPath, "utf-8")).toBe("# Initial Walkthrough");
    });
  });

  describe("Resume History Path", () => {
    it("should separate single and multi agent histories in their respective directory paths", async () => {
      const { saveSessionToDb } = await import("../src/core/storage/historyDb.js");
      const mockCwd = path.join(tempHomeDir, "my-project");
      fs.mkdirSync(mockCwd, { recursive: true });
      const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      const sanitizedCwd = mockCwd.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

      const singleSessionId = `${sanitizedCwd}_12345`;
      const singleSessionDir = path.join(getGlobalConfigDir(), "history", "single", singleSessionId);
      fs.mkdirSync(singleSessionDir, { recursive: true });
      const singleSessionFilePath = path.join(singleSessionDir, `${singleSessionId}.json`);

      saveSessionToDb(
        {
          id: singleSessionId,
          filePath: singleSessionFilePath,
          displayName: "hello single",
          messageCount: 1,
          lastModified: Date.now(),
          preview: "hello single",
          workingDirectory: mockCwd,
        },
        [{ sessionId: singleSessionId, role: "user", content: "hello single", timestamp: Date.now(), sequenceOrder: 0 }]
      );

      const multiSessionId = `${sanitizedCwd}_67890`;
      const multiSessionDir = path.join(getGlobalConfigDir(), "history", "multi", multiSessionId);
      fs.mkdirSync(multiSessionDir, { recursive: true });
      const multiSessionFilePath = path.join(multiSessionDir, `${multiSessionId}.json`);

      saveSessionToDb(
        {
          id: multiSessionId,
          filePath: multiSessionFilePath,
          displayName: "hello multi",
          messageCount: 1,
          lastModified: Date.now() + 100,
          preview: "hello multi",
          workingDirectory: mockCwd,
        },
        [{ sessionId: multiSessionId, role: "user", content: "hello multi", timestamp: Date.now(), sequenceOrder: 0 }]
      );

      // Check listing for single agent
      const singleSessions = listHistorySessions(false, false, mockCwd);
      expect(singleSessions.length).toBe(1);
      expect(singleSessions[0].filePath).toBe(singleSessionFilePath);
      expect(singleSessions[0].displayName).toBe("hello single");

      // Check listing for multi agent
      const multiSessions = listHistorySessions(true, false, mockCwd);
      expect(multiSessions.length).toBe(1);
      expect(multiSessions[0].filePath).toBe(multiSessionFilePath);
      expect(multiSessions[0].displayName).toBe("hello multi");
    });

    it("should namespace getGlobalConfigDir if SUPERAGENT_SESSION_ID is provided", () => {
      delete process.env.SUPERAGENT_CONFIG_DIR;
      delete process.env.SUPERAGENT_HOME;
      process.env.SUPERAGENT_SESSION_ID = "custom-session-uuid-999";
      const root = getRootConfigDir();
      const dir = getGlobalConfigDir();
      expect(dir).toBe(path.join(root, "sessions", "custom-session-uuid-999"));
    });


  });

  describe("Background Tasks Log Path", () => {
    it("should write logs inside the session directory's 'tasks' folder when SUPERAGENT_SESSION_PATH is set", async () => {
      const mode = "single";
      const sessionId = "session_test_tasks";
      const sessionDir = path.join(getGlobalConfigDir(), "history", mode, sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFilePath = path.join(sessionDir, `${sessionId}.json`);

      // Set environment variable
      process.env.SUPERAGENT_SESSION_PATH = sessionFilePath;

      // Run a background process
      const runBg = runBackgroundProcessTool;
      const result = await runBg.execute({ command: "node -e 'console.log(1)'" }, process.cwd());

      expect(result).toContain("Background process");
      const taskId = [...backgroundTasks.keys()].pop() || "";
      expect(taskId).toBeTruthy();

      // Log path should be under <sessionDir>/tasks/
      const expectedLogDir = path.join(sessionDir, "tasks");
      const expectedLogPath = path.join(expectedLogDir, `${taskId}.log`);

      expect(fs.existsSync(expectedLogPath)).toBe(true);
    });

    it("should fallback to workspace-scoped 'tasks' folder when SUPERAGENT_SESSION_PATH is not set", async () => {
      // Unset SUPERAGENT_SESSION_PATH
      delete process.env.SUPERAGENT_SESSION_PATH;

      // Run background process
      const runBg = runBackgroundProcessTool;
      const result = await runBg.execute({ command: "node -e 'console.log(2)'" }, process.cwd());

      expect(result).toContain("Background process");
      const taskId = [...backgroundTasks.keys()].pop() || "";
      expect(taskId).toBeTruthy();

      // Log path should now be under workspace-scoped tasks dir, not global
      const expectedLogDir = getWorkspaceTasksLogDir();
      const expectedLogPath = path.join(expectedLogDir, `${taskId}.log`);

      expect(fs.existsSync(expectedLogPath)).toBe(true);
    });
  });
});
