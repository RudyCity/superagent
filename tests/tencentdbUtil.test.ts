import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTencentdbActive } from "../src/core/tencentdbUtil.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";

const mockListScenarios = vi.fn();

vi.mock("@tencentdb-agent-memory/memory-sdk-ts", () => {
  class MockMemoryClient {
    listScenarios = mockListScenarios;
  }
  return {
    MemoryClient: MockMemoryClient,
  };
});

describe("tencentdbUtil - isTencentdbActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should always return false", async () => {
    updateSettings({ enableTencentdbMemory: false });
    expect(await isTencentdbActive(true)).toBe(false);

    updateSettings({ enableTencentdbMemory: true });
    expect(await isTencentdbActive(true)).toBe(false);
    expect(mockListScenarios).not.toHaveBeenCalled();
  });
});
