import { describe, it, expect, vi } from "vitest";
import { getSkillsTool } from "../src/core/tools/otherTools.js";

// Mock the config module
vi.mock("../src/core/config.js", () => {
  return {
    getInstalledSkills: vi.fn(),
  };
});

describe("get_skills Tool", () => {
  it("should return no skills found when list is empty", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    vi.mocked(getInstalledSkills).mockReturnValue([]);

    const result = await getSkillsTool.execute({}, "/cwd");
    expect(result).toBe("No installed skills found.");
  });

  it("should list all installed skills without markdown decoration", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "React Basics",
        description: "Learn standard react components",
        author: "web-dev",
        path: "/path/to/react-basics/SKILL.md",
      },
    ]);

    const result = await getSkillsTool.execute({}, "/cwd");
    expect(result).toContain("Installed Skills:");
    expect(result).toContain("- name: React Basics");
    expect(result).toContain("author: web-dev");
    expect(result).toContain("description: Learn standard react components");
    expect(result).toContain("path: /path/to/react-basics/SKILL.md");
    
    // Check that there is no bold/heading markdown formatting
    expect(result).not.toContain("**");
    expect(result).not.toContain("##");
  });

  it("should filter skills by query correctly case-insensitively", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "React Basics",
        description: "Learn standard react components",
        author: "web-dev",
        path: "/path/to/react-basics/SKILL.md",
      },
      {
        name: "Vue Basics",
        description: "Learn Vue framework essentials",
        author: "web-dev",
        path: "/path/to/vue-basics/SKILL.md",
      },
    ]);

    // Test filtering matching React
    const reactResult = await getSkillsTool.execute({ query: "React" }, "/cwd");
    expect(reactResult).toContain("React Basics");
    expect(reactResult).not.toContain("Vue Basics");

    // Test filtering matching basics
    const basicsResult = await getSkillsTool.execute({ query: "basics" }, "/cwd");
    expect(basicsResult).toContain("React Basics");
    expect(basicsResult).toContain("Vue Basics");

    // Test filtering matching nothing
    const emptyResult = await getSkillsTool.execute({ query: "angular" }, "/cwd");
    expect(emptyResult).toBe("No skills found matching query: angular");
  });
});
