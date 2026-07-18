import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSkillsTool, useSkillTool } from "../src/core/tools/otherTools.js";

// Mock the config module
vi.mock("../src/core/config.js", () => {
  return {
    getInstalledSkills: vi.fn(),
    getModelInstance: vi.fn(),
  };
});

// Mock rmemoryUtil for semantic search
vi.mock("../src/core/rmemoryUtil.js", () => {
  return {
    searchSkillsByQuery: vi.fn(),
  };
});

// Mock fs module for skill content reading
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockImplementation((filePath) => {
        return `Mock content of ${filePath}`;
      }),
    },
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockImplementation((filePath) => {
      return `Mock content of ${filePath}`;
    }),
  };
});

describe("get_skills Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    const { searchSkillsByQuery } = await import("../src/core/rmemoryUtil.js");

    const mockSkills = [
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
    ];
    vi.mocked(getInstalledSkills).mockReturnValue(mockSkills);

    // Simulate embedding failure → tool falls back to TF-IDF keyword matching
    vi.mocked(searchSkillsByQuery).mockRejectedValue(new Error("Embedding unavailable"));

    // TF-IDF fallback: "React" matches only React Basics by keyword
    const reactResult = await getSkillsTool.execute({ query: "React" }, "/cwd");
    expect(reactResult).toContain("React Basics");
    expect(reactResult).not.toContain("Vue Basics");

    // TF-IDF fallback: "basics" matches both skills
    const basicsResult = await getSkillsTool.execute({ query: "basics" }, "/cwd");
    expect(basicsResult).toContain("React Basics");
    expect(basicsResult).toContain("Vue Basics");

    // TF-IDF fallback: "angular" matches nothing
    const emptyResult = await getSkillsTool.execute({ query: "angular" }, "/cwd");
    expect(emptyResult).toBe("No skills found matching query: angular");
  });

  it("should support RMemory semantic filtering when embedding is available", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    const { searchSkillsByQuery } = await import("../src/core/rmemoryUtil.js");

    const mockSkills = [
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
    ];
    vi.mocked(getInstalledSkills).mockReturnValue(mockSkills);

    // Mock semantic search to only return Vue Basics (simulates embedding match)
    vi.mocked(searchSkillsByQuery).mockResolvedValue([mockSkills[1]]);

    const result = await getSkillsTool.execute({ query: "Vue UI library" }, "/cwd");
    expect(result).toContain("Vue Basics");
    expect(result).not.toContain("React Basics");
    expect(searchSkillsByQuery).toHaveBeenCalledWith("vue ui library", mockSkills, 8);
  });

  it("should fall back to smart keyword matching when AI returns empty or fails", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    const { searchSkillsByQuery } = await import("../src/core/rmemoryUtil.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "auth-implementation-patterns",
        description: "Master authentication and authorization patterns including JWT, OAuth2, session management, and RBAC to build secure, scalable access control systems.",
        author: "wshobson",
        path: "/path/to/auth/SKILL.md",
      },
      {
        name: "istio-traffic-management",
        description: "Configure Istio traffic management including routing, load balancing, circuit breakers, and canary deployments.",
        author: "wshobson",
        path: "/path/to/istio/SKILL.md",
      },
    ]);
    // Simulate embedding failure → TF-IDF fallback takes over
    vi.mocked(searchSkillsByQuery).mockRejectedValue(new Error("Embedding unavailable"));

    const result = await getSkillsTool.execute({ query: "rbac role user management" }, "/cwd");
    expect(result).toContain("auth-implementation-patterns");
    expect(result).toContain("istio-traffic-management");
  });

  it("should automatically include skill contents when a query is provided and the file exists", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    const { searchSkillsByQuery } = await import("../src/core/rmemoryUtil.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "Mock Skill",
        description: "A skill for testing",
        author: "tester",
        path: "/path/to/mock-skill/SKILL.md",
      },
    ]);
    // Simulate embedding failure → TF-IDF fallback, skill still included in results
    vi.mocked(searchSkillsByQuery).mockRejectedValue(new Error("Embedding unavailable"));

    const result = await getSkillsTool.execute({ query: "testing" }, "/cwd");
    expect(result).toContain("Mock Skill");
    expect(result).toContain("content:");
    expect(result).toContain("Mock content of /path/to/mock-skill/SKILL.md");
  });
});

describe("use_skill Tool", () => {
  it("should return error when no arguments are provided", async () => {
    const result = await useSkillTool.execute({}, "/cwd");
    expect(result).toContain("Error: You must provide either 'skillName' or 'path' to use a skill.");
  });

  it("should successfully retrieve skill by name", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "systematic-debugging",
        description: "Standard debugging skill",
        path: "/path/to/debug/SKILL.md",
      },
    ]);

    const result = await useSkillTool.execute({ skillName: "systematic-debugging" }, "/cwd");
    expect(result).toContain("### Activated Skill: systematic-debugging");
    expect(result).toContain("Mock content of /path/to/debug/SKILL.md");
  });

  it("should successfully retrieve skill by path", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "systematic-debugging",
        description: "Standard debugging skill",
        path: "/path/to/debug/SKILL.md",
      },
    ]);

    const result = await useSkillTool.execute({ path: "/path/to/debug/SKILL.md" }, "/cwd");
    expect(result).toContain("### Activated Skill: systematic-debugging");
    expect(result).toContain("Mock content of /path/to/debug/SKILL.md");
  });

  it("should return error when skill is not found", async () => {
    const { getInstalledSkills } = await import("../src/core/config.js");
    vi.mocked(getInstalledSkills).mockReturnValue([
      {
        name: "React Basics",
        description: "React basics skill",
        path: "/path/to/react/SKILL.md",
      },
    ]);

    const result = await useSkillTool.execute({ skillName: "Vue Basics" }, "/cwd");
    expect(result).toContain("Error: Skill \"Vue Basics\" not found.");
  });
});

