import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { manageTasksTool } from "../src/core/tools/otherTools.js";
import { registerMasterAgent } from "../src/core/tools/state.js";
import { agentLocalStorage } from "../src/core/agent.js";

describe("Task Synchronization", () => {
  const tempDir = path.resolve(process.cwd(), "tests/temp-sync-test");
  const masterTaskPath = path.join(tempDir, "master_task.md");
  const childTaskPath = path.join(tempDir, "child_task.md");

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    registerMasterAgent(null);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should synchronize task updates from child (Superagent) to master checklist", async () => {
    // 1. Setup Master's task file
    const masterInitial = [
      "# Plan Tasks",
      "- [ ] [agent: coder] Fix WebSocket InvalidStateError in frontend SuperAgentConsole.tsx",
      "- [ ] [agent: tester] Run build & tests to verify changes",
    ].join("\n");
    await fs.writeFile(masterTaskPath, masterInitial, "utf-8");

    // 2. Setup Child's task file
    const childInitial = [
      "# Coder Tasks",
      "- [ ] Fix WebSocket InvalidStateError in frontend SuperAgentConsole.tsx",
    ].join("\n");
    await fs.writeFile(childTaskPath, childInitial, "utf-8");

    // 3. Register dummy master agent
    const dummyMaster = {
      getTaskFilePath: () => masterTaskPath,
    };
    registerMasterAgent(dummyMaster);

    // 4. Create dummy child agent and set as current context
    const dummyChild = {
      role: "coder",
      getTaskFilePath: () => childTaskPath,
    };

    // Run the tool in the context of the child agent
    await agentLocalStorage.run(dummyChild as any, async () => {
      // Update task 1 in child task list to in-progress
      const updateResult = await manageTasksTool.execute(
        { action: "update", index: 1, status: "/" },
        tempDir
      );
      expect(updateResult).toContain("Successfully updated task 1 to [/]");
    });

    // 5. Verify child task file was updated
    const childContent = await fs.readFile(childTaskPath, "utf-8");
    expect(childContent).toContain("- [/] Fix WebSocket InvalidStateError");

    // 6. Verify master task file was synchronized!
    const masterContent = await fs.readFile(masterTaskPath, "utf-8");
    expect(masterContent).toContain("- [/] [agent: coder] Fix WebSocket InvalidStateError");
    expect(masterContent).toContain("- [ ] [agent: tester] Run build & tests");
  });

  it("should synchronize newly added child tasks to master checklist", async () => {
    // 1. Setup Master's task file
    const masterInitial = [
      "# Plan Tasks",
      "- [ ] [agent: coder] Existing task",
    ].join("\n");
    await fs.writeFile(masterTaskPath, masterInitial, "utf-8");

    // 2. Setup Child's task file
    const childInitial = [
      "# Coder Tasks",
      "- [ ] Existing task",
    ].join("\n");
    await fs.writeFile(childTaskPath, childInitial, "utf-8");

    // 3. Register dummy master agent
    const dummyMaster = {
      getTaskFilePath: () => masterTaskPath,
    };
    registerMasterAgent(dummyMaster);

    // 4. Create dummy child agent
    const dummyChild = {
      role: "coder",
      getTaskFilePath: () => childTaskPath,
    };

    // Run the tool in the context of the child agent
    await agentLocalStorage.run(dummyChild as any, async () => {
      // Add a new task in child checklist
      await manageTasksTool.execute(
        { action: "add", text: "New child task" },
        tempDir
      );
    });

    // 5. Verify child task file has the new task
    const childContent = await fs.readFile(childTaskPath, "utf-8");
    expect(childContent).toContain("- [ ] New child task");

    // 6. Verify master task file has the new task appended with agent prefix
    const masterContent = await fs.readFile(masterTaskPath, "utf-8");
    expect(masterContent).toContain("- [ ] [agent: coder] New child task");
  });

  it("should synchronize task removal from child to master checklist", async () => {
    // 1. Setup Master's task file
    const masterInitial = [
      "# Plan Tasks",
      "- [ ] [agent: coder] Task to remove",
      "- [ ] [agent: tester] Keep this task",
    ].join("\n");
    await fs.writeFile(masterTaskPath, masterInitial, "utf-8");

    // 2. Setup Child's task file
    const childInitial = [
      "# Coder Tasks",
      "- [ ] Task to remove",
    ].join("\n");
    await fs.writeFile(childTaskPath, childInitial, "utf-8");

    // 3. Register dummy master agent
    const dummyMaster = {
      getTaskFilePath: () => masterTaskPath,
    };
    registerMasterAgent(dummyMaster);

    // 4. Create dummy child agent
    const dummyChild = {
      role: "coder",
      getTaskFilePath: () => childTaskPath,
    };

    // Run the tool in the context of the child agent
    await agentLocalStorage.run(dummyChild as any, async () => {
      // Remove task 1 in child checklist
      await manageTasksTool.execute(
        { action: "remove", index: 1 },
        tempDir
      );
    });

    // 5. Verify child task file no longer has the task
    const childContent = await fs.readFile(childTaskPath, "utf-8");
    expect(childContent).not.toContain("Task to remove");

    // 6. Verify master task file no longer has the task, but keeps the tester task
    const masterContent = await fs.readFile(masterTaskPath, "utf-8");
    expect(masterContent).not.toContain("Task to remove");
    expect(masterContent).toContain("- [ ] [agent: tester] Keep this task");
  });
});
