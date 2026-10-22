import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { grepTool } from "../src/core/tools/systemTools.js";
import { getWorkspaceCachePath } from "../src/core/workspaceDiscovery.js";
import * as fsPromisesModule from "node:fs/promises";

describe("Bun grepTool Cache Interception", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    originalConfigDirEnv = process.env.SUPERAGENT_CONFIG_DIR;
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-grep-test-ws-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-grep-test-cfg-"));
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;
    fs.writeFileSync(path.join(testWorkspaceDir, "disk-file-1.ts"), "matching query from disk");
    fs.writeFileSync(path.join(testWorkspaceDir, "disk-file-2.ts"), "unrelated text");

    // The cache intentionally contains a virtual (not-on-disk) file.
    vi.spyOn(fsPromisesModule.default, "readFile").mockImplementation(async (filePath: any) => {
      if (String(filePath).includes("index.ts")) return "console.log('hello matching query');";
      return fs.readFileSync(String(filePath), "utf8");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigDirEnv === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDirEnv;
    fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  it("prefers cached paths over disk files", async () => {
    const cache = {
      workspaceDir: testWorkspaceDir,
      fingerprint: "abcde-123",
      fileList: ["src/index.ts", "src/utils.ts", "package.json", "README.md"],
      files: {},
      lastScanTime: Date.now()
    };
    fs.writeFileSync(getWorkspaceCachePath(testWorkspaceDir), JSON.stringify(cache));
    const result = await grepTool.execute({ pattern: "matching query", include: "*.ts" },
      testWorkspaceDir, new AbortController().signal);
    expect(result).toContain("src/index.ts:1: console.log('hello matching query');");
    expect(result).not.toContain("disk-file-1.ts");
  });

  it("scans actual disk files with Bun.Glob when cache is absent", async () => {
    const result = await grepTool.execute({ pattern: "matching query", include: "*.ts" },
      testWorkspaceDir, new AbortController().signal);
    expect(result).toContain("disk-file-1.ts:1: matching query from disk");
    expect(result).not.toContain("disk-file-2.ts");
  });
});
