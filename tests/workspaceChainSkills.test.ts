import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getInstalledSkills, clearSkillsCache } from "../src/core/config/skills.js";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";

describe("Workspace Chain Skills Resolution", () => {
  const tempDir = path.join(process.cwd(), "tests", "temp-chain-skills-resolution");
  const mockCwd = path.join(tempDir, "workspace-primary");
  const mockSiblingCwd = path.join(tempDir, "workspace-sibling");
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
    fs.mkdirSync(mockSiblingCwd, { recursive: true });
    fs.mkdirSync(mockHome, { recursive: true });

    // Mock cwd and homedir
    originalCwd = process.cwd;
    process.cwd = () => mockCwd;

    originalHomedir = os.homedir;
    os.homedir = () => mockHome;

    clearSkillsCache();
  });

  afterEach(() => {
    process.cwd = originalCwd;
    os.homedir = originalHomedir;
    vi.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load skills from other local workspace chain nodes and deduplicate by prioritizing primary", () => {
    // 1. Create a skill in the primary workspace
    const primarySkillDir = path.join(mockCwd, ".agents", "skills", "chain-skill-1");
    fs.mkdirSync(primarySkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(primarySkillDir, "SKILL.md"),
      `---
name: chain-skill-1
description: Primary version
author: chain-author
---
# Chain Skill 1 (Primary)
`
    );

    // 2. Create the same skill in the sibling workspace with different description
    const siblingSkillDir = path.join(mockSiblingCwd, ".agents", "skills", "chain-skill-1");
    fs.mkdirSync(siblingSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(siblingSkillDir, "SKILL.md"),
      `---
name: chain-skill-1
description: Sibling version
author: chain-author
---
# Chain Skill 1 (Sibling)
`
    );

    // 3. Create a unique skill in the sibling workspace
    const uniqueSiblingSkillDir = path.join(mockSiblingCwd, ".agents", "skills", "chain-skill-unique");
    fs.mkdirSync(uniqueSiblingSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(uniqueSiblingSkillDir, "SKILL.md"),
      `---
name: chain-skill-unique
description: Unique sibling version
author: sibling-author
---
# Unique Sibling Skill
`
    );

    // 4. Mock the active chain in workspaceChainManager
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue({
      id: "test-chain",
      name: "Test Chain",
      nodes: [
        {
          id: "primary",
          label: "Primary Node",
          type: "local",
          role: "main",
          path: mockCwd,
        },
        {
          id: "sibling",
          label: "Sibling Node",
          type: "local",
          role: "module",
          path: mockSiblingCwd,
        },
        {
          id: "ssh-node",
          label: "SSH Node",
          type: "ssh",
          role: "custom",
        }
      ],
      primaryNodeId: "primary",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const installed = getInstalledSkills();

    // Verify "chain-skill-1" is loaded only once and has the primary version description
    const matchingSkill1 = installed.filter(s => s.name === "chain-skill-1");
    expect(matchingSkill1.length).toBe(1);
    expect(matchingSkill1[0].description).toBe("Primary version");

    // Verify "chain-skill-unique" is loaded successfully from sibling
    const matchingUnique = installed.find(s => s.name === "chain-skill-unique");
    expect(matchingUnique).toBeDefined();
    expect(matchingUnique?.description).toBe("Unique sibling version");
  });
});
