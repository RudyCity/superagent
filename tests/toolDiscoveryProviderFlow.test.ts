import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, streamText } from "ai";
import { Agent } from "../src/core/agent.js";
import { RequestProcessor } from "../src/core/agent/RequestProcessor.js";
import { LoopIterationProcessor } from "../src/core/agent/LoopIterationProcessor.js";
import { listToolsTool, describeToolTool } from "../src/core/tools/toolDiscoveryTools.js";
import { setYoloMode, setFullYoloMode } from "../src/core/permissions.js";
import type { Tool } from "../src/core/tools/types.js";
import * as configModule from "../src/core/config.js";
import * as rmemoryModule from "../src/core/rmemoryUtil.js";

function makeFixtureTool(execute: ReturnType<typeof vi.fn>): Tool {
  return {
    name: "inspect_fixture",
    description: "Inspect the integration-test fixture.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    execute,
  };
}

function nativeToolCall(name: string, args: Record<string, unknown>, id: string) {
  return {
    fullStream: (async function* () {
      yield { type: "tool-call", toolCallId: id, toolName: name, args };
    })(),
    usage: Promise.resolve({ promptTokens: 12, completionTokens: 4 }),
  } as any;
}

describe.each([
  ["native function calling", false],
  ["prompt/XML tool calling", true],
] as const)("progressive discovery in the Agent model loop: %s", (mode, promptBased) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends only discovery schemas first, then the described schema, and executes it", async () => {
    const originalSettings = configModule.getSettings();
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "test-model",
      apiKey: "test-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Integration test system prompt",
    } as any);
    vi.spyOn(configModule, "getSettings").mockReturnValue({
      ...originalSettings,
      forcePromptBasedToolCalling: promptBased,
      concurrencyLimit: 2,
      enableAdvisor: false,
      maxIterations: 5,
    } as any);
    vi.spyOn(rmemoryModule, "isRmemoryActive").mockResolvedValue(false);

    let executions = 0;
    const executeFixture = vi.fn(async ({ value }: { value: string }) => {
      executions += 1;
      return `inspected:${value}`;
    });
    const fixture = makeFixtureTool(executeFixture);
    const agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      [{ ...listToolsTool }, { ...describeToolTool }, fixture],
      process.cwd(),
    );
    agent.tier = "single";
    agent.planState = "APPROVED";
    vi.spyOn(agent, "getModel").mockReturnValue({ modelId: "test-model", provider: "openai" } as any);
    agent.conversation.addUserMessage("Discover and run inspect_fixture with value ok.");

    const nativeSchemas: string[][] = [];
    const promptSystems: string[] = [];

    vi.mocked(streamText).mockImplementation((options: any) => {
      nativeSchemas.push(Object.keys(options.tools || {}));
      return nativeToolCall(
        nativeSchemas.length === 1 ? "describe_tool" : "inspect_fixture",
        nativeSchemas.length === 1 ? { tool: "inspect_fixture" } : { value: "ok" },
        `native-call-${nativeSchemas.length}`,
      );
    });

    vi.mocked(generateText).mockImplementation(async (options: any) => {
      promptSystems.push(String(options.system || ""));
      const callNumber = promptSystems.length;
      return {
        text: callNumber === 1
          ? '<tool_call>{"name":"describe_tool","arguments":{"tool":"inspect_fixture"}}</tool_call>'
          : '<tool_call>{"name":"inspect_fixture","arguments":{"value":"ok"}}</tool_call>',
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 12, completionTokens: 4 },
      } as any;
    });

    try {
      await LoopIterationProcessor.processIteration(agent, 0, 5);
      await LoopIterationProcessor.processIteration(agent, 1, 5);

      if (promptBased) {
        expect(promptSystems).toHaveLength(2);
        expect(promptSystems[0]).toContain("list_tools");
        expect(promptSystems[0]).toContain("describe_tool");
        expect(promptSystems[0]).not.toContain("inspect_fixture");
        expect(promptSystems[1]).toContain("inspect_fixture");
      } else {
        expect(nativeSchemas).toHaveLength(2);
        expect(nativeSchemas[0]).toEqual(["list_tools", "describe_tool"]);
        expect(nativeSchemas[1]).toEqual(["list_tools", "describe_tool", "inspect_fixture"]);
      }

      expect(agent.isToolDiscovered("inspect_fixture")).toBe(true);
      expect(executions).toBe(1);
      expect(executeFixture).toHaveBeenCalledWith({ value: "ok" }, process.cwd(), undefined);
    } finally {
      agent.dispose();
    }
  });
});

