import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { globTool } from "../src/core/tools/systemTools.js";
import * as workspaceDiscovery from "../src/core/workspaceDiscovery.js";
import fg from "fast-glob";

import picomatch from "picomatch";

// Mock fast-glob's default execution to see if it is called.
// Synchronous factory — avoids Bun deadlock from async importOriginal.
vi.mock("fast-glob", () => {
  const spyFg = vi.fn().mockImplementation(async (_pattern: any, _options: any) => {
    return ["disk-file-1.ts", "disk-file-2.ts"];
  });

  (spyFg as any).isMatch = (str: string, pattern: string | string[], options?: any) => {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    return patterns.some((p) => picomatch.isMatch(str, p, options));
  };

  return {
    default: spyFg,
    isMatch: (str: string, pattern: string | string[], options?: any) => {
      const patterns = Array.isArray(pattern) ? pattern : [pattern];
      return patterns.some((p) => picomatch.isMatch(str, p, options));
    },
  };
});

describe("globTool Cache Interception", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    originalConfigDirEnv = process.env.SUPERAGENT_CONFIG_DIR;
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-glob-test-ws-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-glob-test-cfg-"));
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;

    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.SUPERAGENT_CONFIG_DIR = originalConfigDirEnv;
    try {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it("should bypass disk globbing and return matching files from cache when cache exists", async () => {
    const mockCache = {
      workspaceDir: testWorkspaceDir,
      fingerprint: "abcde-123",
      fileList: ["src/index.ts", "src/utils.ts", "package.json", "README.md"],
      files: {},
      lastScanTime: Date.now()
    };

    // Write cache to config directory so it is resolved by cache path
    const cachePath = workspaceDiscovery.getWorkspaceCachePath(testWorkspaceDir);
    fs.writeFileSync(cachePath, JSON.stringify(mockCache), "utf-8");

    // Execute globTool on test directory
    const result = await globTool.execute(
      { pattern: "src/**/*.ts" },
      testWorkspaceDir,
      new AbortController().signal
    );

    // Verify output matched in-memory
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/utils.ts");
    expect(result).not.toContain("package.json");
    expect(result).not.toContain("README.md");

    // Verify fast-glob on disk was bypassed (mock was not called)
    expect(fg).not.toHaveBeenCalled();
  });

  it("should fall back to disk globbing when no cache exists", async () => {
    // Execute globTool on a path with no cache file
    const result = await globTool.execute(
      { pattern: "*.ts" },
      testWorkspaceDir,
      new AbortController().signal
    );

    // Should return mocked disk glob files
    expect(result).toContain("disk-file-1.ts");
    expect(result).toContain("disk-file-2.ts");

    // Verify fast-glob on disk was executed
    expect(fg).toHaveBeenCalled();
  });
});
