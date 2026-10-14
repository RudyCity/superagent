import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executionState = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  started: [] as string[],
}));

vi.mock("../src/core/permissions.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    executeToolCall: vi.fn(async (tc: any) => {
      executionState.active += 1;
      executionState.maxActive = Math.max(executionState.maxActive, executionState.active);
      executionState.started.push(tc.id);
      await new Promise((resolve) => setTimeout(resolve, 25));
      executionState.active -= 1;
      return { toolCallId: tc.id, name: tc.name, result: tc.id };
    }),
    getToolDescription: vi.fn(() => "parallel-test"),
    isDangerousCommand: vi.fn(() => false),
    isToolCallOutOfBounds: vi.fn(() => false),
    isModelConfigAccess: vi.fn(() => false),
    isSensitiveEnvFileAccess: vi.fn(() => false),
    isYoloMode: vi.fn(() => false),
    isFullYoloMode: vi.fn(() => false),
    isToolCallWithinYoloScope: vi.fn(() => false),
  };
});

import { ToolExecutor, shouldParallelizeToolCalls, buildToolCallSchedule } from "../src/core/agent/ToolExecutor.js";
import { readTool } from "../src/core/tools/fileReadTools.js";
import { writeToFileTool, replaceFileContentTool, multiReplaceFileContentTool, applyPatchTool } from "../src/core/tools/fileEditTools.js";
import type { ToolCall } from "../src/core/conversation.js";

const makeToolCall = (id: string, name = "read"): ToolCall => ({
  id,
  name,
  args: { filePaths: [`src/${id}.ts`] },
});

function makeAgent(isMultiAgent: boolean) {
  return {
    getActiveTools: vi.fn(async () => []),
    onEvent: vi.fn(),
    workingDirectory: process.cwd(),
    worktreePath: null,
    isMultiAgent,
    tier: isMultiAgent ? "master" : "single",
    delegationDepth: 1,
    planState: "IDLE",
    allowSessionOutOfBounds: false,
    allowSessionFileWriteOutOfBounds: false,
    allowSessionEnvAccess: false,
    allowSessionDangerous: false,
    isSimpleTask: false,
    simpleTaskApproved: false,
    getPlanFilePath: vi.fn(() => "plan.md"),
    getTaskFilePath: vi.fn(() => "task.md"),
    getWalkthroughFilePath: vi.fn(() => "walkthrough.md"),
    emitViolation: vi.fn(),
  };
}

describe("ToolExecutor parallel dispatch", () => {
  beforeEach(() => {
    executionState.active = 0;
    executionState.maxActive = 0;
    executionState.started = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { mode: "single", isMultiAgent: false },
    { mode: "multi", isMultiAgent: true },
  ])("dispatches independent read-only calls concurrently in $mode mode", async ({ isMultiAgent }) => {
    const agent = makeAgent(isMultiAgent);
    const calls = [makeToolCall("read-a"), makeToolCall("read-b"), makeToolCall("read-c")];

    expect(shouldParallelizeToolCalls(calls, agent.workingDirectory)).toBe(true);

    const results = await ToolExecutor.executeTools(
      agent as any,
      calls,
      [],
      [],
      true,
      "test prompt"
    );

    expect(executionState.maxActive).toBeGreaterThan(1);
    expect(executionState.started).toHaveLength(3);
    expect(results.map((result) => result.toolCallId)).toEqual(["read-a", "read-b", "read-c"]);
  });

  it("keeps mutating and shell calls out of the concurrent dispatch path", () => {
    expect(shouldParallelizeToolCalls([makeToolCall("read-a"), makeToolCall("write-a", "write_to_file")])).toBe(false);
    expect(shouldParallelizeToolCalls([makeToolCall("shell-a", "run_command"), makeToolCall("shell-b", "run_command")])).toBe(false);
    expect(shouldParallelizeToolCalls([makeToolCall("read-only-one")])).toBe(false);
  });

  it("schedules safe read groups around ordered side-effect barriers", () => {
    const calls = [
      makeToolCall("read-a"),
      makeToolCall("read-b"),
      { id: "write-a", name: "write_to_file", args: { files: [{ filePath: "src/x.ts", content: "x" }] } },
      makeToolCall("read-c"),
      makeToolCall("read-d"),
    ] as ToolCall[];

    const groups = buildToolCallSchedule(calls, process.cwd());

    expect(groups.map((group) => ({
      ids: group.calls.map((call) => call.id),
      parallel: group.parallel,
    }))).toEqual([
      { ids: ["read-a", "read-b"], parallel: true },
      { ids: ["write-a"], parallel: false },
      { ids: ["read-c", "read-d"], parallel: true },
    ]);
  });

  it.each([
    { name: "read", tool: readTool, args: { filePath: "src/example.ts" }, required: "filePaths" },
    { name: "write_to_file", tool: writeToFileTool, args: { filePath: "src/example.ts", content: "x" }, required: "files" },
    { name: "replace_file_content", tool: replaceFileContentTool, args: { filePath: "src/example.ts", targetContent: "x", replacementContent: "y", startLine: 1, endLine: 1 }, required: "edits" },
    { name: "multi_replace_file_content", tool: multiReplaceFileContentTool, args: { filePath: "src/example.ts", chunks: [] }, required: "files" },
    { name: "apply_patch", tool: applyPatchTool, args: { filePath: "src/example.ts", patchContent: "" }, required: "patches" },
  ])("rejects single-file invocation of $name and requires $required batch input", async ({ tool, args, required }) => {
    expect((tool.parameters as any).required).toContain(required);
    const exposedProperties = Object.keys((tool.parameters as any).properties || {});
    expect(exposedProperties).not.toContain("filePath");
    expect(exposedProperties).not.toContain("patchContent");
    expect(exposedProperties).not.toContain("targetContent");
    expect(exposedProperties).not.toContain("replacementContent");
    const result = await (tool as any).execute(args, process.cwd());
    expect(String(result)).toContain("disabled");
  });
});