describe("discovery lifecycle across Agent tasks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function configureAgent(inputReason: (input: string) => string, maxIterations = 5) {
    const originalSettings = configModule.getSettings();
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "test-model",
      apiKey: "test-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Task lifecycle test system prompt",
    } as any);
    vi.spyOn(configModule, "getSettings").mockReturnValue({
      ...originalSettings,
      forcePromptBasedToolCalling: false,
      concurrencyLimit: 2,
      enableAdvisor: false,
      maxIterations,
    } as any);
    vi.spyOn(rmemoryModule, "isRmemoryActive").mockResolvedValue(false);

    const fixture = makeFixtureTool(vi.fn(async () => "inspected"));
    const agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      [{ ...listToolsTool }, { ...describeToolTool }, fixture],
      process.cwd(),
    );
    agent.tier = "single";
    agent.planState = "APPROVED";
    vi.spyOn(agent, "getModel").mockReturnValue({ modelId: "test-model", provider: "openai" } as any);
    vi.spyOn(RequestProcessor, "processRequest").mockImplementation(async (currentAgent, input) => {
      const text = typeof input === "string" ? input : "";
      currentAgent.currentClassification = {
        category: "question",
        confidence: "high",
        reason: inputReason(text),
        heuristicOnly: true,
        classificationTokens: 0,
      };
      currentAgent.conversation.addUserMessage(input);
      return true;
    });

    const schemaCalls: string[][] = [];
    vi.mocked(streamText).mockImplementation((options: any) => {
      schemaCalls.push(Object.keys(options.tools || {}));
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Here is the answer to your question." };
        })(),
        usage: Promise.resolve({ promptTokens: 12, completionTokens: 7 }),
      } as any;
    });
    return { agent, schemaCalls };
  }

  it("hides previously discovered schemas when a new independent task starts", async () => {
    const { agent, schemaCalls } = await configureAgent(() => "Independent question");
    try {
      const tools = await agent.getActiveTools();
      await tools.find((tool) => tool.name === "describe_tool")!.execute(
        { tool: "inspect_fixture" },
        process.cwd(),
      );
      expect(agent.isToolDiscovered("inspect_fixture")).toBe(true);

      await agent.sendMessage("What is the status?");

      expect(schemaCalls).toHaveLength(1);
      expect(schemaCalls[0]).toEqual(["list_tools", "describe_tool"]);
      expect(agent.isToolDiscovered("inspect_fixture")).toBe(false);
    } finally {
      agent.dispose();
    }
  });

  it("preserves discovered schemas for a recognized task continuation", async () => {
    const { agent, schemaCalls } = await configureAgent(() => "User requested continuation of task");
    try {
      const tools = await agent.getActiveTools();
      await tools.find((tool) => tool.name === "describe_tool")!.execute(
        { tool: "inspect_fixture" },
        process.cwd(),
      );
      expect(agent.isToolDiscovered("inspect_fixture")).toBe(true);

      await agent.sendMessage("lanjut");

      expect(schemaCalls).toHaveLength(1);
      expect(schemaCalls[0]).toContain("inspect_fixture");
      expect(agent.isToolDiscovered("inspect_fixture")).toBe(true);
    } finally {
      agent.dispose();
    }
  });

  it("stops unchanged tool calls with the optional advisor disabled", async () => {
    const { agent } = await configureAgent(() => "tool execution", 12);
    const tools = await agent.getActiveTools();
    await tools.find((tool) => tool.name === "describe_tool")!.execute(
      { tool: "inspect_fixture" },
      process.cwd(),
    );
    let modelCalls = 0;
    const output: string[] = [];
    agent.onEvent = (event) => {
      if (event.type === "text") output.push(event.content);
    };
    vi.mocked(streamText).mockImplementation(() =>
      nativeToolCall("inspect_fixture", { value: "same" }, "repeat-" + (++modelCalls))
    );

    try {
      await agent.sendMessage("Inspect the same fixture repeatedly");
      expect(modelCalls).toBe(6);
      expect(output.some((message) => message.includes("Loop guard stopped"))).toBe(true);
    } finally {
      agent.dispose();
    }
  });

  it("does not auto-repeat a completed answer when a motion-tools question is misclassified", async () => {
    const { agent, schemaCalls } = await configureAgent(() => "misclassified request");
    vi.spyOn(RequestProcessor, "processRequest").mockImplementation(async (currentAgent, input) => {
      currentAgent.currentClassification = {
        category: "complex_task",
        confidence: "high",
        reason: "Intent classifier incorrectly marked a question as a task",
        heuristicOnly: true,
        classificationTokens: 0,
      };
      currentAgent.conversation.addUserMessage(input);
      return true;
    });

    try {
      await agent.sendMessage("oke ada tols motion gak?");
      expect(schemaCalls).toHaveLength(1);
      expect(agent.textOnlyContinuationNudges).toBe(0);
    } finally {
      agent.dispose();
    }
  });

  it("stops checklist nudges on genuine unfinished subtasks instead of looping to max iterations", async () => {
    const { agent, schemaCalls } = await configureAgent(() => "explicit work");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const fixturePath = path.join(os.tmpdir(), "superagent-checklist-nudge-" + process.pid + ".md");
    fs.writeFileSync(fixturePath, [
      "# Tasks",
      "",
      "- [/] implement motion feature",
      "- [ ] run tests",
      "",
    ].join(String.fromCharCode(10)));
    vi.spyOn(agent, "getTaskFilePath").mockReturnValue(fixturePath);

    try {
      await agent.sendMessage("implement motion feature");
      expect(schemaCalls).toHaveLength(2);
      expect(agent.textOnlyContinuationNudges).toBe(1);
      const messages = agent.getConversationMessages();
      expect(messages.filter((message) => message.role === "system" &&
        String(message.content).includes("unfinished task"))).toHaveLength(1);
    } finally {
      agent.dispose();
      fs.rmSync(fixturePath, { force: true });
    }
  });
});

