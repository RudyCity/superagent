import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import fsPromises from "fs/promises";
import { Agent } from "../src/core/agent.js";
import { generateText, streamText } from "ai";

// Mock configuration partially, keeping other config helpers intact
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false, // test streaming code path
      workingDirectory: process.cwd(),
    }),
  };
});

// Mock ai SDK partially, preserving other helpers like jsonSchema
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

describe("Master Agent Workflow & Guardrails", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should block Master Agent from modifying source files, but allow planning files", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "master";
    agent.planState = "APPROVED";

    let callCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
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
      callCount++;
      const current = callCount;
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

    let callCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
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
      callCount++;
      const current = callCount;
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

  it("should block Master Agent from writing a shallow plan and report missing sections", async () => {
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

    let callCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
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
      callCount++;
      const current = callCount;
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
    expect(toolEndEvent[0].toolResult.isError).toBe(true);
    expect(toolEndEvent[0].toolResult.result).toContain("The implementation plan is invalid or lacks deep structure");
    expect(toolEndEvent[0].toolResult.result).toContain("Verification Plan section");
    expect(toolEndEvent[0].toolResult.result).toContain("Automated Tests sub-section");
    expect(toolEndEvent[0].toolResult.result).toContain("Manual Verification sub-section");
  });

  it("should block Superagent execution when the task tracking file is missing", async () => {
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

    let callCount = 0;

    vi.mocked(generateText).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
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
      callCount++;
      const current = callCount;
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
    expect(toolEndEvent[0].toolResult.isError).toBe(true);
    expect(toolEndEvent[0].toolResult.result).toContain("Task Tracking File is missing");
  });
});
