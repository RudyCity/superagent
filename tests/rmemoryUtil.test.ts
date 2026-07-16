import { describe, it, expect, vi, beforeEach } from "vitest";
import { isRmemoryActive } from "../src/core/rmemoryUtil.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";

describe("rmemoryUtil - isRmemoryActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return the settings value", async () => {
    updateSettings({ enableRmemory: false });
    expect(await isRmemoryActive(true)).toBe(false);

    updateSettings({ enableRmemory: true });
    expect(await isRmemoryActive(true)).toBe(true);
  });
});
