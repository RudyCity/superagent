import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock homedir for full isolation
const tempHome = path.join(process.cwd(), "tests", "temp-home-background-sync");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { 
  backgroundTasks, 
  savePersistedTasks, 
  loadAndSyncPersistedTasks,
  isTaskInWorkspace
} from "../src/core/tools/state";
import { getRootConfigDir, getWorkspaceTasksFilePath } from "../src/core/config/paths";

describe("Background Tasks Persistence & Sync Tests", () => {
  beforeEach(() => {
    delete process.env.SUPERAGENT_CONFIG_DIR;
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    fs.mkdirSync(tempHome, { recursive: true });
    backgroundTasks.clear();
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {}
    }
    backgroundTasks.clear();
  });

  it("should persist background tasks to a JSON file", () => {
    const taskId = "test-task-123";
    const dummyTask = {
      id: taskId,
      command: "sleep 100",
      process: { pid: 99999 },
      output: ["Hello\n"],
      logPath: path.join(tempHome, "test.log"),
      hasExited: false,
      cwd: "/some/workspace/path",
    } as any;

    backgroundTasks.set(taskId, dummyTask);
    savePersistedTasks();

    const tasksFilePath = getWorkspaceTasksFilePath();
    expect(fs.existsSync(tasksFilePath)).toBe(true);

    const content = fs.readFileSync(tasksFilePath, "utf-8");
    const list = JSON.parse(content);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(taskId);
    expect(list[0].command).toBe("sleep 100");
    expect(list[0].pid).toBe(99999);
    expect(list[0].hasExited).toBe(false);
    expect(list[0].cwd).toBe("/some/workspace/path");
  });

  it("should restore and sync tasks, marking dead processes as exited", () => {
    const tasksFilePath = getWorkspaceTasksFilePath();
    // Ensure the workspace dir exists (getWorkspaceTasksFilePath creates it)
    fs.mkdirSync(path.dirname(tasksFilePath), { recursive: true });

    // Create a mock list with two processes: one active (this process PID) and one dead (pid 99999)
    const list = [
      {
        id: "active-task",
        command: "node active",
        pid: process.pid,
        hasExited: false,
      },
      {
        id: "dead-task",
        command: "node dead",
        pid: 99999,
        hasExited: false,
      }
    ];

    fs.writeFileSync(tasksFilePath, JSON.stringify(list, null, 2), "utf-8");

    // Load and sync
    loadAndSyncPersistedTasks();

    expect(backgroundTasks.has("active-task")).toBe(true);
    expect(backgroundTasks.has("dead-task")).toBe(true);

    const activeTask = backgroundTasks.get("active-task")!;
    const deadTask = backgroundTasks.get("dead-task")!;

    expect(activeTask.hasExited).toBe(false); // current process is alive
    expect(deadTask.hasExited).toBe(true); // pid 99999 is dead
  });

  describe("isTaskInWorkspace", () => {
    it("should return true when task cwd matches workspace path", () => {
      const workspacePath = path.resolve("/project/root");
      const taskCwd = path.resolve("/project/root");
      expect(isTaskInWorkspace(taskCwd, workspacePath)).toBe(true);
    });

    it("should return true when task cwd is a subfolder of workspace path", () => {
      const workspacePath = path.resolve("/project/root");
      const taskCwd = path.resolve("/project/root/subdir/sub");
      expect(isTaskInWorkspace(taskCwd, workspacePath)).toBe(true);
    });

    it("should return false when task cwd is outside workspace path", () => {
      const workspacePath = path.resolve("/project/root");
      const taskCwd = path.resolve("/other/project");
      expect(isTaskInWorkspace(taskCwd, workspacePath)).toBe(false);
    });

    it("should return false when task cwd is undefined", () => {
      const workspacePath = path.resolve("/project/root");
      expect(isTaskInWorkspace(undefined, workspacePath)).toBe(false);
    });

    it("should be case-insensitive on Windows", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      const workspacePath = "C:\\Project\\Root";
      const taskCwd = "c:\\project\\root\\subdir";
      expect(isTaskInWorkspace(taskCwd, workspacePath)).toBe(true);

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });
});
