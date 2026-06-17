import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { managePlanTool } from "../src/core/tools/otherTools.js";
import { agentLocalStorage } from "../src/core/agent.js";

describe("managePlanTool", () => {
  const tempDir = path.resolve(process.cwd(), "tests/temp-plan-test");
  const fallbackPlanPath = path.join(tempDir, "implementation_plan.md");
  const fallbackTaskPath = path.join(tempDir, "task.md");

  const customPlanPath = path.join(tempDir, "custom_plan.md");
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

  const validSuperagentPlan = `# Sample Goal

Some background information.

## Proposed Changes
We need to edit a file.
- [ ] Task 1: edit source code
- [ ] Task 2: run build

## Verification Plan
Verify the code builds correctly.

### Automated Tests
- Run npm test

### Manual Verification
- Test manually in browser
`;

  const validMasterPlan = `# Master Plan Goal

## Proposed Changes
We must spawn a Superagent.
- [ ] spawn superagent for feature development
- [ ] merge superagents when complete

## Verification Plan

### Automated Tests
- Run npm test

### Manual Verification
- Manual verification of merged changes
`;

  describe("validation", () => {
    it("should fail when planContent is missing for create action", async () => {
      const result = await managePlanTool.execute({ action: "create" }, tempDir);
      expect(result).toContain("Error: The 'planContent' parameter is required");
    });

    it("should fail when plan headers are missing", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        const invalidPlan = `# Title only`;
        const result = await managePlanTool.execute({ action: "create", planContent: invalidPlan }, tempDir);
        expect(result).toContain("Error: The implementation plan is invalid or lacks deep structure");
        expect(result).toContain("Proposed Changes section");
        expect(result).toContain("Verification Plan section");
      });
    });

    it("should auto-inject delegation context for master agent if plan has no superagent/worktree context", async () => {
      const mockAgent = {
        tier: "master",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        // Plan has valid sections but no superagent references
        const invalidMasterPlan = `# Goal Description

## Proposed Changes
- [ ] Direct file edit task

## Verification Plan
### Automated Tests
- npm test
### Manual Verification
- Manual verification
`;
        const result = await managePlanTool.execute({ action: "create", planContent: invalidMasterPlan }, tempDir);
        // Should succeed and auto-inject delegation context
        expect(result).toContain("Successfully");
      });
    });

    it("should auto-inject missing superagent tasks for master agent when task checklist has no superagent context", async () => {
      const mockAgent = {
        tier: "master",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        const planWithDirectTasksOnly = `# Goal Description

## Proposed Changes
We will delegate features to sub-worktrees.
- [ ] direct edit task
- [ ] run some command
- [ ] check results

## Verification Plan
### Automated Tests
- npm test
### Manual Verification
- Manual verification
`;
        const result = await managePlanTool.execute({ action: "create", planContent: planWithDirectTasksOnly }, tempDir);
        // Should succeed and auto-inject missing tasks instead of failing
        expect(result).toContain("Successfully");
        expect(result).toContain("Auto-injected");
      });
    });
  });

  describe("create action", () => {
    it("should write plan, sync tasks, and update planState", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        const result = await managePlanTool.execute(
          { action: "create", planContent: validSuperagentPlan },
          tempDir
        );

        expect(result).toContain("Successfully created implementation plan");
        expect(result).toContain("Successfully synchronized 2 tasks");
        expect(mockAgent.planState).toBe("PLANNING_PENDING");

        // Verify files were written
        const planExists = await fs.access(customPlanPath).then(() => true).catch(() => false);
        const taskExists = await fs.access(customTaskPath).then(() => true).catch(() => false);

        expect(planExists).toBe(true);
        expect(taskExists).toBe(true);

        const taskContent = await fs.readFile(customTaskPath, "utf-8");
        expect(taskContent).toBe("- [ ] Task 1: edit source code\n- [ ] Task 2: run build\n");
      });
    });

    it("should auto-approve in goal mode", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
        goalMode: "do something",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        await managePlanTool.execute(
          { action: "create", planContent: validSuperagentPlan },
          tempDir
        );
        expect(mockAgent.planState).toBe("APPROVED");
      });
    });

    it("should not reset planState from APPROVED to PLANNING_PENDING", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "APPROVED",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        const result = await managePlanTool.execute(
          { action: "create", planContent: validSuperagentPlan },
          tempDir
        );

        expect(result).toContain("Successfully created implementation plan");
        expect(mockAgent.planState).toBe("APPROVED");
      });
    });

    it("should merge with existing tasks and preserve status", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        // Pre-create task file with one task completed, one in-progress
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(
          customTaskPath,
          "- [x] Task 1: edit source code\n- [/] Task 2: run build\n",
          "utf-8"
        );

        const result = await managePlanTool.execute(
          { action: "create", planContent: validSuperagentPlan },
          tempDir
        );

        expect(result).toContain("Successfully synchronized 2 tasks");

        const taskContent = await fs.readFile(customTaskPath, "utf-8");
        expect(taskContent).toBe("- [x] Task 1: edit source code\n- [/] Task 2: run build\n");
      });
    });
  });

  describe("sync action", () => {
    it("should fail if plan does not exist", async () => {
      const result = await managePlanTool.execute({ action: "sync" }, tempDir);
      expect(result).toContain("Error: Implementation plan file does not exist");
    });

    it("should sync tasks from existing plan file", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "IDLE",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        // Pre-write plan
        await fs.writeFile(customPlanPath, validSuperagentPlan, "utf-8");

        const result = await managePlanTool.execute({ action: "sync" }, tempDir);
        expect(result).toContain("Successfully synchronized tasks from existing plan");

        const taskContent = await fs.readFile(customTaskPath, "utf-8");
        expect(taskContent).toBe("- [ ] Task 1: edit source code\n- [ ] Task 2: run build\n");
      });
    });
  });

  describe("get action", () => {
    it("should return correct status when files exist", async () => {
      const mockAgent = {
        tier: "superagent",
        getPlanFilePath: () => customPlanPath,
        getTaskFilePath: () => customTaskPath,
        planState: "PLANNING_PENDING",
      } as any;

      await agentLocalStorage.run(mockAgent, async () => {
        await fs.writeFile(customPlanPath, validSuperagentPlan, "utf-8");
        await fs.writeFile(customTaskPath, "- [ ] Task 1: edit source code\n", "utf-8");

        const result = await managePlanTool.execute({ action: "get" }, tempDir);
        expect(result).toContain("Implementation Plan Status");
        expect(result).toContain("Plan File**: " + customPlanPath + " (Exists)");
        expect(result).toContain("Task File**: " + customTaskPath + " (1 tasks)");
        expect(result).toContain("Current Agent Plan State**: PLANNING_PENDING");
        expect(result).toContain("Task 1: edit source code");
      });
    });
  });
});
