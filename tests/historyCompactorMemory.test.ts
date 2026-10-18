import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryHarness = vi.hoisted(() => ({
  isActive: vi.fn(),
  getClient: vi.fn(),
  getProjectId: vi.fn(),
  getSessionKey: vi.fn(),
}));

vi.mock("../src/core/rmemoryUtil.js", () => ({
  isRmemoryActive: memoryHarness.isActive,
  getRMemoryClient: memoryHarness.getClient,
  getRMemoryProjectId: memoryHarness.getProjectId,
  getRMemorySessionKey: memoryHarness.getSessionKey,
}));

import { HistoryCompactor } from "../src/core/agent/HistoryCompactor.js";

function makeAgent(workingDirectory = "C:/repos/project-a") {
  const messages: any[] = [{ role: "user", content: "What patterns should I follow for this task?", timestamp: Date.now() }];
  return {
    workingDirectory,
    worktreePath: null,
    conversation: {
      getMessages: () => messages,
      replaceMessages: (next: any[]) => { messages.splice(0, messages.length, ...next); },
    },
    getCurrentHistoryFilePath: () => "session-test.json",
    writeToLogFile: vi.fn(),
    _messages: messages,
  } as any;
}

describe("RMemory automatic context recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryHarness.isActive.mockResolvedValue(true);
    memoryHarness.getProjectId.mockReturnValue("p_project_a");
    memoryHarness.getSessionKey.mockReturnValue("session-key");
    memoryHarness.getClient.mockReturnValue({
      searchAtomic: vi.fn().mockResolvedValue({ items: [
        { id: "a", content: "[project:p_project_a] Project A conventions", type: "decision", metadata: {
          schemaVersion: 1, scope: "project", projectId: "p_project_a", validationStatus: "unverified",
          updatedAt: "2026-10-18T08:00:00.000Z", provenance: { source: "rmemory_save" },
        } },
        { id: "b", content: "[project:p_project_b] Project B secret", type: "decision", metadata: { scope: "project", projectId: "p_project_b" } },
        { id: "global", content: "[global] User prefers concise output", type: "preference", metadata: { scope: "global" } },
        { id: "ambiguous", content: "[project] Legacy project-only note", type: "memory", metadata: {} },
      ] }),
      readCore: vi.fn().mockResolvedValue({ content: "persona" }),
      listScenarios: vi.fn().mockResolvedValue({ entries: [] }),
    });
  });

  it("scopes automatic recall to the canonical project while keeping explicit global preferences", async () => {
    const agent = makeAgent();
    await HistoryCompactor.prepopulateRmemoryContext(agent);

    const client = memoryHarness.getClient.mock.results[0].value;
    expect(memoryHarness.getProjectId).toHaveBeenCalledWith(agent.workingDirectory);
    expect(client.searchAtomic).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(String), limit: 5, projectId: "p_project_a" }));

    const injected = String(agent._messages[0].content);
    expect(injected).toContain("Project A conventions");
    expect(injected).toContain("scope=project");
    expect(injected).toContain("validation=unverified");
    expect(injected).toContain("source=rmemory_save");
    expect(injected).toContain("User prefers concise output");
    expect(injected).not.toContain("Project B secret");
    expect(injected).not.toContain("Legacy project-only note");
    expect(injected).toContain("untrusted reference data");
  });

  it("bounds persona, scenario-list and memory payloads before injecting context", async () => {
    const client = memoryHarness.getClient();
    const longText = "x".repeat(10000);
    client?.searchAtomic.mockResolvedValue({ items: [
      { id: "a", content: longText, type: "memory", metadata: { scope: "project", projectId: "p_project_a" } },
    ] });
    client?.readCore.mockResolvedValue({ content: longText });
    client?.listScenarios.mockResolvedValue({ entries: Array.from({ length: 30 }, (_, i) => ({ path: `scene_blocks/${i}.md` })) });

    const agent = makeAgent();
    await HistoryCompactor.prepopulateRmemoryContext(agent);
    const injected = String(agent._messages[0].content);

    expect(injected).toContain("… and 10 more scenario files");
    expect(injected).toContain("[truncated]");
    expect(injected.length).toBeLessThan(9000);
  });
});
