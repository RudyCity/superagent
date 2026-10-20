import { afterEach, describe, expect, it, vi } from "vitest";

const execution = vi.hoisted(() => ({
  report: "### SUBAGENT TASK REPORT\n- Status: Blocked\n- Verification: false",
}));
vi.mock("../src/core/tools/toolsets.js", () => ({
  subagentToolsets: { researcher: {} },
  defaultSubagentToolset: {},
  resolveBaseTypeFromTypeName: () => "researcher",
  resolveSubagentToolset: () => [],
}));
vi.mock("../src/core/prompts.js", () => ({
  SUBAGENT_SYSTEM_PROMPTS: { researcher: "Collect project evidence." },
  getSubagentSystemPrompt: async () => "Collect project evidence.",
}));
vi.mock("../src/core/agent/promptOptimizer.js", () => ({
  PromptOptimizer: { loadOptimizedGuidelines: () => "", optimize: async () => undefined },
}));
vi.mock("../src/core/agent.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/core/agent.js")>();
  return {
    ...actual,
    Agent: class {
      abortController = { abort: vi.fn() };
      getCurrentHistoryFilePath() { return undefined; }
      getHistory() { return { getMessages: () => [{ role: "assistant", content: execution.report }] }; }
      writeToLogFile() { }
      sendMessage() { return Promise.resolve(); }
    },
  };
});

import { invokeSubagentTool } from "../src/core/tools/subagentTools.js";
import { subagentInstances, subagentTypes } from "../src/core/tools/state.js";
import { agentLocalStorage } from "../src/core/agent.js";

afterEach(() => {
  subagentInstances.clear();
  subagentTypes.delete("hermes-outcome-probe");
  vi.restoreAllMocks();
});

describe("Phase 4: subagent completion never overrides a declared blocked/partial report", () => {
  it.each([true, false])("preserves blocked report as error for wait=%s", async (wait) => {
    execution.report = "### SUBAGENT TASK REPORT\n- Status: Blocked\n- Verification: false";
    const output = await invokeSubagentTool.execute({
      typeName: "hermes-outcome-probe", role: "Check blockers", prompt: "Assess the problem",
      wait,
    }, process.cwd());
    expect(String(output).toLowerCase()).toContain("subagent");
    await vi.waitFor(() => {
      expect(subagentInstances.size).toBe(1);
      expect([...subagentInstances.values()][0].agent).toBeUndefined();
    });
    const instance = [...subagentInstances.values()][0];
    expect(instance.status).toBe("error");
    expect(instance.reportOutcome).toBe("blocked");
    expect(instance.result).toContain("Status: Blocked");
  });

  it("marks explicit partial completion as error rather than successful verification", async () => {
    execution.report = "### SUBAGENT TASK REPORT\n- Status: Partial\n- Verification: false";
    await invokeSubagentTool.execute({
      typeName: "hermes-outcome-probe", role: "Partial investigation", prompt: "Investigate", wait: true,
    }, process.cwd());
    const instance = [...subagentInstances.values()][0];
    expect(instance.status).toBe("error");
    expect(instance.reportOutcome).toBe("partial");
  });

  it.each([
    ["- Status: Blocked", "SUBAGENT_BLOCKED"],
    ["No terminal outcome declared", "SUBAGENT_UNVERIFIED"],
  ])("notifies parent truthfully for %s", async (report, marker) => {
    execution.report = "### SUBAGENT TASK REPORT\n" + report;
    const parentMessages: string[] = [];
    const parentAgent = {
      delegationDepth: 0, isMultiAgent: false,
      getHistory: () => ({ addMessage: (message: { content: string }) => {
        parentMessages.push(message.content);
      } }),
    };
    await agentLocalStorage.run(parentAgent as any, () => invokeSubagentTool.execute({
      typeName: "hermes-outcome-probe", role: "Outcome reporter",
      prompt: "Report outcome", wait: false,
    }, process.cwd()));
    await vi.waitFor(() => expect(parentMessages).toHaveLength(1));
    expect(parentMessages[0]).toContain("[" + marker + "]");
    expect(parentMessages[0]).not.toContain("finished successfully");
  });

  it("retains unverified completion as distinct from explicit verified completion", async () => {
    execution.report = "Working on a task, but no terminal evidence was declared.";
    const output = await invokeSubagentTool.execute({
      typeName: "hermes-outcome-probe", role: "Unverified report", prompt: "Summarize", wait: true,
    }, process.cwd());
    const instance = [...subagentInstances.values()][0];
    expect(instance.status).toBe("completed");
    expect(instance.reportOutcome).toBe("unverified");
    expect(String(output)).toContain("unverified");
  });
});
