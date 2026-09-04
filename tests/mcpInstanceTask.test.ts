import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getCurrentTaskFromChecklist,
  ChecklistTask,
} from "../src/core/taskChecklist.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

describe("Instance Current Task Tracking via MCP", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-instance-task-test-"));
    superagentInstances.clear();
    subagentInstances.clear();
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("getCurrentTaskFromChecklist", () => {
    it("returns in_progress task when [/] is present", () => {
      const tasks: ChecklistTask[] = [
        { status: "x", text: "Task 1: Setup project" },
        { status: "/", text: "Task 2: Implement core feature" },
        { status: " ", text: "Task 3: Write tests" },
      ];

      const info = getCurrentTaskFromChecklist(tasks);
      expect(info.status).toBe("in_progress");
      expect(info.task).toBe("Task 2: Implement core feature");
      expect(info.index).toBe(2);
      expect(info.total).toBe(3);
      expect(info.completed).toBe(1);
      expect(info.inProgress).toBe(1);
      expect(info.pending).toBe(1);
      expect(info.percentage).toBe(33);
    });

    it("returns first pending task when no [/] is present", () => {
      const tasks: ChecklistTask[] = [
        { status: "x", text: "Task 1: Initial schema" },
        { status: " ", text: "Task 2: Build API router" },
        { status: " ", text: "Task 3: Integration tests" },
      ];

      const info = getCurrentTaskFromChecklist(tasks);
      expect(info.status).toBe("pending");
      expect(info.task).toBe("Task 2: Build API router");
      expect(info.index).toBe(2);
      expect(info.completed).toBe(1);
      expect(info.percentage).toBe(33);
    });

    it("returns completed status when all tasks are done [x]", () => {
      const tasks: ChecklistTask[] = [
        { status: "x", text: "Task 1: Done" },
        { status: "x", text: "Task 2: Also done" },
      ];

      const info = getCurrentTaskFromChecklist(tasks);
      expect(info.status).toBe("completed");
      expect(info.task).toBe("All tasks completed");
      expect(info.completed).toBe(2);
      expect(info.percentage).toBe(100);
    });

    it("returns empty info for empty checklist", () => {
      const info = getCurrentTaskFromChecklist([]);
      expect(info.status).toBe("none");
      expect(info.task).toBe("");
      expect(info.total).toBe(0);
      expect(info.percentage).toBe(0);
    });
  });

  describe("MCP Tools: superagent_get_current_task", () => {
    it("is registered in ListToolsRequestSchema", async () => {
      const server = createSuperagentMcpServer();
      const listHandler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
      const res = await listHandler({ method: "tools/list", params: {} });
      const toolNames = res.tools.map((t: any) => t.name);

      expect(toolNames).toContain("superagent_get_current_task");
      expect(toolNames).toContain("superagent_get_plan_and_tasks");
    });

    it("retrieves current in-progress task for a Superagent instance", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_auth");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "task.md"),
        "- [x] Design DB schema\n- [/] Build OAuth handler\n- [ ] Write e2e tests\n"
      );

      superagentInstances.set("agent-auth-1", {
        id: "agent-auth-1",
        role: "backend-developer",
        branch: "feature-oauth",
        worktreePath: worktreeDir,
        status: "running",
        task: "Implement OAuth2 authentication",
        logs: [],
      } as any);

      // Call superagent_get_current_task
      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_current_task",
          arguments: { instanceId: "agent-auth-1" },
        },
      });

      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain("=== Current Instance Task [SUPERAGENT: agent-auth-1] ===");
      expect(text).toContain("Role: backend-developer");
      expect(text).toContain("Active Task: Build OAuth handler");
      expect(text).toContain("Task State: IN_PROGRESS");
      expect(text).toContain("Checklist Step: 2 of 3");
      expect(text).toContain("Progress: 1/3 (33%)");
    });

    it("supports currentOnly flag returning only the task string", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_ui");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "_task.md"),
        "- [x] Mock components\n- [/] Implement header and footer\n- [ ] Style buttons\n"
      );

      superagentInstances.set("agent-ui-1", {
        id: "agent-ui-1",
        role: "frontend-developer",
        branch: "feature-ui",
        worktreePath: worktreeDir,
        status: "running",
        task: "Create responsive header and footer",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_current_task",
          arguments: { instanceId: "agent-ui-1", currentOnly: true },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("Implement header and footer");
    });

    it("retrieves current atomic task for a Subagent instance", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      subagentInstances.set("sub-research-99", {
        id: "sub-research-99",
        typeName: "researcher",
        role: "Codebase Explorer",
        status: "running",
        prompt: "Investigate how tokens are tracked in ContextManager",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_current_task",
          arguments: { instanceId: "sub-research-99" },
        },
      });

      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain("=== Current Instance Task [SUBAGENT: sub-research-99] ===");
      expect(text).toContain("Role: Codebase Explorer");
      expect(text).toContain("Active Task: Investigate how tokens are tracked in ContextManager");
      expect(text).toContain("Task State: IN_PROGRESS");
    });

    it("returns clear error for non-existent instance ID", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_current_task",
          arguments: { instanceId: "ghost-instance-404" },
        },
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('No active Superagent, Subagent, or process found with ID "ghost-instance-404"');
    });

    it("works through alias superagent_get_instance_task", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      subagentInstances.set("sub-coder-1", {
        id: "sub-coder-1",
        typeName: "coder",
        role: "Bug Fixer",
        status: "running",
        prompt: "Fix race condition in background tasks",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_instance_task",
          arguments: { instanceId: "sub-coder-1", currentOnly: true },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("Fix race condition in background tasks");
    });
  });

  describe("MCP Tools: superagent_get_plan_and_tasks enhancements", () => {
    it("displays Current Active Task header in plan output", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_plan_test");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(path.join(worktreeDir, "plan.md"), "# Plan for Feature Z\nDetails here.");
      fs.writeFileSync(
        path.join(worktreeDir, "task.md"),
        "- [x] Step 1\n- [/] Step 2 in progress\n- [ ] Step 3 pending\n"
      );

      superagentInstances.set("agent-z", {
        id: "agent-z",
        role: "feature-dev",
        branch: "feat-z",
        worktreePath: worktreeDir,
        status: "running",
        task: "Build Feature Z",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_plan_and_tasks",
          arguments: { superagentId: "agent-z" },
        },
      });

      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain("=== Current Active Task ===");
      expect(text).toContain("Task: Step 2 in progress");
      expect(text).toContain("Status: [/] (In Progress)");
      expect(text).toContain("Progress: 1/3 (33%)");
      expect(text).toContain("=== Implementation Plan [Instance: agent-z] ===");
      expect(text).toContain("=== Task Checklist ===");
    });

    it("supports currentOnly: true in superagent_get_plan_and_tasks", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_current_only");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "task.md"),
        "- [/] Active task exclusively\n"
      );

      superagentInstances.set("agent-curr", {
        id: "agent-curr",
        role: "worker",
        branch: "feat-c",
        worktreePath: worktreeDir,
        status: "running",
        task: "Do work",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_plan_and_tasks",
          arguments: { superagentId: "agent-curr", currentOnly: true },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("Active task exclusively");
    });
  });

  describe("MCP Tools: superagent_get_status & superagent_update_tasks & superagent_manage", () => {
    it("superagent_get_status includes Goal, Current Task, and Progress", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_status_test");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "task.md"),
        "- [x] Init\n- [/] Implement core logic\n- [ ] Validate\n"
      );

      superagentInstances.set("agent-status-1", {
        id: "agent-status-1",
        role: "lead-coder",
        branch: "feat-status",
        worktreePath: worktreeDir,
        status: "running",
        task: "Implement core logic and validation",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_get_status",
          arguments: { superagentId: "agent-status-1" },
        },
      });

      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain("Status for SUPERAGENT [agent-status-1]:");
      expect(text).toContain("Role: lead-coder");
      expect(text).toContain("Objective: Implement core logic and validation");
      expect(text).toContain("Current Task: Implement core logic (IN_PROGRESS)");
      expect(text).toContain("Progress: 1/3 (33%)");
    });

    it("superagent_update_tasks supports action get_current_task", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_update_test");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "task.md"),
        "- [/] Current item in progress\n"
      );

      superagentInstances.set("agent-update-1", {
        id: "agent-update-1",
        role: "coder",
        branch: "feat-up",
        worktreePath: worktreeDir,
        status: "running",
        task: "Do updates",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_update_tasks",
          arguments: {
            superagentId: "agent-update-1",
            action: "get_current_task",
            currentOnly: true,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("Current item in progress");
    });

    it("superagent_manage supports action current_task", async () => {
      const server = createSuperagentMcpServer();
      const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      const worktreeDir = path.join(testDir, "worktree_manage_test");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "task.md"),
        "- [/] Managed task step\n"
      );

      superagentInstances.set("agent-manage-1", {
        id: "agent-manage-1",
        role: "architect",
        branch: "feat-m",
        worktreePath: worktreeDir,
        status: "running",
        task: "Architectural revamp",
        logs: [],
      } as any);

      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "superagent_manage",
          arguments: {
            action: "current_task",
            superagentIds: ["agent-manage-1"],
            currentOnly: true,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("Managed task step");
    });
  });
});
