import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  probeToolCallSupport,
  clearToolCallSupportCache
} from "../src/utils/promptBasedToolCalling.js";

describe("promptBasedToolCalling disk caching", () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    // Setup a clean temporary directory for the test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-test-config-"));
    originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = tempDir;
    clearToolCallSupportCache();
  });

  afterEach(() => {
    // Cleanup temporary directory and restore env
    if (originalConfigDir !== undefined) {
      process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.SUPERAGENT_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearToolCallSupportCache();
  });

  it("should write probe results to disk cache and read from it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{ id: "test", type: "function", function: { name: "probe_tool" } }]
            }
          }
        ]
      })
    });
    vi.stubGlobal("fetch", mockFetch);

    const cacheFile = path.join(tempDir, "tool_support_cache.json");
    expect(fs.existsSync(cacheFile)).toBe(false);

    // First call: runs fetch
    const result1 = await probeToolCallSupport("http://localhost:9999", "apikey", "model");
    expect(result1).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify cache file was written to disk
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    expect(cachedData["http://localhost:9999::model"]).toBe(true);

    // Clear memory cache but keep disk cache
    clearToolCallSupportCache();
    expect(fs.existsSync(cacheFile)).toBe(false);

    vi.unstubAllGlobals();
  });

  it("should load disk cache if it exists on startup", async () => {
    // Pre-populate disk cache file
    const cacheFile = path.join(tempDir, "tool_support_cache.json");
    const testData = {
      "http://localhost:8888::special-model": true,
      "http://localhost:8888::bad-model": false
    };
    fs.writeFileSync(cacheFile, JSON.stringify(testData), "utf-8");

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // Calling probeToolCallSupport for cached items should return cached values WITHOUT calling fetch
    const result1 = await probeToolCallSupport("http://localhost:8888", "apikey", "special-model");
    expect(result1).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    const result2 = await probeToolCallSupport("http://localhost:8888", "apikey", "bad-model");
    expect(result2).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
