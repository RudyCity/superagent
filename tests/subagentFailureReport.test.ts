import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageTool, manageSubagentsTool, invokeSubagentTool } from "../src/core/tools/subagentTools.js";
import { subagentInstances, subagentTypes } from "../src/core/tools/state.js";
import type { SubagentInstance } from "../src/core/tools/types.js";

const invocation = vi.hoisted(() => ({ pending: false }));
vi.mock("../src/core/tools/toolsets.js", () => ({
  subagentToolsets: { researcher: {} }, defaultSubagentToolset: {},
  resolveBaseTypeFromTypeName: () => "researcher", resolveSubagentToolset: () => [],
}));
vi.mock("../src/core/prompts.js", () => ({
  SUBAGENT_SYSTEM_PROMPTS: { researcher: "Collect findings" },
  getSubagentSystemPrompt: async () => "Collect findings",
}));
vi.mock("../src/core/agent/promptOptimizer.js", () => ({
  PromptOptimizer: { loadOptimizedGuidelines: () => "", optimize: async () => undefined },
}));
vi.mock("../src/core/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/agent.js")>();
  return {
    ...actual,
    Agent: class {
      abortController = { abort: vi.fn() };
      getCurrentHistoryFilePath() { return undefined; }
      getHistory() { return { getMessages: () => [{ role: "assistant", content: partialReport }] }; }
      writeToLogFile() {}
      sendMessage() {
        return invocation.pending ? new Promise<void>(() => {}) : Promise.reject(new Error("Provider interrupted"));
      }
    },
  };
});

const partialReport = "### SUBAGENT TASK REPORT\nPartial findings collected before the provider failed.";

afterEach(() => {
  subagentInstances.clear();
  subagentTypes.delete("failure-regression");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Failed subagent follow-up reports", () => {
  it.each([true, false])("preserves partial history on rejection (wait=%s)", async (wait) => {
    const agent = {
      sendMessage: vi.fn().mockRejectedValue(new Error("Provider interrupted")),
      getHistory: () => ({ getMessages: () => [{ role: "assistant", content: partialReport }] }),
      writeToLogFile: vi.fn(),
    };
    const instance = {
      id: "failed-follow-up", typeName: "researcher", role: "Report regression",
      prompt: "Collect findings", status: "idle", logs: [], agent,
    } as unknown as SubagentInstance;
    subagentInstances.set(instance.id, instance);
    await sendMessageTool.execute({ recipientId: instance.id, message: "Continue", wait }, process.cwd());
    await vi.waitFor(() => expect(instance.agent).toBeUndefined());
    expect(instance.status).toBe("error");
    expect(instance.result).toBe(partialReport);
    const report = await manageSubagentsTool.execute(
      { action: "report", conversationIds: [instance.id] }, process.cwd(),
    );
    expect(report).toContain(partialReport);
  });
});


describe("Failed subagent invocation reports", () => {
  it.each([
    { wait: true, timeout: false }, { wait: false, timeout: false },
    { wait: true, timeout: true }, { wait: false, timeout: true },
  ])("preserves partial history (wait=$wait, timeout=$timeout)", async ({ wait, timeout }) => {
    invocation.pending = timeout;
    if (timeout) vi.useFakeTimers();
    const result = invokeSubagentTool.execute({
      typeName: "failure-regression", role: "Report regression", prompt: "Collect findings",
      wait, ...(timeout ? { timeoutMs: 30000 } : {}),
    }, process.cwd());
    await vi.waitFor(() => expect(subagentInstances.size).toBe(1));
    const instance = [...subagentInstances.values()][0];
    if (timeout) await vi.advanceTimersByTimeAsync(30000);
    await result;
    await vi.waitFor(() => expect(instance.agent).toBeUndefined());
    expect(instance.status).toBe("error");
    expect(instance.result).toBe(partialReport);
    const report = await manageSubagentsTool.execute(
      { action: "report", conversationIds: [instance.id] }, process.cwd(),
    );
    expect(report).toContain(partialReport);
  });
});
