import { describe, expect, it, vi } from "vitest";
import type { Message } from "../src/core/conversation.js";
import { ContextManager } from "../src/core/context/ContextManager.js";
import { SummarizationStrategy } from "../src/core/context/strategies/SummarizationStrategy.js";
import { PinningStrategy } from "../src/core/context/strategies/PinningStrategy.js";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { HistoryCompactor } from "../src/core/agent/HistoryCompactor.js";

const user = (content: string, timestamp: number): Message => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp: number): Message => ({ role: "assistant", content, timestamp });
const summaryCount = (messages: Message[]) => messages.filter((m) => String(m.content).startsWith("[System Conversation Summary]")).length;

describe("compaction reliability regressions", () => {
  it("retains old decisions after two summarization rounds without stacking summaries", async () => {
    const strategy = new SummarizationStrategy();
    const history: Message[] = [
      user("[System Conversation Summary]: Legacy decision: use Bun only; API endpoints must be tenant scoped.", 1),
      ...Array.from({ length: 12 }, (_, i) => assistant("Earlier tool output " + i, i + 2)),
      user("Complete tenant-safe billing migrations", 14),
    ];
    const first = await strategy.execute(history, { preserveRecent: 4, tokenBudget: 2000 });
    expect(summaryCount(first.messages)).toBe(1);
    expect(String(first.messages[0].content)).toContain("use Bun only");
    expect(first.messages.some((m) => m.role === "user" && String(m.content).includes("billing migrations"))).toBe(true);

    const second = await strategy.execute([
      ...first.messages,
      ...Array.from({ length: 10 }, (_, i) => assistant("Another status " + i, 20 + i)),
      user("Continue verification", 40),
    ], { preserveRecent: 4, tokenBudget: 2000 });
    expect(summaryCount(second.messages)).toBe(1);
    expect(String(second.messages[0].content)).toContain("use Bun only");
    expect(second.messages.at(-1)?.content).toBe("Continue verification");
  });

  it("folds previous summaries into pinned compaction and keeps chronological order", async () => {
    const strategy = new PinningStrategy();
    const firstUser = user("Original project scope", 1);
    const old = user("[System Conversation Summary]: Decision: retain invoices for 30 days.", 2);
    const messages: Message[] = [
      firstUser, old, assistant("Old response", 3), user("Handle receipts", 4),
      assistant("Old follow up", 5), user("Newest task: repair checkout", 6),
    ];
    const pinnedId = "user:1:Original project scope";
    const result = await strategy.execute(messages, {
      pinnedMessageIds: new Set([pinnedId]), preserveRecent: 6, tokenBudget: 3000,
    });
    expect(summaryCount(result.messages)).toBe(1);
    expect(String(result.messages[0].content)).toContain("retain invoices for 30 days");
    const timestamps = result.messages.slice(1).map((m) => m.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(result.messages.at(-1)?.content).toBe("Newest task: repair checkout");
  });

  it("prunes byte-heavy results without mutating the original session or inventing a generic goal", async () => {
    const input: Message[] = [
      user("Build a digital checkout", 1), assistant("Inspecting file", 2),
      { role: "tool", content: "", timestamp: 3, toolResults: [
        { toolCallId: "r1", name: "read_file", result: "output:" + "x".repeat(12000) },
      ] },
      user("Finish the checkout validation", 4), assistant("Inspecting logs", 5),
      { role: "tool", content: "", timestamp: 6, toolResults: [
        { toolCallId: "r2", name: "run_command", result: "logs:" + "y".repeat(15000) },
      ] },
    ];
    const original = structuredClone(input);
    const result = await new PruningStrategy().execute(input, {
      preserveRecent: 5, byteBudget: 2600,
    });
    expect(input).toEqual(original);
    expect(String(result.messages[0].content)).toContain("checkout");
    expect(String(result.messages[0].content)).not.toContain("Audit and refine coding assistant prompts");
    expect(result.messages.some((m) => m.role === "user" && String(m.content).includes("Finish the checkout"))).toBe(true);
    expect(result.messages.slice(1)[0]?.role).not.toBe("tool");
  });

  it("does not swallow AbortError and replace history using emergency recovery", async () => {
    const manager = new ContextManager({ model: "test", contextWindowLimit: 1200 });
    const controller = new AbortController();
    const interrupted = new Error("Compaction cancelled");
    interrupted.name = "AbortError";
    const strategy = {
      name: "abort-test",
      canHandle: () => true,
      execute: vi.fn(async () => { controller.abort(); throw interrupted; }),
      estimateCost: () => ({ tokens: 0, time: 0, apiCalls: 0 }),
    };
    const original = [user("Critical task still running", 1), assistant("In progress", 2)];
    await expect(manager.compact(original, strategy, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(original[0].content).toBe("Critical task still running");
    expect(manager.getState()).toBe("IDLE");
  });

  it("does not resolve an LLM or persist anything for below-threshold requests", async () => {
    const manager = new ContextManager({ model: "test", contextWindowLimit: 100000 });
    const getModel = vi.fn(() => { throw new Error("must not resolve model"); });
    const saveHistory = vi.fn();
    const conversation = {
      getContextManager: () => manager,
      getMessages: () => [user("Hello", 1)],
      updateContextManagerLLM: vi.fn(),
      replaceMessages: vi.fn(),
    };
    const agent = { conversation, getModel, saveHistory, writeToLogFile: vi.fn() } as any;
    await HistoryCompactor.contextManagerCompact(agent);
    expect(getModel).not.toHaveBeenCalled();
    expect(saveHistory).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("rotates the automatic active-user pin without losing explicit plans", () => {
    const manager = new ContextManager({ model: "test", contextWindowLimit: 10000 });
    const messages = [
      user("Original goal", 1),
      user("# Tasks", 2),
      user("Continue feature A", 3),
    ];
    manager.autoPinKeyMessages(messages);
    const activeKey = "user:3:Continue feature A";
    expect(manager.getPinnedMessages().has(activeKey)).toBe(true);
    expect(manager.getPinnedMessages().has("user:1:Original goal")).toBe(true);
    manager.autoPinKeyMessages([...messages, user("Fix feature B", 4)]);
    expect(manager.getPinnedMessages().has(activeKey)).toBe(false);
    expect(manager.getPinnedMessages().has("user:4:Fix feature B")).toBe(true);
    expect(manager.getPinnedMessages().has("user:2:# Tasks")).toBe(true);
    manager.dispose();
  });

  it("keeps the latest user instruction across emergency pruning after many tool results", async () => {
    const { Conversation } = await import("../src/core/conversation.js");
    const conversation = new Conversation();
    const messages: Message[] = [user("[System Conversation Summary]: Previous work", 1),
      user("Important current request: fix subscription renewal", 2)];
    for (let i = 0; i < 10; i++) {
      const id = "call-" + i;
      messages.push({
        role: "assistant", content: "Calling tool", timestamp: 10 + i * 2,
        toolCalls: [{ id, name: "run_command", args: { command: "status" } }],
      });
      messages.push({
        role: "tool", content: "", timestamp: 11 + i * 2,
        toolResults: [{ toolCallId: id, name: "run_command", result: "x".repeat(500) }],
      });
    }
    messages.push(assistant("Verification response", 60), assistant("Final status", 61));
    conversation.replaceMessages(messages);
    conversation.pruneToTokenLimit(120);
    const remaining = conversation.getMessages();
    expect(remaining.some((m) => m.role === "user" &&
      String(m.content).includes("subscription renewal"))).toBe(true);
    expect(conversation.getTokenEstimate()).toBeLessThanOrEqual(120);
    expect(remaining.at(-1)?.content).toBe("Final status");
  });

  it("does not start compaction when the request was already cancelled", async () => {
    const manager = new ContextManager({ model: "test", contextWindowLimit: 1200 });
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    await expect(manager.compact([user("Preserve this request", 1)], {
      name: "should-not-run",
      canHandle: () => true,
      execute,
      estimateCost: () => ({ tokens: 0, time: 0, apiCalls: 0 }),
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("recognizes normal, legacy and emergency summary labels without pinning them as user requests", async () => {
    const { isCompactionSummaryText } = await import("../src/core/context/CompactionStrategy.js");
    expect(isCompactionSummaryText("[System Conversation Summary]: decisions")).toBe(true);
    expect(isCompactionSummaryText("[System Conversation Summary of older turns]: note")).toBe(true);
    expect(isCompactionSummaryText("[Emergency Summary - Context Pruned]: note")).toBe(true);
    expect(isCompactionSummaryText("Normal user request")).toBe(false);

    const manager = new ContextManager({ model: "test", contextWindowLimit: 10000 });
    manager.autoPinKeyMessages([
      user("[Emergency Summary - Context Pruned]: old context", 1),
      user("New current request", 2),
    ]);
    expect(manager.getPinnedMessages().has("user:1:[Emergency Summary - Context Pruned]: old context")).toBe(false);
    expect(manager.getPinnedMessages().has("user:2:New current request")).toBe(true);
    manager.dispose();
  });
});
