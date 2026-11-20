import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setYoloMode, setFullYoloMode, executeToolCall } from "../src/core/permissions.js";
import { ToolExecutor } from "../src/core/agent/ToolExecutor.js";

describe("Superagent CLI YOLO bypasses desktop Access Manager / permanent file policy", () => {
  let isolated: string;
  let priorConfig: string | undefined;

  function makeMockAgent(isMultiAgent = false) {
    return {
      getActiveTools: vi.fn(async () => [
        {
          name: "git_status",
          execute: async () => "Clean working tree",
        },
      ]),
      onEvent: vi.fn(),
      workingDirectory: isolated,
      worktreePath: null,
      isMultiAgent,
      tier: isMultiAgent ? "master" : "single",
      delegationDepth: 0,
      planState: "IDLE",
      allowSessionOutOfBounds: false,
      allowSessionFileWriteOutOfBounds: false,
      allowSessionEnvAccess: false,
      allowSessionDangerous: false,
      isSimpleTask: false,
      simpleTaskApproved: false,
      getPlanFilePath: vi.fn(() => path.join(isolated, "plan.md")),
      getTaskFilePath: vi.fn(() => path.join(isolated, "task.md")),
      getWalkthroughFilePath: vi.fn(() => path.join(isolated, "walkthrough.md")),
      emitViolation: vi.fn(),
    } as any;
  }

  beforeEach(() => {
    priorConfig = process.env.SUPERAGENT_CONFIG_DIR;
    isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sa-cli-yolo-gate-"));
    process.env.SUPERAGENT_CONFIG_DIR = isolated;

    // Simulate Desktop Access Manager having a permanent deny policy
    fs.writeFileSync(
      path.join(isolated, "desktop-access-registry.json"),
      JSON.stringify({ version: 2, defaultEffect: "deny", rules: [] })
    );
    setYoloMode(false);
  });

  afterEach(() => {
    setYoloMode(false);
    if (priorConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = priorConfig;
    if (isolated) fs.rmSync(isolated, { recursive: true, force: true });
  });

  it("denies uncertified CLI tool when YOLO is off and permanent file policy exists", async () => {
    const agent = makeMockAgent();
    const toolCall = {
      id: "call-1",
      name: "git_status",
      args: {},
    };

    const results = await ToolExecutor.executeTools(
      agent,
      [toolCall],
      [],
      [],
      true,
      "test prompt"
    );

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].result).toMatch(/Access denied by permanent host file policy/i);
  });

  it("permits CLI tool in ToolExecutor when Scoped YOLO is active", async () => {
    setYoloMode(true);
    const agent = makeMockAgent();
    const toolCall = {
      id: "call-2",
      name: "git_status",
      args: {},
    };

    const results = await ToolExecutor.executeTools(
      agent,
      [toolCall],
      [],
      [],
      true,
      "test prompt"
    );

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].result).toBe("Clean working tree");
  });

  it("permits CLI tool in ToolExecutor when Full YOLO is active", async () => {
    setFullYoloMode(true);
    const agent = makeMockAgent();
    const toolCall = {
      id: "call-3",
      name: "git_status",
      args: {},
    };

    const results = await ToolExecutor.executeTools(
      agent,
      [toolCall],
      [],
      [],
      true,
      "test prompt"
    );

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].result).toBe("Clean working tree");
  });

  it("permits direct executeToolCall when YOLO is active", async () => {
    setYoloMode(true);
    const toolCall = {
      id: "call-4",
      name: "git_status",
      args: {},
    };

    const result = await executeToolCall(toolCall, isolated);
    expect(result.result).not.toMatch(/Access denied by permanent host file policy/i);
  });
});
