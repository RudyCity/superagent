# Superagent Log Error Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the recurring bugs found in `C:\Users\USER\.superagent-r\superagent.log` by fixing tool registration, error status propagation, task checklist polling, Windows command guidance, and worktree cleanup.

**Architecture:** Keep changes scoped to existing agent/tool boundaries. The runtime should expose only executable tools, classify failed tool executions as errors, keep global planning files owned by Master-tier flows, and avoid noisy UI polling logs when a task file is legitimately missing. Worktree cleanup should use the existing `git_worktree` tool instead of ad hoc shell chains.

**Tech Stack:** Node.js, TypeScript, React, Ink, Vitest, Execa.

---

## File Structure

- Modify `src/core/tools/index.ts`
  - Register every tool that appears in tier toolsets so `getToolByName()` can execute what the model is allowed to call.
- Create `tests/toolRegistryConsistency.test.ts`
  - Prevent future drift between `toolsets.ts` and `allTools`.
- Modify `src/core/permissions.ts`
  - Mark tool results as `isError` when the tool returns a known error string.
- Modify `src/core/tools/shellTools.ts`
  - Make `run_command` report non-zero exit codes like `bash` already does.
- Create `tests/toolErrorStatus.test.ts`
  - Verify missing file reads, invalid grep regexes, and non-zero commands are `isError`.
- Create `src/core/taskChecklist.ts`
  - Centralize task checklist parsing and missing-file handling.
- Modify `src/app.tsx`
  - Replace duplicate checklist parsing and stop logging task-file `ENOENT` as repeated `[ERROR]`.
- Modify `src/components/multi-agent-dashboard.tsx`
  - Apply the same checklist handling in the multi-agent dashboard.
- Create `tests/taskChecklist.test.ts`
  - Verify checklist parsing and missing-file handling.
- Modify `src/core/agent.ts`
  - Block Superagent spawn/merge when plan is approved but task tracking file is missing.
- Modify `tests/masterAgentWorkflow.test.ts`
  - Add a guardrail test for missing task tracking file before `invoke_superagent`.
- Modify `src/core/config.ts`
  - Align command guidance with Windows separator requirements and available tools.
- Modify `src/core/prompts.ts`
  - Remove stale `bash`/`git_worktree` contradictions and clarify tier ownership for planning lifecycle files.
- Create `tests/promptToolGuidance.test.ts`
  - Keep prompts from reintroducing invalid guidance.
- Modify `src/core/tools/otherTools.ts`
  - Make `git_worktree remove --force` resilient to stale metadata and Windows long-path deletion failures.
- Modify `tests/gitWorktreeTool.test.ts`
  - Cover fallback cleanup paths.

---

### Task 1: Tool Registry Consistency

**Files:**
- Create: `tests/toolRegistryConsistency.test.ts`
- Modify: `src/core/tools/index.ts`

- [ ] **Step 1: Write the failing registry test**

Create `tests/toolRegistryConsistency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allTools, getToolByName } from "../src/core/tools/index.js";
import {
  defaultSubagentToolset,
  masterToolset,
  subagentToolsets,
  superagentToolset,
} from "../src/core/tools/toolsets.js";

describe("tool registry consistency", () => {
  it("registers every tool exposed by tier toolsets", () => {
    const exposedTools = [
      ...masterToolset,
      ...superagentToolset,
      ...defaultSubagentToolset,
      ...Object.values(subagentToolsets).flat(),
    ];

    const missing = [...new Set(exposedTools.map((tool) => tool.name))]
      .filter((name) => !getToolByName(name));

    expect(missing).toEqual([]);
  });

  it("does not contain duplicate allTools registrations", () => {
    const names = allTools.map((tool) => tool.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  it("can execute tools that repeatedly appeared as unknown in logs", () => {
    expect(getToolByName("bash")?.name).toBe("bash");
    expect(getToolByName("git_worktree")?.name).toBe("git_worktree");
    expect(getToolByName("list_peer_superagents")?.name).toBe("list_peer_superagents");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
clov npm test -- tests/toolRegistryConsistency.test.ts
```

Expected before implementation: FAIL listing at least `bash`, `git_worktree`, and `list_peer_superagents` as missing.

- [ ] **Step 3: Register missing tools**

Modify `src/core/tools/index.ts`:

