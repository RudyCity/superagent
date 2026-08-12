import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { parseXmlToolCalls } from "../src/utils/xmlToolParser.js";
import { executeToolCall } from "../src/core/permissions.js";
import { agentLocalStorage, Agent } from "../src/core/agent.js";
import { updateSettings, getSettings, clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import { ensureGlobalConfigDir, getModelConfigPath } from "../src/core/config/paths.js";

describe("Tool Calling Robustness - XML parser with attributes", () => {
  const toolDefs = [
    { name: "read" },
    { name: "write_to_file" },
    { name: "run_command" }
  ];

  it("should parse <tool_call> tags containing attributes", () => {
    const text = `
Here is a tool call:
<tool_calls>
<tool_call id="call_abc123" name="test">
{"name": "read", "arguments": {"filePath": "src/app.ts"}}
</tool_call>
</tool_calls>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[0].args).toEqual({ filePath: "src/app.ts" });
    expect(result.cleanText).toBe("Here is a tool call:");
  });

  it("should parse standalone <tool_call> tags containing attributes", () => {
    const text = `
<tool_call id="call_xyz789">
{"name": "write_to_file", "arguments": {"TargetFile": "src/index.ts", "CodeContent": "content"}}
</tool_call>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("write_to_file");
    expect(result.toolCalls[0].args).toEqual({ TargetFile: "src/index.ts", CodeContent: "content" });
    expect(result.cleanText).toBe("");
  });

  it("should clean up stray XML tags that contain attributes", () => {
    const text = `
some text <tool_calls class="debug">
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanText).toBe("some text");
  });
});

describe("Tool Calling Robustness - Tier validation on executeToolCall", () => {
  let tempHome: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-test-robustness-"));
    originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = tempHome;
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.SUPERAGENT_CONFIG_DIR;
    }
    try {
      fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    clearModelConfigCache();
  });

  it("should block a researcher subagent from calling write_to_file", async () => {
    // Create an agent instance set to researcher subagent tier
    const onEvent = vi.fn();
    const onPermission = vi.fn(async () => true);
    const onQuestion = vi.fn(async () => "answer");
    
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "subagent";
    agent.subagentType = "researcher";
    agent.workingDirectory = tempHome;

    // Run the execution block inside agentLocalStorage context
    await agentLocalStorage.run(agent, async () => {
      const toolCall = {
        id: "call_test",
        name: "write_to_file",
        args: {
          TargetFile: path.join(tempHome, "test.txt"),
          CodeContent: "hello"
        }
      };

      const result = await executeToolCall(toolCall, tempHome);
      expect(result.isError).toBe(true);
      expect(result.result).toContain("is not available for this agent's tier");
    });
  });

  it("should allow a researcher subagent to call read", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn(async () => true);
    const onQuestion = vi.fn(async () => "answer");
    
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "subagent";
    agent.subagentType = "researcher";
    agent.workingDirectory = tempHome;

    // Write a test file to read
    const testFile = path.join(tempHome, "test.txt");
    fs.writeFileSync(testFile, "hello from test", "utf-8");

    await agentLocalStorage.run(agent, async () => {
      const toolCall = {
        id: "call_test",
        name: "read",
        args: {
          filePath: testFile
        }
      };

      const result = await executeToolCall(toolCall, tempHome);
      expect(result.isError).toBeUndefined();
      expect(result.result).toContain("hello from test");
    });
  });
});