describe("discovery does not bypass dangerous-command approval", () => {
  afterEach(() => {
    setYoloMode(false);
    setFullYoloMode(false);
    vi.restoreAllMocks();
  });

  it("requires the normal permission decision after run_command is discovered", async () => {
    const originalSettings = configModule.getSettings();
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "test-model",
      apiKey: "test-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Dangerous-command discovery test",
    } as any);
    vi.spyOn(configModule, "getSettings").mockReturnValue({
      ...originalSettings,
      forcePromptBasedToolCalling: false,
      concurrencyLimit: 2,
      enableAdvisor: false,
      maxIterations: 5,
    } as any);
    vi.spyOn(rmemoryModule, "isRmemoryActive").mockResolvedValue(false);
    setYoloMode(false);
    setFullYoloMode(false);

    const executeCommand = vi.fn(async () => "command should not execute");
    const commandTool: Tool = {
      name: "run_command",
      description: "Run a command after normal command approval.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      execute: executeCommand,
    };
    const onEvent = vi.fn();
    const onPermission = vi.fn(async () => false);
    const agent = new Agent(
      onEvent,
      onPermission,
      vi.fn(async () => "continue"),
      undefined,
      [{ ...listToolsTool }, { ...describeToolTool }, commandTool],
      process.cwd(),
    );
    agent.tier = "single";
    agent.planState = "APPROVED";
    vi.spyOn(agent, "getModel").mockReturnValue({ modelId: "test-model", provider: "openai" } as any);
    agent.conversation.addUserMessage("Discover then attempt a dangerous command.");

    let providerCall = 0;
    vi.mocked(streamText).mockImplementation((options: any) => {
      providerCall += 1;
      expect(Object.keys(options.tools || {})).toContain("describe_tool");
      return nativeToolCall(
        providerCall === 1 ? "describe_tool" : "run_command",
        providerCall === 1 ? { tool: "run_command" } : { command: "rm -rf /tmp/discovery-guard-test" },
        `dangerous-discovery-${providerCall}`,
      );
    });

    try {
      await LoopIterationProcessor.processIteration(agent, 0, 5);
      expect(agent.isToolDiscovered("run_command")).toBe(true);
      await LoopIterationProcessor.processIteration(agent, 1, 5);

      expect(onPermission).toHaveBeenCalledOnce();
      expect(executeCommand).not.toHaveBeenCalled();
      const denied = onEvent.mock.calls.find((call) =>
        call[0].type === "tool_end" && call[0].toolResult.name === "run_command"
      );
      expect(denied?.[0].toolResult.isError).toBe(true);
      expect(denied?.[0].toolResult.result).toContain("User denied permission");
    } finally {
      agent.dispose();
      setYoloMode(false);
      setFullYoloMode(false);
    }
  });
});
