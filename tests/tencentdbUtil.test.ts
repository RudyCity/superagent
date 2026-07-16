import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTencentdbActive } from "../src/core/tencentdbUtil.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";



describe("tencentdbUtil - isTencentdbActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should always return false", async () => {
    updateSettings({ enableTencentdbMemory: false });
    expect(await isTencentdbActive(true)).toBe(false);

    updateSettings({ enableTencentdbMemory: true });
    expect(await isTencentdbActive(true)).toBe(false);
  });
});
