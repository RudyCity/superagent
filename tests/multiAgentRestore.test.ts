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
import { saveSessionToDb, loadSessionFromDb } from "../src/core/storage/historyDb.js";
import { closeHistoryDb } from "../src/core/config.js";

describe("Multi-Agent Restore & Resume Serialization", () => {
  let tempDir: string;
  let tempFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-test-"));
    tempFilePath = path.join(tempDir, "session.json");
    closeHistoryDb();
    superagentInstances.clear();
    subagentInstances.clear();
  });

  afterEach(async () => {
    closeHistoryDb();
    superagentInstances.clear();
    subagentInstances.clear();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should serialize superagent and subagent instances without their agent property", async () => {
    // Setup active instances
    const saMockAgent = {
      abort: () => {},
      getCurrentHistoryFilePath: () => "/path/to/sa-history.json"
    };
    const subMockAgent = {
      abort: () => {},
      getCurrentHistoryFilePath: () => "/path/to/sub-history.json"
    };

    superagentInstances.set("sa-123", {
      id: "sa-123",
      role: "test-role",
      task: "test-task",
      branch: "feat/123",
      worktreePath: "/path/to/wt",
      status: "running",
      logs: ["logs\n"],
      tokenUsage: { prompt: 10, completion: 10 },
      agent: saMockAgent as any,
      historyFilePath: "/path/to/sa-history.json"
    });

    subagentInstances.set("sub-456", {
      id: "sub-456",
      typeName: "research",
      role: "researcher",
      status: "running",
      logs: ["sublogs\n"],
      agent: subMockAgent as any,
      parentId: "sa-123",
      historyFilePath: "/path/to/sub-history.json"
    });

    // 1. Create a dummy Agent to hold history
    const { Agent } = await import("../src/core/agent.js");
    const { setHistoricalSuperagentTokens } = await import("../src/core/tools/state.js");
    const agent = new Agent();
    agent.planState = "APPROVED";
    (agent as any).currentHistoryFilePath = tempFilePath;
    setHistoricalSuperagentTokens(500);

    // 2. Save
    await agent.saveHistory();

    // 3. Verify SQLite DB contents
    const sid = path.basename(tempFilePath, ".json");
    const dbRes = loadSessionFromDb(sid);
    expect(dbRes.session).toBeDefined();
    expect(dbRes.session.planState).toBe("APPROVED");

    const parsed = JSON.parse(dbRes.session.extraData || "{}");
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
    // 1. Seed SQLite database directly with session containing running subagents/superagents
    const sid = path.basename(tempFilePath, ".json");
    const testData = {
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
      historicalSuperagentTokens: 750,
      lastCapturedTimestamp: Date.now()
    };

    saveSessionToDb(
      {
        id: sid,
        filePath: tempFilePath,
        displayName: "Restore Test",
        messageCount: 1,
        lastModified: Date.now(),
        preview: "Go",
        workingDirectory: "/wt",
        planState: "APPROVED",
        extraData: JSON.stringify(testData),
      },
      [
        { sessionId: sid, role: "user", content: "Go", timestamp: Date.now(), sequenceOrder: 0 }
      ]
    );

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
    expect(saRunning.status).toBe("paused"); // running converted to paused
    expect(saRunning.result).toBe("[Paused by session exit]");
    expect(saRunning.logs[saRunning.logs.length - 1]).toContain("Resumed session, marked as paused");
    expect(saRunning.agent).toBeDefined();
    expect(typeof saRunning.agent.abort).toBe("function");
    expect(saRunning.agent.abort()).toBeUndefined(); // Should not throw

    const saDone = superagentInstances.get("sa-done")!;
    expect(saDone.status).toBe("completed"); // preserved
  });
});
