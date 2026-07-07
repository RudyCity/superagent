import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { grepTool } from "../src/core/tools/systemTools.js";
import * as workspaceDiscovery from "../src/core/workspaceDiscovery.js";
import fg from "fast-glob";

// Mock fast-glob's default execution to see if it is called
vi.mock("fast-glob", async (importOriginal) => {
  const original = await importOriginal<any>();
  const spyFg = vi.fn().mockImplementation(async (pattern: any, options: any) => {
    return ["disk-file-1.ts", "disk-file-2.ts"];
  });
  
  (spyFg as any).isMatch = original.default.isMatch;
  
  return {
    ...original,
    default: spyFg
  };
});

// Mock fs/promises's readFile since grepTool reads matched files from disk
vi.mock("fs/promises", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    default: {
      ...original.default,
      readFile: vi.fn().mockImplementation(async (filePath: string) => {
        if (filePath.includes("index.ts")) {
          return "console.log('hello matching query');";
        }
        return "some other content";
      })
    },
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      if (filePath.includes("index.ts")) {
        return "console.log('hello matching query');";
      }
      return "some other content";
    })
  };
});

describe("grepTool Cache Interception", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    originalConfigDirEnv = process.env.SUPERAGENT_CONFIG_DIR;
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-grep-test-ws-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-grep-test-cfg-"));
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

  it("should bypass disk globbing and search cache files when cache exists", async () => {
    const mockCache = {
      workspaceDir: testWorkspaceDir,
      fingerprint: "abcde-123",
      fileList: ["src/index.ts", "src/utils.ts", "package.json", "README.md"],
      files: {},
      lastScanTime: Date.now()
    };

    const cachePath = workspaceDiscovery.getWorkspaceCachePath(testWorkspaceDir);
    fs.writeFileSync(cachePath, JSON.stringify(mockCache), "utf-8");

    const result = await grepTool.execute(
      { pattern: "matching query", include: "*.ts" },
      testWorkspaceDir,
      new AbortController().signal
    );

    // It should find the matching text in src/index.ts (which we mocked in fs/promises)
    expect(result).toContain("src/index.ts:1: console.log('hello matching query');");
    expect(result).not.toContain("disk-file-1.ts");

    // Verify fast-glob on disk was bypassed (mock was not called)
    expect(fg).not.toHaveBeenCalled();
  });

  it("should fall back to disk globbing when no cache exists", async () => {
    const result = await grepTool.execute(
      { pattern: "matching query", include: "*.ts" },
      testWorkspaceDir,
      new AbortController().signal
    );

    // Disk globbing fallback mock returns ["disk-file-1.ts", "disk-file-2.ts"].
    // Since we mocked readFile to return "some other content" for non-index files,
    // they won't match "matching query" so the result should be "No matches found." or error.
    expect(result).toContain("No matches found.");

    // Verify fast-glob on disk was executed
    expect(fg).toHaveBeenCalled();
  });
});
