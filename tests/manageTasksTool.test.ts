import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { manageTasksTool } from "../src/core/tools/otherTools.js";
import { agentLocalStorage } from "../src/core/agent.js";

describe("manageTasksTool", () => {
  const tempDir = path.resolve(process.cwd(), "tests/temp-task-test");
  const fallbackTaskPath = path.join(tempDir, "task.md");
  const customTaskPath = path.join(tempDir, "custom_task.md");

  beforeEach(async () => {
    // Ensure the temp directory exists
    await fs.mkdir(tempDir, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    // Cleanup the temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("without agent context (fallback to task.md)", () => {
    it("should return a notice if task list does not exist for action 'list'", async () => {
      const result = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(result).toContain("No active task list found at");
    });

    it("should add a task to a new file and list it", async () => {
      const addResult = await manageTasksTool.execute(
        { action: "add", text: "Task number one" },
        tempDir
      );
      expect(addResult).toBe('Successfully added task: "Task number one"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task number one");
    });

    it("should append a new task to an existing file", async () => {
      await manageTasksTool.execute({ action: "add", text: "Task 1" }, tempDir);
      await manageTasksTool.execute({ action: "add", text: "Task 2" }, tempDir);

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task 1\n2. [ ] Task 2");
    });

    it("should update a task's status", async () => {
      await manageTasksTool.execute({ action: "add", text: "First Task" }, tempDir);
      await manageTasksTool.execute({ action: "add", text: "Second Task" }, tempDir);

      // Update task 1 to in-progress
      const update1 = await manageTasksTool.execute(
        { action: "update", index: 1, status: "/" },
        tempDir
      );
      expect(update1).toContain('Successfully updated task 1 to [/]: "First Task"');

      // Update task 2 to completed
      const update2 = await manageTasksTool.execute(
        { action: "update", index: 2, status: "x" },
        tempDir
      );
      expect(update2).toContain('Successfully updated task 2 to [x]: "Second Task"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [/] First Task\n2. [x] Second Task");
    });

    it("should remove a task by index", async () => {
      await manageTasksTool.execute({ action: "add", text: "Task A" }, tempDir);
      await manageTasksTool.execute({ action: "add", text: "Task B" }, tempDir);
      await manageTasksTool.execute({ action: "add", text: "Task C" }, tempDir);

      // Remove task 2 (Task B)
      const removeResult = await manageTasksTool.execute(
        { action: "remove", index: 2 },
        tempDir
      );
      expect(removeResult).toContain('Successfully removed task 2: "Task B"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task A\n2. [ ] Task C");
    });

    it("should validate out of bounds index and missing parameters", async () => {
      // Missing text on add
      const addError = await manageTasksTool.execute({ action: "add" }, tempDir);
      expect(addError).toContain("Error: The 'text' parameter is required");

      // File not found on update
      const updateErrNoFile = await manageTasksTool.execute(
        { action: "update", index: 1, status: "x" },
        tempDir
      );
      expect(updateErrNoFile).toContain("Error: Task list file does not exist");

      // Setup file
      await manageTasksTool.execute({ action: "add", text: "Single Task" }, tempDir);

      // Out of bounds update
      const updateErrOob = await manageTasksTool.execute(
        { action: "update", index: 5, status: "x" },
        tempDir
      );
      expect(updateErrOob).toContain("Error: Task index 5 is out of bounds");

      // Invalid status
      const updateErrStatus = await manageTasksTool.execute(
        { action: "update", index: 1, status: "invalid" },
        tempDir
      );
      expect(updateErrStatus).toContain("Error: Invalid status");

      // Out of bounds remove
      const removeErrOob = await manageTasksTool.execute(
        { action: "remove", index: 3 },
        tempDir
      );
      expect(removeErrOob).toContain("Error: Task index 3 is out of bounds");
    });
  });

  describe("with agent context", () => {
    it("should resolve and manage tasks at path returned by getTaskFilePath()", async () => {
      const mockAgent = {
        getTaskFilePath: () => customTaskPath,
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        // Add task
        const addResult = await manageTasksTool.execute(
          { action: "add", text: "Agent Task" },
          tempDir
        );
        expect(addResult).toBe('Successfully added task: "Agent Task"');

        // Check that the file was created at customTaskPath instead of fallback path
        const customExists = await fs.access(customTaskPath).then(() => true).catch(() => false);
        const fallbackExists = await fs.access(fallbackTaskPath).then(() => true).catch(() => false);
        
        expect(customExists).toBe(true);
        expect(fallbackExists).toBe(false);

        // List task
        const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
        expect(listResult).toBe("1. [ ] Agent Task");
      });
    });
  });
});
