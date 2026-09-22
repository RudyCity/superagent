import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { createInstantProject } from "../src/core/project/projectScaffolder.js";

describe("projectScaffolder", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-scaffold-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should create a new instant project from the base directory", async () => {
    const targetProjectDir = path.join(tempDir, "my-instant-app");

    const result = await createInstantProject({
      projectName: "my-instant-app",
      targetDir: targetProjectDir,
      initGit: true,
    });

    expect(result.success).toBe(true);
    expect(result.targetDir).toBe(targetProjectDir);
    expect(fs.existsSync(targetProjectDir)).toBe(true);

    // Verify key files and directories exist
    expect(fs.existsSync(path.join(targetProjectDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "src"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "AGENTS.md"))).toBe(true);

    // Verify exclusions: no node_modules, no dist, no .worktrees, no log files
    expect(fs.existsSync(path.join(targetProjectDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, ".worktrees"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, ".superagent"))).toBe(false);

    // Verify package.json personalization
    const pkgContent = JSON.parse(fs.readFileSync(path.join(targetProjectDir, "package.json"), "utf-8"));
    expect(pkgContent.name).toBe("my-instant-app");
    expect(pkgContent.version).toBe("1.0.0");

    // Verify git initialization
    expect(fs.existsSync(path.join(targetProjectDir, ".git"))).toBe(true);
  }, 20000);

  it("should throw error if target directory exists without force flag", async () => {
    const targetProjectDir = path.join(tempDir, "existing-app");
    fs.mkdirSync(targetProjectDir, { recursive: true });
    fs.writeFileSync(path.join(targetProjectDir, "some-file.txt"), "content");

    await expect(
      createInstantProject({
        projectName: "existing-app",
        targetDir: targetProjectDir,
        force: false,
      })
    ).rejects.toThrow(/already exists/i);
  });

  it("should overwrite existing directory if force is true", async () => {
    const targetProjectDir = path.join(tempDir, "forced-app");
    fs.mkdirSync(targetProjectDir, { recursive: true });
    fs.writeFileSync(path.join(targetProjectDir, "some-file.txt"), "old content");

    const result = await createInstantProject({
      projectName: "forced-app",
      targetDir: targetProjectDir,
      force: true,
      initGit: false,
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "package.json"))).toBe(true);
  });
});
