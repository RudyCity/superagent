import { describe, it, expect } from "vitest";
import { getSystemCheckCache, updateSystemCheckCache, clearSystemCheckCache } from "../src/core/config/systemCache.js";
import { isRmemoryInstalled } from "../src/core/androidSetup.js";
import { checkLocalModelDownloadStatus } from "../src/core/rmemoryUtil.js";

describe("Startup Optimization & System Cache", () => {
  it("should update and read system check cache", () => {
    updateSystemCheckCache({ rg: true, uv: true, python: true });
    const cache = getSystemCheckCache();
    expect(cache).toBeDefined();
    expect(cache?.rg).toBe(true);
    expect(cache?.uv).toBe(true);
    expect(cache?.python).toBe(true);
  });

  it("should verify isRmemoryInstalled executes rapidly (< 100ms)", async () => {
    const start = Date.now();
    const installed = await isRmemoryInstalled();
    const duration = Date.now() - start;
    expect(typeof installed).toBe("boolean");
    expect(duration).toBeLessThan(100);
  });

  it("should check local model download status synchronously without ONNX execution", () => {
    const status = checkLocalModelDownloadStatus("Sharjeelbaig/Supra-Router-51M-ONNX");
    expect(typeof status).toBe("string");
    expect(status.length).toBeGreaterThan(0);
  });

  it("should persist cache across reads", () => {
    const before = getSystemCheckCache();
    expect(before).toBeDefined();
    updateSystemCheckCache({ officeCli: true });
    const after = getSystemCheckCache();
    expect(after?.officeCli).toBe(true);
  });
});
