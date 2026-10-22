import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { globTool } from "../src/core/tools/systemTools.js";
import { getWorkspaceCachePath } from "../src/core/workspaceDiscovery.js";

describe("Bun globTool Cache Interception", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    originalConfigDirEnv = process.env.SUPERAGENT_CONFIG_DIR;
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-glob-test-ws-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-glob-test-cfg-"));
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;
    fs.writeFileSync(path.join(testWorkspaceDir, "disk-file-1.ts"), "one");
    fs.writeFileSync(path.join(testWorkspaceDir, "disk-file-2.ts"), "two");
  });

  afterEach(() => {
    if (originalConfigDirEnv === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDirEnv;
    fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  it("uses cached files instead of scanning the disk", async () => {
    const cache = {
      workspaceDir: testWorkspaceDir,
      fingerprint: "abcde-123",
      fileList: ["src/index.ts", "src/utils.ts", "package.json", "README.md"],
      files: {},
      lastScanTime: Date.now()
    };
    fs.writeFileSync(getWorkspaceCachePath(testWorkspaceDir), JSON.stringify(cache));

    const result = await globTool.execute({ pattern: "src/**/*.ts" },
      testWorkspaceDir, new AbortController().signal);
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/utils.ts");
    expect(result).not.toContain("disk-file-1.ts");
  });

  it("falls back to Bun-native disk globbing when the cache is absent", async () => {
    const result = await globTool.execute({ pattern: "*.ts" },
      testWorkspaceDir, new AbortController().signal);
    expect(result).toContain("disk-file-1.ts");
    expect(result).toContain("disk-file-2.ts");
  });
});
