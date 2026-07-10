import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";

// Mock the tencentdbUtil module
const mockClient = {
  readCore: vi.fn(),
  queryAtomic: vi.fn(),
  searchAtomic: vi.fn(),
  updateAtomic: vi.fn(),
  deleteAtomic: vi.fn(),
};

vi.mock("../src/core/tencentdbUtil.js", () => ({
  getTencentDBClient: () => mockClient,
  getTencentDBSessionKey: () => "test-sess",
  isTencentdbActive: vi.fn().mockImplementation(async () => {
    const { getSettings } = await import("../src/core/config.js");
    return !!getSettings().enableTencentdbMemory;
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
    updateSettings({ enableTencentdbMemory: true });
  });

  it("should show help menu by default or on help", async () => {
    await handleSlashCommand("/memory", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("Usage: /memory <subcommand>"))).toBe(true);

    addedLines = [];
    await handleSlashCommand("/memory help", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("Usage: /memory <subcommand>"))).toBe(true);
  });

  it("should show status connected when gateway is online", async () => {
    mockClient.readCore.mockResolvedValue({ content: "test persona" });
    await handleSlashCommand("/memory status", mockCtx as any);

    expect(mockClient.readCore).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("TencentDB Memory Status: Connected"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Active Session Key: test-sess"))).toBe(true);
  });

  it("should show offline status when gateway is unreachable", async () => {
    mockClient.readCore.mockRejectedValue(new Error("Connection refused"));
    await handleSlashCommand("/memory status", mockCtx as any);

    expect(addedLines.some((l) => l.content.includes("TencentDB Memory Status: Offline / Connection Failed"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Connection refused"))).toBe(true);
  });

  it("should list memories", async () => {
    mockClient.queryAtomic.mockResolvedValue({
      items: [
        { id: "mem1", content: "likes typescript", type: "preference" },
        { id: "mem2", content: "uses windows", type: "fact" },
      ],
    });

    await handleSlashCommand("/memory list", mockCtx as any);

    expect(mockClient.queryAtomic).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("likes typescript"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("- ID: mem1 [preference]"))).toBe(true);
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
});
