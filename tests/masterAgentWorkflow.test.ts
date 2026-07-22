import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import { generateText, streamText } from "ai";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";
import * as configModule from "../src/core/config.js";
import * as aiModule from "ai";
import { closeHistoryDb } from "../src/core/storage/historyDb.js";

// Mock ai SDK synchronously
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  jsonSchema: (s: any) => s,
}));


// Mock execa to prevent executing real git commands (e.g. worktree creation)
vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

// Mock rmemoryUtil to isolate workflow tests from RMemory active state
vi.mock("../src/core/rmemoryUtil.js", () => ({
  getRMemoryClient: vi.fn(),
  getRMemorySessionKey: vi.fn().mockReturnValue("test-sess"),
  isRmemoryActive: vi.fn().mockResolvedValue(false),
}));

describe("Master Agent Workflow & Guardrails", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-master-workflow-${process.pid}`);

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Spy on config after restoreAllMocks
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
    } as any);
    // Re-mock ai fns after restoreAllMocks
    vi.spyOn(aiModule, "generateText" as any).mockImplementation(vi.fn());
    vi.spyOn(aiModule, "streamText" as any).mockImplementation(vi.fn());
    for (const inst of superagentInstances.values()) {
      if (inst.agent && typeof inst.agent.abort === "function") {
        inst.agent.abort();
      }
    }
    const start = Date.now();
    while (Array.from(superagentInstances.values()).some(inst => inst.agent?.isRunning) && Date.now() - start < 1000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    superagentInstances.clear();
    subagentInstances.clear();
    closeHistoryDb();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
    const originalWriteFile = fs.writeFileSync;
    const originalAppendFile = fs.appendFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((filePath, data, options) => {
      if (String(filePath).endsWith(".gitignore")) return;
      return originalWriteFile(filePath, data, options);
    });
    vi.spyOn(fs, "appendFileSync").mockImplementation((filePath, data, options) => {
      if (String(filePath).endsWith(".gitignore")) return;
      return originalAppendFile(filePath, data, options);
    });
  });

  afterEach(async () => {
    for (const inst of superagentInstances.values()) {
      if (inst.agent && typeof inst.agent.abort === "function") {
        inst.agent.abort();
      }
    }
    const start = Date.now();
    while (Array.from(superagentInstances.values()).some(inst => inst.agent?.isRunning) && Date.now() - start < 1000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    superagentInstances.clear();
    subagentInstances.clear();
    clearModelConfigCache();
    closeHistoryDb();
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
    process.env = originalEnv;
  });

  it("should block Master Agent from modifying source files, but allow planning files", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    let genCallCount = 0;
    let streamCallCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_src",
              toolName: "write_to_file",
              args: { filePath: "src/cli.tsx", content: "modified code" },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_src",
              toolName: "write_to_file",
              args: { filePath: "src/cli.tsx", content: "modified code" },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    // Call sendMessage which starts the loop
    await agent.sendMessage("write to src/cli.tsx");

    // The tool execution should return a blocked/error result and not modify the file
    const toolEndEvent = onEvent.mock.calls.find(call => call[0].type === "tool_end" && call[0].toolResult.name === "write_to_file");
    expect(toolEndEvent).toBeDefined();
    expect(toolEndEvent[0].toolResult.isError).toBe(true);
    expect(toolEndEvent[0].toolResult.result).toContain("Error: The Master Agent is restricted from directly modifying source code files");
  });

  it("should allow Master Agent to write to planning/walkthrough files", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    agent.getCurrentHistoryFilePath();
    const planPath = agent.getPlanFilePath();

    // Mock fs/promises methods to not write to disk during test
    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);

    const validPlanContent = `# My Plan\n## Proposed Changes\n- Invoke developer superagent\n## Verification Plan\n### Automated Tests\n- npm test\n### Manual Verification\n- verify dashboard UI`;

    let genCallCount = 0;
    let streamCallCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_plan",
              toolName: "write_to_file",
              args: { filePath: planPath, content: validPlanContent },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_plan",
              toolName: "write_to_file",
              args: { filePath: planPath, content: validPlanContent },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("write plan");

    const toolEndEvent = onEvent.mock.calls.find(call => call[0].type === "tool_end" && call[0].toolResult.name === "write_to_file");
    expect(toolEndEvent).toBeDefined();
    expect(toolEndEvent[0].toolResult.isError).toBeUndefined(); // should not be an error
  });

  it("should NOT block Master Agent from writing a shallow plan", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    agent.getCurrentHistoryFilePath();
    const planPath = agent.getPlanFilePath();

    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);

    const shallowPlanContent = "# Shallow Plan\n## Proposed Changes\n- Invoke developer";

    let genCallCount = 0;
    let streamCallCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_plan_shallow",
              toolName: "write_to_file",
              args: { filePath: planPath, content: shallowPlanContent },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_plan_shallow",
              toolName: "write_to_file",
              args: { filePath: planPath, content: shallowPlanContent },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("write shallow plan");

    const toolEndEvent = onEvent.mock.calls.find(call => call[0].type === "tool_end" && call[0].toolResult.name === "write_to_file");
    expect(toolEndEvent).toBeDefined();
    expect(toolEndEvent[0].toolResult.isError).toBeUndefined();
  });

  it("should auto-create task file and NOT block when task tracking file is missing", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";
    agent.getCurrentHistoryFilePath();

    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      return String(filePath).endsWith("_implementation_plan.md");
    });

    let genCallCount = 0;
    let streamCallCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_invoke",
              toolName: "invoke_superagent",
              args: {
                role: "developer",
                task: "Implement feature",
                branch: "feat/test",
              },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_invoke",
              toolName: "invoke_superagent",
              args: {
                role: "developer",
                task: "Implement feature",
                branch: "feat/test",
              },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("start superagent");

    const toolEndEvent = onEvent.mock.calls.find(
      call => call[0].type === "tool_end" && call[0].toolResult.name === "invoke_superagent"
    );
    expect(toolEndEvent).toBeDefined();
    // Missing _task.md should NOT block execution — it auto-creates the file
    // The error (if any) should NOT be about missing task tracking file
    if (toolEndEvent[0].toolResult.isError) {
      expect(toolEndEvent[0].toolResult.result).not.toContain("Task Tracking File is missing");
    }
  });

  it("should auto-inject delegation context when Master Agent writes a plan that lacks superagent/spawning references", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";
    agent.getCurrentHistoryFilePath();
    const planPath = agent.getPlanFilePath();

    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);

    const planWithoutSuperagent = `# My Plan\n## Proposed Changes\n- Modify local file directly\n## Verification Plan\n### Automated Tests\n- npm test\n### Manual Verification\n- test UI`;

    let genCallCount = 0;
    let streamCallCount = 0;
    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_plan_no_sa",
              toolName: "write_to_file",
              args: { filePath: planPath, content: planWithoutSuperagent },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_plan_no_sa",
              toolName: "write_to_file",
              args: { filePath: planPath, content: planWithoutSuperagent },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("write plan");

    console.log("DEBUG ONEVENT CALLS:", onEvent.mock.calls.map(c => JSON.stringify(c[0])));
    const toolEndEvent = onEvent.mock.calls.find(call => call[0].type === "tool_end" && call[0].toolResult.name === "write_to_file");
    expect(toolEndEvent).toBeDefined();
    // Should NOT be an error - delegation context is auto-injected now
    expect(toolEndEvent[0].toolResult.isError).not.toBe(true);
    // Verify the content was enhanced with delegation context
    expect(fsPromises.writeFile).toHaveBeenCalled();
    const writeFileCalls = vi.mocked(fsPromises.writeFile).mock.calls;
    const planFileCall = writeFileCalls.find(call => typeof call[1] === "string" && call[1].includes("# My Plan"));
    expect(planFileCall).toBeDefined();
    const writtenContent = planFileCall![1] as string;
    expect(writtenContent).toContain("Superagents");
    expect(writtenContent).toContain("worktrees");
  });

  it("should auto-inject missing superagent tasks when Master Agent writes a task list without superagent/spawning/merge references", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";
    agent.getCurrentHistoryFilePath();
    const taskPath = agent.getTaskFilePath();

    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);

    const taskWithoutSuperagent = `- [ ] Edit index.ts\n- [ ] Edit config.ts`;

    let genCallCount = 0;
    let streamCallCount = 0;
    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_task_no_sa",
              toolName: "write_to_file",
              args: { filePath: taskPath, content: taskWithoutSuperagent },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_task_no_sa",
              toolName: "write_to_file",
              args: { filePath: taskPath, content: taskWithoutSuperagent },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("write tasks");

    const toolEndEvent = onEvent.mock.calls.find(call => call[0].type === "tool_end" && call[0].toolResult.name === "write_to_file");
    expect(toolEndEvent).toBeDefined();
    // Should NOT be an error - tasks are auto-injected now
    expect(toolEndEvent[0].toolResult.isError).not.toBe(true);
    // Verify the content was modified with injected tasks (the tool should have succeeded)
    expect(fsPromises.writeFile).toHaveBeenCalled();
    // Find the call that writes the task file (contains the checklist items)
    const writeFileCalls = vi.mocked(fsPromises.writeFile).mock.calls;
    const taskFileCall = writeFileCalls.find(call => typeof call[1] === "string" && call[1].includes("[ ]"));
    expect(taskFileCall).toBeDefined();
    const writtenContent = taskFileCall![1] as string;
    expect(writtenContent).toContain("Spawn Superagents");
    expect(writtenContent).toContain("Monitor");
    expect(writtenContent).toContain("Merge");
  });

  it("should allow Master Agent to write a task list with superagent/spawning/merge references", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";
    agent.getCurrentHistoryFilePath();
    const taskPath = agent.getTaskFilePath();

    vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);

    const taskWithSuperagent = `- [ ] Spawn superagent coder\n- [ ] Merge completed branch`;

    let genCallCount = 0;
    let streamCallCount = 0;
    vi.mocked(generateText).mockImplementation(async () => {
      genCallCount++;
      if (genCallCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_task_sa",
              toolName: "write_to_file",
              args: { filePath: taskPath, content: taskWithSuperagent },
            },
          ],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        } as any;
      }
      return {
        text: "Done",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      } as any;
    });

    vi.mocked(streamText).mockImplementation(() => {
      streamCallCount++;
      const current = streamCallCount;
      return {
        fullStream: (async function* () {
          if (current === 1) {
            yield {
              type: "tool-call",
              toolCallId: "call_task_sa",
              toolName: "write_to_file",
              args: { filePath: taskPath, content: taskWithSuperagent },
            };
          } else {
            yield {
              type: "text-delta",
              textDelta: "Done",
            };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("write tasks with superagent");

    const toolEndEvent = onEvent.mock.calls.find(call => call[0].type === "tool_end" && call[0].toolResult.name === "write_to_file");
    expect(toolEndEvent).toBeDefined();
    expect(toolEndEvent[0].toolResult.isError).toBeUndefined(); // should be successful
  });
});