```ts
import {
  askQuestionTool,
  scheduleTool,
  gitActionTool,
  screenshotTool,
  androidCliTool,
  searchHistoryTool,
  manageTasksTool,
  gitWorktreeTool,
  listPeerSuperagentsTool,
} from "./otherTools.js";
```

Update `allTools` so it contains the missing executable tools exactly once:

```ts
export const allTools: Tool[] = [
  readTool,
  editTool,
  askQuestionTool,
  globTool,
  grepTool,
  webSearchTool,
  fetchUrlTool,
  ripgrepSearchTool,
  bashTool,
  runBackgroundProcessTool,
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  runCommandTool,
  manageBackgroundProcessTool,
  scheduleTool,
  defineSubagentTool,
  invokeSubagentTool,
  sendMessageTool,
  manageSubagentsTool,
  invokeSuperagentTool,
  awaitSuperagentsTool,
  mergeSuperagentsTool,
  manageSuperagentsTool,
  defineSuperagentTool,
  sendMessageToSuperagentTool,
  applyPatchTool,
  gitActionTool,
  gitWorktreeTool,
  screenshotTool,
  androidCliTool,
  searchHistoryTool,
  manageTasksTool,
  listPeerSuperagentsTool,
];
```

- [ ] **Step 4: Verify registry test passes**

Run:

```bash
clov npm test -- tests/toolRegistryConsistency.test.ts
```

Expected: PASS.

---

### Task 2: Tool Error Status Propagation

**Files:**
- Create: `tests/toolErrorStatus.test.ts`
- Modify: `src/core/permissions.ts`
- Modify: `src/core/tools/shellTools.ts`

- [ ] **Step 1: Write failing status tests**

Create `tests/toolErrorStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { executeToolCall } from "../src/core/permissions.js";

describe("tool error status propagation", () => {
  it("marks missing read targets as tool errors", async () => {
    const result = await executeToolCall(
      {
        id: "missing-read",
        name: "read",
        args: { filePath: "definitely-missing-file.txt" },
      } as any,
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Error reading file:");
  });

  it("marks invalid grep regexes as tool errors", async () => {
    const result = await executeToolCall(
      {
        id: "invalid-grep",
        name: "grep",
        args: { pattern: "(?i)(secret)", path: "src" },
      } as any,
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Error:");
  });

  it("marks non-zero run_command exits as tool errors", async () => {
    const result = await executeToolCall(
      {
        id: "bad-command",
        name: "run_command",
        args: { command: "node -e \"process.exit(7)\"", timeout: 30000 },
      } as any,
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Exit code: 7");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
clov npm test -- tests/toolErrorStatus.test.ts
```

Expected before implementation: at least one assertion fails because error strings are returned with `isError` undefined.

- [ ] **Step 3: Add tool-result error inference**

Modify `src/core/permissions.ts` near `executeToolCall`:

```ts
function isErrorLikeToolResult(result: string): boolean {
  const trimmed = result.trim();
  return (
    /^Error(?:\b|:)/i.test(trimmed) ||
    /^Error reading file:/i.test(trimmed) ||
    /^Git worktree error:/i.test(trimmed) ||
    /^Exit code:\s*[1-9]\d*/i.test(trimmed)
  );
}
```

Then replace the successful return inside `executeToolCall`:

```ts
const result = await tool.execute(toolCall.args, cwd, signal);
const isError = isErrorLikeToolResult(result);
return {
  toolCallId: toolCall.id,
  name: toolCall.name,
  result,
  ...(isError ? { isError: true } : {}),
};
```

- [ ] **Step 4: Make `run_command` return non-zero exit status**

Modify `src/core/tools/shellTools.ts` inside `runCommandTool.execute`, after output is truncated and before returning output:

```ts
if (result.exitCode !== 0) {
  return `Exit code: ${result.exitCode}\n${output}`;
}

return output || "(no output)";
```

- [ ] **Step 5: Verify status tests pass**

Run:

```bash
clov npm test -- tests/toolErrorStatus.test.ts
```

Expected: PASS.

---

### Task 3: Checklist Parser and No-Spam Polling

**Files:**
- Create: `src/core/taskChecklist.ts`
- Create: `tests/taskChecklist.test.ts`
- Modify: `src/app.tsx`
- Modify: `src/components/multi-agent-dashboard.tsx`

