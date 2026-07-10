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

  it("should always return disabled error message", async () => {
    await handleSlashCommand("/memory", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("TencentDB Memory is disabled in this build."))).toBe(true);

    addedLines = [];
    await handleSlashCommand("/memory status", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("TencentDB Memory is disabled in this build."))).toBe(true);

    addedLines = [];
    await handleSlashCommand("/memory list", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("TencentDB Memory is disabled in this build."))).toBe(true);
  });
});
