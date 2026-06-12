import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Conversation } from "../src/core/conversation.js";
import { 
  superagentInstances, 
  subagentInstances,
  subscribeToSuperagents,
  subscribeToSubagents,
  historicalSuperagentTokens,
  addHistoricalSuperagentTokens
} from "../src/core/tools/state.js";

describe("Multi-Agent Restore & Resume Serialization", () => {
  let tempDir: string;
  let tempFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-test-"));
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

  it("should serialize superagent and subagent instances without their agent property", async () => {
    // 1. Setup mock instances
    const mockSuperagent = {
      id: "sa-123",
      role: "test-role",
      task: "test-task",
      branch: "test-branch",
      worktreePath: "/path/to/worktree",
      status: "running" as const,
      logs: ["[START] Starting task\n"],
      tokenUsage: { prompt: 10, completion: 20 },
      historyFilePath: "/path/to/sa-history.json",
      agent: { abort: () => {}, someOtherProp: true }
    };

    const mockSubagent = {
      id: "sub-456",
      typeName: "coder",
      role: "sub-role",
      status: "running" as const,
      logs: ["[START] Subtask starting\n"],
      parentId: "sa-123",
      historyFilePath: "/path/to/sub-history.json",
      agent: { abort: () => {} }
    };

    superagentInstances.set(mockSuperagent.id, mockSuperagent);
    subagentInstances.set(mockSubagent.id, mockSubagent);
    addHistoricalSuperagentTokens(500);

    // 2. Save using Conversation
    const conversation = new Conversation();
    conversation.addUserMessage("Hello world");
    await conversation.saveToFile(tempFilePath, "APPROVED");

    // 3. Verify file contents
    const fileContent = await fs.readFile(tempFilePath, "utf-8");
    const parsed = JSON.parse(fileContent);

    expect(parsed.planState).toBe("APPROVED");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.historicalSuperagentTokens).toBe(500);
    
    // Verify superagents list
    expect(parsed.superagents).toHaveLength(1);
    expect(parsed.superagents[0].id).toBe("sa-123");
    expect(parsed.superagents[0].role).toBe("test-role");
    expect(parsed.superagents[0].agent).toBeUndefined(); // Crucial: agent property must not be serialized
    expect(parsed.superagents[0].historyFilePath).toBe("/path/to/sa-history.json");

    // Verify subagents list
    expect(parsed.subagents).toHaveLength(1);
    expect(parsed.subagents[0].id).toBe("sub-456");
    expect(parsed.subagents[0].parentId).toBe("sa-123");
    expect(parsed.subagents[0].agent).toBeUndefined(); // Crucial
  });

  it("should deserialize and restore instances, mapping running ones to interrupted error/completed status", async () => {
    // 1. Prepare JSON file with running subagents/superagents
    const testData = {
      planState: "APPROVED",
      messages: [
        { role: "user", content: "Go", timestamp: Date.now() }
      ],
      superagents: [
        {
          id: "sa-running",
          role: "coder",
          task: "code feature",
          branch: "feat",
          worktreePath: "/wt",
          status: "running",
          logs: ["running logs\n"],
          tokenUsage: { prompt: 5, completion: 5 },
          historyFilePath: "/wt-history.json"
        },
        {
          id: "sa-done",
          role: "reviewer",
          task: "review feature",
          branch: "review",
          worktreePath: "/wt-rev",
          status: "completed",
          result: "All good",
          logs: ["review finished\n"],
          tokenUsage: { prompt: 2, completion: 2 },
          historyFilePath: "/wt-rev-history.json"
        }
      ],
      subagents: [
        {
          id: "sub-running",
          typeName: "grep",
          role: "searcher",
          status: "running",
          logs: ["searching\n"],
          parentId: "sa-running",
          historyFilePath: "/sub-history.json"
        }
      ],
      historicalSuperagentTokens: 750
    };

    await fs.writeFile(tempFilePath, JSON.stringify(testData, null, 2), "utf-8");

    // Listeners for changes
    let superagentNotified = false;
    let subagentNotified = false;
    const unsubSuper = subscribeToSuperagents(() => { superagentNotified = true; });
    const unsubSub = subscribeToSubagents(() => { subagentNotified = true; });

    // 2. Load conversation
    const conversation = new Conversation();
    await conversation.loadFromFile(tempFilePath);

    unsubSuper();
    unsubSub();

    // 3. Verify notifications were fired
    expect(superagentNotified).toBe(true);
    expect(subagentNotified).toBe(true);
    expect(historicalSuperagentTokens).toBe(750);

    // 4. Verify superagents map
    expect(superagentInstances.size).toBe(2);
    
    const saRunning = superagentInstances.get("sa-running")!;
    expect(saRunning.status).toBe("error"); // running converted to error
    expect(saRunning.result).toBe("[Interrupted by session exit]");
    expect(saRunning.logs[saRunning.logs.length - 1]).toContain("Resumed session, marked as interrupted");
    expect(saRunning.agent).toBeDefined();
    expect(typeof saRunning.agent.abort).toBe("function");
    expect(saRunning.agent.abort()).toBeUndefined(); // Should not throw

    const saDone = superagentInstances.get("sa-done")!;
    expect(saDone.status).toBe("completed"); // preserved
    expect(saDone.result).toBe("All good");

    // 5. Verify subagents map
    expect(subagentInstances.size).toBe(1);
    
    const subRunning = subagentInstances.get("sub-running")!;
    expect(subRunning.status).toBe("completed"); // running converted to completed
    expect(subRunning.result).toBe("[Interrupted by session exit]");
    expect(subRunning.agent).toBeDefined();
    expect(typeof subRunning.agent.abort).toBe("function");
    expect(subRunning.agent.abort()).toBeUndefined();
  });
});
