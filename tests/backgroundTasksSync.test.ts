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
  loadAndSyncPersistedTasks 
} from "../src/core/tools/state";
import { getRootConfigDir } from "../src/core/config/paths";

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
    } as any;

    backgroundTasks.set(taskId, dummyTask);
    savePersistedTasks();

    const rootDir = getRootConfigDir();
    const tasksFilePath = path.join(rootDir, "background-tasks.json");
    expect(fs.existsSync(tasksFilePath)).toBe(true);

    const content = fs.readFileSync(tasksFilePath, "utf-8");
    const list = JSON.parse(content);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(taskId);
    expect(list[0].command).toBe("sleep 100");
    expect(list[0].pid).toBe(99999);
    expect(list[0].hasExited).toBe(false);
  });

  it("should restore and sync tasks, marking dead processes as exited", () => {
    const rootDir = getRootConfigDir();
    fs.mkdirSync(rootDir, { recursive: true });
    const tasksFilePath = path.join(rootDir, "background-tasks.json");

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
});