- [ ] **Step 1: Write checklist helper tests**

Create `tests/taskChecklist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { parseChecklistTasks, readChecklistTasks } from "../src/core/taskChecklist.js";

describe("task checklist helpers", () => {
  it("parses checked, active, and pending task lines", () => {
    const tasks = parseChecklistTasks([
      "- [ ] Pending task",
      "- [/] Active task",
      "- [x] Done task",
      "- `[X]` Done backtick task",
      "plain text",
    ].join("\n"));

    expect(tasks).toEqual([
      { status: " ", text: "Pending task" },
      { status: "/", text: "Active task" },
      { status: "x", text: "Done task" },
      { status: "x", text: "Done backtick task" },
    ]);
  });

  it("returns missing=true instead of throwing for absent task files", async () => {
    const result = await readChecklistTasks(path.join(os.tmpdir(), "missing-superagent-task.md"));

    expect(result).toEqual({ tasks: [], missing: true });
  });

  it("reads tasks from an existing task file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-task-"));
    const file = path.join(dir, "task.md");
    await fs.writeFile(file, "- [ ] First\n- [x] Second\n", "utf-8");

    const result = await readChecklistTasks(file);

    expect(result).toEqual({
      tasks: [
        { status: " ", text: "First" },
        { status: "x", text: "Second" },
      ],
      missing: false,
    });

    await fs.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
clov npm test -- tests/taskChecklist.test.ts
```

Expected before implementation: FAIL because `src/core/taskChecklist.ts` does not exist.

- [ ] **Step 3: Create checklist helper**

Create `src/core/taskChecklist.ts`:

```ts
import fs from "fs/promises";

export interface ChecklistTask {
  status: string;
  text: string;
}

export interface ReadChecklistResult {
  tasks: ChecklistTask[];
  missing: boolean;
}

export function parseChecklistTasks(content: string): ChecklistTask[] {
  const lines = content.split(/\r?\n/);
  const items: ChecklistTask[] = [];

  for (const line of lines) {
    const match =
      line.match(/^\s*-\s*`\[([xX/ ])\]`?\s*(.*)$/) ||
      line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
    if (match) {
      items.push({
        status: match[1].toLowerCase(),
        text: match[2].trim(),
      });
    }
  }

  return items;
}

export async function readChecklistTasks(taskPath: string): Promise<ReadChecklistResult> {
  try {
    const content = await fs.readFile(taskPath, "utf-8");
    return { tasks: parseChecklistTasks(content), missing: false };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { tasks: [], missing: true };
    }
    throw err;
  }
}
```

- [ ] **Step 4: Replace polling logic in `src/app.tsx`**

Import the helper:

```ts
import { readChecklistTasks } from "./core/taskChecklist.js";
```

Replace the body of the checklist `check` function with:

```ts
const check = async () => {
  const taskPath = agentRef.current ? agentRef.current.getTaskFilePath() : null;
  if (!taskPath) return;
  try {
    const result = await readChecklistTasks(taskPath);
    if (!active) return;
    setChecklistTasks(result.tasks);
  } catch (err: any) {
    if (agentRef.current) {
      agentRef.current.writeToLogFile("WARN", `Failed to read task checklist file from path '${taskPath}': ${err.message}`);
    }
    if (active) {
      setChecklistTasks([]);
    }
  }
};
```

- [ ] **Step 5: Replace polling logic in `src/components/multi-agent-dashboard.tsx`**

Import the helper:

```ts
import { readChecklistTasks } from "../core/taskChecklist.js";
```

Replace the body of the dashboard checklist `check` function with:

```ts
const check = async () => {
  const taskPath = agent ? agent.getTaskFilePath() : null;
  if (!taskPath) return;
  try {
    const result = await readChecklistTasks(taskPath);
    if (!active) return;
    setChecklistTasks(result.tasks);
  } catch (err: any) {
    if (agent) {
      agent.writeToLogFile("WARN", `Failed to read task checklist file from path '${taskPath}': ${err.message}`);
    }
    if (active) {
      setChecklistTasks([]);
    }
  }
};
```

- [ ] **Step 6: Verify checklist tests pass**

Run:

```bash
clov npm test -- tests/taskChecklist.test.ts
```

