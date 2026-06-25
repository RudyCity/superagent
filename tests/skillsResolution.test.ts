import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getInstalledSkills, normalizePath } from "../src/core/config/skills.js";

describe("Skills Resolution and Deduplication", () => {
  const tempDir = path.join(process.cwd(), "tests", "temp-skills-resolution");
  const mockCwd = path.join(tempDir, "workspace");
  const mockHome = path.join(tempDir, "home");

  let originalCwd: () => string;
  let originalHomedir: () => string;

  beforeEach(() => {
    // Setup clean directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(mockCwd, { recursive: true });
    fs.mkdirSync(mockHome, { recursive: true });

    // Mock cwd and homedir
    originalCwd = process.cwd;
    process.cwd = () => mockCwd;

    originalHomedir = os.homedir;
    os.homedir = () => mockHome;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    os.homedir = originalHomedir;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should normalize paths to standard slashes and case (on Windows)", () => {
    const p1 = "C:\\Users\\USER\\Documents/project";
    const p2 = "c:/users/user/documents/project";
    if (os.platform() === "win32") {
      expect(normalizePath(p1)).toBe(normalizePath(p2));
    } else {
      expect(normalizePath(p1)).toBe("C:/Users/USER/Documents/project");
    }
  });

  it("should prioritize workspace local skills and deduplicate duplicates", () => {
    // 1. Create a workspace skill
    const localSkillDir = path.join(mockCwd, ".agents", "skills", "test-skill-1");
    fs.mkdirSync(localSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(localSkillDir, "SKILL.md"),
      `---
name: test-skill-1
description: Workspace local version of test-skill-1
author: test-author
---
# Test Skill 1
`
    );

    // 2. Create a global skill with the same name/author but different description
    const globalSkillDir = path.join(mockHome, ".superagent-r", "skills", "test-skill-1");
    fs.mkdirSync(globalSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalSkillDir, "SKILL.md"),
      `---
name: test-skill-1
description: Global version of test-skill-1
author: test-author
---
# Test Skill 1 (Global)
`
    );

    // Load skills
    const installed = getInstalledSkills();

    // Verify:
    // Only one skill named "test-skill-1" from "test-author" should be loaded.
    // The description should be the workspace local one.
    const matches = installed.filter(
      s => s.name === "test-skill-1" && s.author === "test-author"
    );
    expect(matches.length).toBe(1);
    expect(matches[0].description).toBe("Workspace local version of test-skill-1");
    expect(matches[0].path.replace(/\\/g, "/")).toContain("workspace");
  });
});
