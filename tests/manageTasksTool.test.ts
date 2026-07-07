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

  describe("bulk operations", () => {
    beforeEach(async () => {
      // Add a few initial tasks
      await manageTasksTool.execute({ action: "add", text: "Task A" }, tempDir);
      await manageTasksTool.execute({ action: "add", text: "Task B" }, tempDir);
      await manageTasksTool.execute({ action: "add", text: "Task C" }, tempDir);
    });

    it("should update multiple tasks in bulk using update_bulk", async () => {
      const result = await manageTasksTool.execute(
        { action: "update_bulk", indices: [1, 3], status: "x" },
        tempDir
      );
      expect(result).toContain('Successfully updated tasks 1, 3 to [x]: "Task A", "Task C"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [x] Task A\n2. [ ] Task B\n3. [x] Task C");
    });

    it("should update multiple tasks using update with indices parameter", async () => {
      const result = await manageTasksTool.execute(
        { action: "update", indices: [2, 3], status: "/" },
        tempDir
      );
      expect(result).toContain('Successfully updated tasks 2, 3 to [/]: "Task B", "Task C"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task A\n2. [/] Task B\n3. [/] Task C");
    });

    it("should remove multiple tasks in bulk using remove_bulk", async () => {
      const result = await manageTasksTool.execute(
        { action: "remove_bulk", indices: [1, 3] },
        tempDir
      );
      expect(result).toContain('Successfully removed tasks 1, 3: "Task A", "Task C"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task B");
    });

    it("should remove multiple tasks using remove with indices parameter", async () => {
      const result = await manageTasksTool.execute(
        { action: "remove", indices: [1, 2] },
        tempDir
      );
      expect(result).toContain('Successfully removed tasks 1, 2: "Task A", "Task B"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task C");
    });

    it("should deduplicate indices when performing bulk update or remove", async () => {
      const updateResult = await manageTasksTool.execute(
        { action: "update_bulk", indices: [1, 1, 2], status: "x" },
        tempDir
      );
      expect(updateResult).toContain('Successfully updated tasks 1, 2 to [x]: "Task A", "Task B"');

      const removeResult = await manageTasksTool.execute(
        { action: "remove_bulk", indices: [1, 1, 2] },
        tempDir
      );
      expect(removeResult).toContain('Successfully removed tasks 1, 2: "Task A", "Task B"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task C");
    });

    it("should validate out of bounds indices in bulk operations", async () => {
      const updateErr = await manageTasksTool.execute(
        { action: "update_bulk", indices: [1, 5], status: "x" },
        tempDir
      );
      expect(updateErr).toContain("Error: Task index 5 is out of bounds");

      const removeErr = await manageTasksTool.execute(
        { action: "remove_bulk", indices: [1, 5] },
        tempDir
      );
      expect(removeErr).toContain("Error: Task index 5 is out of bounds");
    });

    it("should error if indices parameter is missing or empty for bulk operations", async () => {
      const updateErrEmpty = await manageTasksTool.execute(
        { action: "update_bulk", indices: [] as any, status: "x" },
        tempDir
      );
      expect(updateErrEmpty).toContain("Error: A non-empty 'indices' array parameter is required");

      const updateErrMissing = await manageTasksTool.execute(
        { action: "update_bulk", status: "x" },
        tempDir
      );
      expect(updateErrMissing).toContain("Error: A non-empty 'indices' array parameter is required");

      const removeErrEmpty = await manageTasksTool.execute(
        { action: "remove_bulk", indices: [] as any },
        tempDir
      );
      expect(removeErrEmpty).toContain("Error: A non-empty 'indices' array parameter is required");

      const removeErrMissing = await manageTasksTool.execute(
        { action: "remove_bulk" },
        tempDir
      );
      expect(removeErrMissing).toContain("Error: A non-empty 'indices' array parameter is required");
    });

    it("should add multiple tasks in bulk using add_bulk", async () => {
      const result = await manageTasksTool.execute(
        { action: "add_bulk", texts: ["Task D", "Task E"] },
        tempDir
      );
      expect(result).toContain('Successfully added tasks: "Task D", "Task E"');

      const listResult = await manageTasksTool.execute({ action: "list" }, tempDir);
      expect(listResult).toBe("1. [ ] Task A\n2. [ ] Task B\n3. [ ] Task C\n4. [ ] Task D\n5. [ ] Task E");
    });

    it("should validate missing or empty texts parameter in add_bulk", async () => {
      const errEmpty = await manageTasksTool.execute(
        { action: "add_bulk", texts: [] as any },
        tempDir
      );
      expect(errEmpty).toContain("Error: The 'texts' array parameter is required");

      const errMissing = await manageTasksTool.execute(
        { action: "add_bulk" },
        tempDir
      );
      expect(errMissing).toContain("Error: The 'texts' array parameter is required");

      const errOnlyWhitespace = await manageTasksTool.execute(
        { action: "add_bulk", texts: ["   ", ""] },
        tempDir
      );
      expect(errOnlyWhitespace).toContain("Error: The 'texts' parameter must contain at least one non-empty task description");
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
