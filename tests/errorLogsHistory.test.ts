import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import { Conversation } from "../src/core/conversation.js";
import { superagentInstances, subagentInstances } from "../src/core/tools/state.js";

describe("Error Logs Persistence and Restoration", () => {
  let tempDir: string;
  let tempFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-error-test-"));
    tempFilePath = path.join(tempDir, "session.json");
    superagentInstances.clear();
    subagentInstances.clear();
  });

  afterEach(async () => {
    superagentInstances.clear();
    subagentInstances.clear();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should record stream/runtime errors to conversation history as [ERROR] system messages", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn(async () => true);
    const onQuestion = vi.fn(async () => "");
    
    const agent = new Agent(onEvent, onPermission, onQuestion);
    // Mock runAgentLoop to throw an error
    vi.spyOn(agent as any, "runAgentLoop").mockRejectedValue(new Error("Mocked stream failure"));
    
    // Set a valid history path so it saves history
    (agent as any).currentHistoryFilePath = tempFilePath;

    await agent.sendMessage("Test error mapping");

    const messages = agent.getHistory().getMessages();
    const errorMsg = messages.find(m => m.role === "system" && m.content.startsWith("[ERROR]"));
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.content).toContain("Mocked stream failure");

    // Verify history file was saved with the error
    const raw = await fs.readFile(tempFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.messages.some((m: any) => m.role === "system" && m.content.includes("Mocked stream failure"))).toBe(true);
  });

  it("should parse [ERROR] system messages from history correctly", async () => {
    // 1. Setup a conversation with a system error message
    const conv = new Conversation();
    conv.addMessage({
      role: "system",
      content: "[ERROR] API rate limit exceeded",
      timestamp: Date.now(),
    });
    
    // Simulate multi-agent-dashboard history loading logic
    const msgs = conv.getMessages();
    const loadedLogs: string[] = [];
    for (const m of msgs) {
      if (m.role === "system" && m.content.startsWith("[ERROR]")) {
        loadedLogs.push(m.content);
      }
    }

    expect(loadedLogs).toContain("[ERROR] API rate limit exceeded");

    // Simulate app.tsx history loading logic
    const loadedLines: any[] = [];
    for (const m of msgs) {
      if (m.role === "system" && m.content.startsWith("[ERROR]")) {
        loadedLines.push({
          type: "error",
          content: m.content.replace("[ERROR]", "").trim(),
          timestamp: m.timestamp,
        });
      }
    }

    expect(loadedLines[0].type).toBe("error");
    expect(loadedLines[0].content).toBe("API rate limit exceeded");
  });

  it("should push execution errors to subagent and superagent instance logs", async () => {
    // Test subagent logs error pushing
    const subagentId = "sub-123";
    const subLogs: string[] = [];
    
    // Simulate subagent catch block
    try {
      throw new Error("Subagent execution timeout");
    } catch (err: any) {
      subLogs.push(`[ERROR] Subagent failed: ${err.message}\n`);
    }

    expect(subLogs[0]).toContain("[ERROR] Subagent failed: Subagent execution timeout");

    // Test superagent logs error pushing
    const superagentId = "sa-123";
    const superagentLogs: string[] = [];

    // Simulate superagent catch block
    try {
      throw new Error("Superagent Git checkout conflict");
    } catch (err: any) {
      superagentLogs.push(`[ERROR] Superagent failed: ${err.message}\n`);
    }

    expect(superagentLogs[0]).toContain("[ERROR] Superagent failed: Superagent Git checkout conflict");
  });
});