Expected: PASS.

---

### Task 4: Enforce Task Tracking File Before Multi-Agent Execution

**Files:**
- Modify: `src/core/agent.ts`
- Modify: `tests/masterAgentWorkflow.test.ts`

- [ ] **Step 1: Add a failing workflow test**

Append this test inside `describe("Master Agent Workflow & Guardrails", ...)` in `tests/masterAgentWorkflow.test.ts`:

```ts
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
    (call) => call[0].type === "tool_end" && call[0].toolResult.name === "invoke_superagent"
  );
  expect(toolEndEvent).toBeDefined();
  expect(toolEndEvent[0].toolResult.isError).toBe(true);
  expect(toolEndEvent[0].toolResult.result).toContain("Task Tracking File is missing");
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
clov npm test -- tests/masterAgentWorkflow.test.ts
```

Expected before implementation: FAIL because `invoke_superagent` is not blocked by missing `_task.md`.

- [ ] **Step 3: Add the guard in `src/core/agent.ts`**

Inside the `if (tc.name === "invoke_superagent" || tc.name === "merge_superagents")` block, after the existing `planState !== "APPROVED"` check and before execution reaches `executeToolCall`, add:

```ts
const taskFilePath = this.getTaskFilePath();
if (!fs.existsSync(taskFilePath)) {
  const blocked: ToolResult = {
    toolCallId: tc.id,
    name: tc.name,
    result: `Error: Task Tracking File is missing at '${taskFilePath}'. Write a task checklist to this exact file before spawning or merging Superagents.`,
    isError: true,
  };
  toolResults.push(blocked);
  this.onEvent({ type: "tool_end", toolResult: blocked, description });
  continue;
}
```

- [ ] **Step 4: Verify workflow test passes**

Run:

```bash
clov npm test -- tests/masterAgentWorkflow.test.ts
```

Expected: PASS.

---

### Task 5: Prompt and Windows Command Guidance

**Files:**
- Create: `tests/promptToolGuidance.test.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/prompts.ts`

- [ ] **Step 1: Write prompt guidance tests**

Create `tests/promptToolGuidance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("prompt and command guidance", () => {
  it("does not instruct Windows agents to chain commands with &&", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "src/core/config.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");

    expect(config).not.toContain("Since Git Bash is available, you CAN");
    expect(`${config}\n${prompts}`).not.toContain("using `run_command` or `bash`");
  });

  it("documents the Windows command separator rule in runtime guidance", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "src/core/config.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");
    const combined = `${config}\n${prompts}`;

    expect(combined).toContain("On Windows, use ';' to separate commands");
    expect(combined).toContain("Use `run_command` for validation commands");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
clov npm test -- tests/promptToolGuidance.test.ts
```

Expected before implementation: FAIL because current prompts mention stale Bash guidance.

- [ ] **Step 3: Update `src/core/config.ts` command guidance**

Replace guidance that says Git Bash is available and `bash` can be used for custom timeout with this text:

```ts
`ACTIVE TERMINAL SHELL: Windows PowerShell-compatible command execution.
- On Windows, use ';' to separate commands. Do not use '&&' in generated shell commands.
- Use 'run_command' for validation commands and pass the 'timeout' parameter when a custom timeout is needed.
- Use 'run_background_process' for long-running servers, watchers, or interactive processes.
- Use 'git_worktree' for worktree list/add/remove/prune operations instead of hand-written cleanup chains.`
```

- [ ] **Step 4: Update `src/core/prompts.ts` tool guidance**

Replace:

```ts
- Run unit/integration tests (e.g. `npm test`) using `run_command` or `bash` to ensure no regressions were introduced.
```

With:

```ts
- Run unit/integration tests (e.g. `npm test`) using `run_command` to ensure no regressions were introduced.
- On Windows, use `;` to separate commands. Do not write shell command chains with `&&`.
```

Add this Master-tier workflow rule near the planning lifecycle rules:

```ts
Only the Master Agent should write or read the global Implementation Plan, Task Tracking, and Verification/Walkthrough files. Superagents should work inside their isolated worktree unless explicitly given a file inside that worktree.
```

- [ ] **Step 5: Verify prompt guidance tests pass**

Run:

```bash
clov npm test -- tests/promptToolGuidance.test.ts
```

