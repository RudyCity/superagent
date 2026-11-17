import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getActiveSessionTaskPath, parseChecklistTasks, readChecklistTasks } from "../src/core/taskChecklist.js";

describe("task checklist helpers", () => {
  it("does not fall back to workspace task.md when there is no active session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-clone-tasks-"));
    try {
      const oldProjectTaskPath = path.join(dir, "task.md");
      await fs.writeFile(oldProjectTaskPath, "- [x] Historical cloned project task\n");
      expect(getActiveSessionTaskPath(null)).toBeNull();
      expect(getActiveSessionTaskPath(undefined)).toBeNull();
      expect(getActiveSessionTaskPath({ getTaskFilePath: () => "" })).toBeNull();
      expect(getActiveSessionTaskPath({ getTaskFilePath: () => { throw new Error("no session"); } })).toBeNull();

      const sessionPath = path.join(dir, "new-session_task.md");
      expect(getActiveSessionTaskPath({ getTaskFilePath: () => sessionPath })).toBe(sessionPath);
      expect((await readChecklistTasks(sessionPath)).tasks).toEqual([]);
      expect((await readChecklistTasks(oldProjectTaskPath)).tasks).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses checked, active, and pending task lines", () => {
    const tasks = parseChecklistTasks([
      "- [ ] Pending task",
      "- [/] Active task",
      "- [x] Done task",
      "- `[X]` Done backtick task",
      "plain text",
    ].join("\n"));

    expect(tasks).toEqual([
      { status: " ", text: "Pending task" },
      { status: "/", text: "Active task" },
      { status: "x", text: "Done task" },
      { status: "x", text: "Done backtick task" },
    ]);
  });

  it("returns missing=true instead of throwing for absent task files", async () => {
    const result = await readChecklistTasks(path.join(os.tmpdir(), "missing-superagent-task.md"));

    expect(result).toEqual({ tasks: [], missing: true });
  });

  it("reads tasks from an existing task file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-task-"));
    const file = path.join(dir, "task.md");
    await fs.writeFile(file, "- [ ] First\n- [x] Second\n", "utf-8");

    const result = await readChecklistTasks(file);

    expect(result).toEqual({
      tasks: [
        { status: " ", text: "First" },
        { status: "x", text: "Second" },
      ],
      missing: false,
    });

    await fs.rm(dir, { recursive: true, force: true });
  });
});
