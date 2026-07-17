import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";

// Mock the rmemoryUtil module
const mockClient = {
  readCore: vi.fn(),
  queryAtomic: vi.fn(),
  searchAtomic: vi.fn(),
  updateAtomic: vi.fn(),
  deleteAtomic: vi.fn(),
  listScenarios: vi.fn(),
  readScenario: vi.fn(),
};

vi.mock("../src/core/rmemoryUtil.js", () => ({
  getRMemoryClient: () => mockClient,
  getRMemorySessionKey: () => "test-sess",
  isRmemoryActive: vi.fn().mockImplementation(async () => {
    const { getSettings } = await import("../src/core/config.js");
    return !!getSettings().enableRmemory;
  }),
}));

describe("/memory Command Suite", () => {
  let addedLines: ChatLine[] = [];

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: {
      getCurrentHistoryFilePath: () => "history.json",
      getHistory: () => ({ lastCapturedTimestamp: 1700000000000 }),
    },
  };

  beforeEach(() => {
    addedLines = [];
    vi.clearAllMocks();
    // Enable memory in settings for testing
    updateSettings({ enableRmemory: true });
  });

  it("should print help menu when run without subcommands", async () => {
    await handleSlashCommand("/memory", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("Usage: /memory <subcommand>"))).toBe(true);
  });

  it("should check status and print configuration details", async () => {
    mockClient.readCore.mockResolvedValue({ content: "test persona" });
    await handleSlashCommand("/memory status", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("RMemory Memory Status: Active"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Session ID: test-sess"))).toBe(true);
  });

  it("should search memories", async () => {
    mockClient.searchAtomic.mockResolvedValue({
      items: [
        { id: "mem1", content: "likes typescript", type: "preference", score: 0.95 },
      ],
    });

    await handleSlashCommand("/memory search typescript", mockCtx as any);

    expect(mockClient.searchAtomic).toHaveBeenCalledWith({ query: "typescript", limit: 5 });
    expect(addedLines.some((l) => l.content.includes("Search Results for: \"typescript\""))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Score: 0.9500"))).toBe(true);
  });

  it("should add a memory", async () => {
    mockClient.updateAtomic.mockResolvedValue({
      id: "user-name",
      updated_at: "2026-06-26T15:00:00.000Z",
    });

    await handleSlashCommand('/memory add user-name "John Doe" preference', mockCtx as any);

    expect(mockClient.updateAtomic).toHaveBeenCalledWith({
      id: "user-name",
      content: "John Doe",
    });
    expect(addedLines.some((l) => l.content.includes("Memory saved successfully"))).toBe(true);
  });

  it("should delete a memory", async () => {
    mockClient.deleteAtomic.mockResolvedValue({});

    await handleSlashCommand("/memory delete user-name", mockCtx as any);

    expect(mockClient.deleteAtomic).toHaveBeenCalledWith({ ids: ["user-name"] });
    expect(addedLines.some((l) => l.content.includes('Memory "user-name" deleted successfully'))).toBe(true);
  });

  it("should list scenarios", async () => {
    mockClient.listScenarios.mockResolvedValue({
      entries: [{ path: "scene_blocks/coding-style.md" }]
    });

    await handleSlashCommand("/memory list-scenes", mockCtx as any);
    expect(mockClient.listScenarios).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("scene_blocks/coding-style.md"))).toBe(true);
  });

  it("should read scenario content", async () => {
    mockClient.readScenario.mockResolvedValue({
      path: "scene_blocks/coding-style.md",
      content: "coding rules content"
    });

    await handleSlashCommand("/memory read-scene scene_blocks/coding-style.md", mockCtx as any);
    expect(mockClient.readScenario).toHaveBeenCalledWith({ path: "scene_blocks/coding-style.md" });
    expect(addedLines.some((l) => l.content.includes("coding rules content"))).toBe(true);
  });

  it("should read user persona", async () => {
    mockClient.readCore.mockResolvedValue({
      content: "persona content details"
    });

    await handleSlashCommand("/memory read-persona", mockCtx as any);
    expect(mockClient.readCore).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("persona content details"))).toBe(true);
  });
});