Expected: PASS.

---

### Task 6: Robust Git Worktree Cleanup

**Files:**
- Modify: `src/core/tools/otherTools.ts`
- Modify: `tests/gitWorktreeTool.test.ts`

- [ ] **Step 1: Add failing fallback cleanup tests**

Append to `tests/gitWorktreeTool.test.ts`:

```ts
it("should prune stale metadata when removing a path that is not a working tree", async () => {
  vi.mocked(execa)
    .mockRejectedValueOnce(new Error("fatal: '.worktrees/demo' is not a working tree"))
    .mockResolvedValueOnce({ stdout: "Pruned" } as any);

  const result = await gitWorktreeTool.execute(
    { action: "remove", path: "./.worktrees/demo", force: true },
    process.cwd()
  );

  expect(result).toContain("Worktree metadata pruned after stale remove");
  expect(execa).toHaveBeenLastCalledWith("git", ["worktree", "prune"], expect.any(Object));
});

it("should fall back to filesystem removal for forced remove failures", async () => {
  vi.mocked(execa)
    .mockRejectedValueOnce(new Error("Filename too long"))
    .mockResolvedValueOnce({ stdout: "Pruned" } as any);

  const result = await gitWorktreeTool.execute(
    { action: "remove", path: "./tests/temp-worktree-remove", force: true },
    process.cwd()
  );

  expect(result).toContain("Worktree directory removed with filesystem fallback");
  expect(execa).toHaveBeenLastCalledWith("git", ["worktree", "prune"], expect.any(Object));
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
clov npm test -- tests/gitWorktreeTool.test.ts
```

Expected before implementation: FAIL because remove errors return `Git worktree error: ...`.

- [ ] **Step 3: Add forced-remove fallback in `src/core/tools/otherTools.ts`**

Inside the `if (action === "remove")` block, replace the direct `execa` call with:

```ts
try {
  const { stdout } = await execa("git", argsList, { cwd, cancelSignal: signal });
  return stdout || `Worktree at ${absolutePath} removed successfully.`;
} catch (err: any) {
  const message = err instanceof Error ? err.message : String(err);
  if (force && /not a working tree/i.test(message)) {
    const { stdout } = await execa("git", ["worktree", "prune"], { cwd, cancelSignal: signal });
    return stdout || "Worktree metadata pruned after stale remove.";
  }

  if (force && /(filename too long|directory not empty|failed to delete)/i.test(message)) {
    await fs.rm(path.toNamespacedPath(absolutePath), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    await execa("git", ["worktree", "prune"], { cwd, cancelSignal: signal });
    return `Worktree directory removed with filesystem fallback: ${absolutePath}`;
  }

  throw err;
}
```

- [ ] **Step 4: Verify worktree cleanup tests pass**

Run:

```bash
clov npm test -- tests/gitWorktreeTool.test.ts
```

Expected: PASS.

---

## Final Verification

- [ ] Run all tests:

```bash
clov npm test
```

Expected: all Vitest suites pass.

- [ ] Run TypeScript build:

```bash
clov npm run build
```

Expected: `tsc` exits successfully with no TypeScript errors.

- [ ] Manual log verification:

Run Superagent through one multi-agent flow that approves a valid plan but delays task file creation.

Expected:
- `superagent.log` does not receive repeated `[ERROR] Failed to read task checklist file ... ENOENT` entries every 2 seconds.
- Any missing task file blocks `invoke_superagent` with a single actionable error.
- `bash`, `git_worktree`, and `list_peer_superagents` no longer produce `Unknown tool`.
- Missing file reads and invalid grep regexes show `Success: false` in tool logs.
- Non-zero `run_command` exits show `Success: false`.
- Worktree cleanup uses `git_worktree` or succeeds through the forced-remove fallback.

## Self-Review

- Spec coverage: Covers all log-derived categories from the analysis: missing task checklist polling, tool registry drift, success-true error strings, Windows command separator drift, worktree cleanup failures, and planning lifecycle gaps.
- Placeholder scan: No task relies on unspecified behavior; every implementation step names concrete files, code, commands, and expected outcomes.
- Type consistency: `ChecklistTask`, `ReadChecklistResult`, `isErrorLikeToolResult`, and registry test imports match the files introduced or modified in earlier tasks.
