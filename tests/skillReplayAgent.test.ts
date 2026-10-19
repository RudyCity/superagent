import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillReplayModelTools, getSkillReplayToolNames } from "../src/core/skills/skillReplayAgent.js";
import type { SkillReplayExecutorContext, SkillReplayTools } from "../src/core/skills/skillReplay.js";
import { loadSkillReplayFixture } from "../src/core/skills/skillLifecycleCli.js";

type ModelTool = {
  description: string;
  parameters: unknown;
  execute: (args?: Record<string, unknown>) => Promise<string>;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function createContext(tools: SkillReplayTools, workspaceRoot = path.join(os.tmpdir(), "replay-tool-test-root")): SkillReplayExecutorContext {
  return {
    skillName: "replay-toolset-fixture",
    skillVersion: "abcdef123456",
    instructions: "# Candidate guide",
    taskPrompt: "Write a small file",
    fixtureId: "toolset-fixture-v1",
    signal: new AbortController().signal,
    workspaceRoot,
    tools,
  };
}

describe("model-driven skill replay tool boundary", () => {
  it("exposes exactly five file-only operations, with no command or network capabilities", async () => {
    const toolsApi: SkillReplayTools = {
      listFiles: vi.fn(async () => ["input.txt"]),
      readFile: vi.fn(async (p) => "contents:" + p),
      writeFile: vi.fn(async () => {}),
      assertFileExists: vi.fn(async () => {}),
      verifySyntax: vi.fn(async () => {}),
    };
    const modelTools = createSkillReplayModelTools(createContext(toolsApi));
    expect(Object.keys(modelTools).sort()).toEqual([...getSkillReplayToolNames()].sort());
    expect(Object.keys(modelTools)).not.toContain("run_command");
    expect(Object.keys(modelTools)).not.toContain("fetch_url");
    for (const value of Object.values(modelTools)) {
      const tool = value as ModelTool;
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }

    expect(await (modelTools.replay_list_files as ModelTool).execute({})).toContain("input.txt");
    expect(await (modelTools.replay_read_file as ModelTool).execute({ path: "input.txt" })).toBe("contents:input.txt");
    await (modelTools.replay_write_file as ModelTool).execute({ path: "output.txt", content: "ok" });
    await (modelTools.replay_assert_file_exists as ModelTool).execute({ path: "output.txt" });
    await (modelTools.replay_verify_syntax as ModelTool).execute({ path: "output.ts" });
    expect(toolsApi.writeFile).toHaveBeenCalledWith("output.txt", "ok");
    expect(toolsApi.assertFileExists).toHaveBeenCalledWith("output.txt");
    expect(toolsApi.verifySyntax).toHaveBeenCalledWith("output.ts");
  });

  it("rejects traversal, absolute paths and oversized writes before calling the sandbox API", async () => {
    const toolsApi: SkillReplayTools = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      assertFileExists: vi.fn(async () => {}),
      verifySyntax: vi.fn(async () => {}),
    };
    const modelTools = createSkillReplayModelTools(createContext(toolsApi));
    const read = modelTools.replay_read_file as ModelTool;
    const write = modelTools.replay_write_file as ModelTool;

    expect(await read.execute({ path: "../outside.txt" })).toMatch(/TOOL_ERROR/i);
    expect(await read.execute({ path: "C:\\outside.txt" })).toMatch(/TOOL_ERROR/i);
    expect(await write.execute({ path: "output.txt", content: "x".repeat(100_001) })).toMatch(/TOOL_ERROR/i);
    expect(toolsApi.readFile).not.toHaveBeenCalled();
    expect(toolsApi.writeFile).not.toHaveBeenCalled();
  });

  it("loads replay fixtures only from regular JSON files within the selected workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-fixture-loader-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "fixtures"), { recursive: true });
    const fixture = {
      fixtureId: "unit-fixture-v1",
      name: "Unit fixture",
      description: "For fixture loader tests",
      taskPrompt: "Write output.txt",
      initialFiles: { "input.txt": "test" },
      actions: [{ type: "assert_file_exists", target: "output.txt" }],
    };
    await fs.writeFile(path.join(root, "fixtures", "test.json"), JSON.stringify(fixture), "utf8");

    expect(loadSkillReplayFixture(root, "fixtures/test.json")).toMatchObject({ fixtureId: "unit-fixture-v1" });
    expect(() => loadSkillReplayFixture(root, "../outside.json")).toThrow(/unsupported path segment/i);
    expect(() => loadSkillReplayFixture(root, path.join(root, "fixtures", "test.json"))).toThrow(/relative JSON path/i);

    await fs.writeFile(path.join(root, "fixtures", "broken.json"), "{not json", "utf8");
    expect(() => loadSkillReplayFixture(root, "fixtures/broken.json")).toThrow(/valid JSON/i);
  });
});
