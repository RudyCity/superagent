import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { createInstantProject, getDefaultProjectDir } from "../src/core/project/projectScaffolder.js";

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

  it("should create a clean empty instant project by default without copying superagent internals", async () => {
    const targetProjectDir = path.join(tempDir, "my-instant-app");

    const result = await createInstantProject({
      projectName: "my-instant-app",
      targetDir: targetProjectDir,
      initGit: true,
    });

    expect(result.success).toBe(true);
    expect(result.targetDir).toBe(targetProjectDir);
    expect(result.template).toBe("empty");
    expect(fs.existsSync(targetProjectDir)).toBe(true);

    // Verify key files and directories exist in clean project
    expect(fs.existsSync(path.join(targetProjectDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "src"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "src", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "AGENTS.md"))).toBe(true);

    // Verify superagent internals are NOT copied
    expect(fs.existsSync(path.join(targetProjectDir, "chrome-extension"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, "chrome-extension-remote"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, "internal-hooks"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, "src", "core"))).toBe(false);
    expect(fs.existsSync(path.join(targetProjectDir, "src", "components"))).toBe(false);
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

  it("should create a minimal TypeScript project when template is minimal", async () => {
    const targetProjectDir = path.join(tempDir, "minimal-ts-app");

    const result = await createInstantProject({
      projectName: "minimal-ts-app",
      targetDir: targetProjectDir,
      template: "minimal",
      initGit: true,
    });

    expect(result.success).toBe(true);
    expect(result.template).toBe("minimal");
    expect(fs.existsSync(path.join(targetProjectDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(targetProjectDir, "package.json"))).toBe(true);
  });

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

  it("should return default project directory under Documents/superagent", () => {
    const defaultDir = getDefaultProjectDir("my-new-app");
    expect(defaultDir).toContain(path.join("Documents", "superagent", "my-new-app"));
  });
});
