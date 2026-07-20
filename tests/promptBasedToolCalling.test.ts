import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  probeToolCallSupport,
  clearToolCallSupportCache
} from "../src/utils/promptBasedToolCalling.js";
import { closeHistoryDb } from "../src/core/config.js";
import { getHistoryDb, getToolSupportCacheFromDb, saveToolSupportCacheToDb } from "../src/core/storage/historyDb.js";

const PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

describe("promptBasedToolCalling disk caching", () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    // Setup a clean temporary directory for the test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-test-config-"));
    originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = tempDir;
    closeHistoryDb();
    clearToolCallSupportCache();
  });

  afterEach(() => {
    // Close the SQLite database connection to release file locks on Windows
    closeHistoryDb();

    // Cleanup temporary directory and restore env
    if (originalConfigDir !== undefined) {
      process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.SUPERAGENT_CONFIG_DIR;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    clearToolCallSupportCache();
  });

  it("should write probe results to SQLite DB cache and read from it", async () => {
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

    // Verify initially it's not in SQLite DB
    expect(getToolSupportCacheFromDb("http://localhost:9999::model", PROBE_CACHE_TTL_MS)).toBeNull();

    // First call: runs fetch
    const result1 = await probeToolCallSupport("http://localhost:9999", "apikey", "model");
    expect(result1).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify it is now saved to the SQLite DB
    expect(getToolSupportCacheFromDb("http://localhost:9999::model", PROBE_CACHE_TTL_MS)).toBe(true);

    vi.unstubAllGlobals();
  });

  it("should load disk cache if it exists on startup (fresh entries)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // Pre-populate SQLite database directly
    saveToolSupportCacheToDb("http://localhost:8888::special-model", true);
    saveToolSupportCacheToDb("http://localhost:8888::bad-model", false);

    // Fresh cached items should return without calling fetch
    const result1 = await probeToolCallSupport("http://localhost:8888", "apikey", "special-model");
    expect(result1).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    const result2 = await probeToolCallSupport("http://localhost:8888", "apikey", "bad-model");
    expect(result2).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("should re-probe stale cache entries (timestamp=0 treated as legacy/expired)", async () => {
    // Seed SQLite DB
    saveToolSupportCacheToDb("http://localhost:7777::stale-model", false);

    // Update SQLite database to set updated_at = 0
    const db = getHistoryDb();
    db.prepare("UPDATE tool_support_cache SET updated_at = 0 WHERE model_id = ?").run("http://localhost:7777::stale-model");

    // Clear memory cache to force re-loading from SQLite
    clearToolCallSupportCache();
    
    // Mock fetch to return true (proving re-probe happened and overrode stale false)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }]
      })
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeToolCallSupport("http://localhost:7777", "apikey", "stale-model");
    expect(result).toBe(true);
    // fetch MUST have been called because the cached entry was stale (timestamp=0)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
