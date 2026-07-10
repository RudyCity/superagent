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

  it("should return false if enableTencentdbMemory is false", async () => {
    updateSettings({ enableTencentdbMemory: false });
    const active = await isTencentdbActive(true);
    expect(active).toBe(false);
    expect(mockListScenarios).not.toHaveBeenCalled();
  });

  it("should return true if enableTencentdbMemory is true and gateway is reachable", async () => {
    updateSettings({ enableTencentdbMemory: true });
    mockListScenarios.mockResolvedValue({ items: [] });
    const active = await isTencentdbActive(true);
    expect(active).toBe(true);
    expect(mockListScenarios).toHaveBeenCalledTimes(1);
  });

  it("should return false if enableTencentdbMemory is true and gateway pings fail", async () => {
    updateSettings({ enableTencentdbMemory: true });
    mockListScenarios.mockRejectedValue(new Error("Connection refused"));
    const active = await isTencentdbActive(true);
    expect(active).toBe(false);
    expect(mockListScenarios).toHaveBeenCalledTimes(1);
  });

  it("should return cached value within the TTL period", async () => {
    updateSettings({ enableTencentdbMemory: true });
    mockListScenarios.mockResolvedValue({ items: [] });
    
    // First call - should ping
    const active1 = await isTencentdbActive(true);
    expect(active1).toBe(true);
    
    // Second call without forceRefresh - should use cache
    const active2 = await isTencentdbActive(false);
    expect(active2).toBe(true);
    expect(mockListScenarios).toHaveBeenCalledTimes(1); // Still only 1 call
    
    // Third call with forceRefresh - should ping again
    const active3 = await isTencentdbActive(true);
    expect(active3).toBe(true);
    expect(mockListScenarios).toHaveBeenCalledTimes(2);
  });
});
