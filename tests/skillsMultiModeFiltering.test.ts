import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MULTI_MODE_SKILLS,
  isMultiModeSkill,
  filterSkillsByMode,
  loadAgentSkills,
  type LoadedSkill
} from "../src/core/config/skills.js";
import { getSkillsTool, useSkillTool } from "../src/core/tools/otherTools.js";
import * as configModule from "../src/core/config.js";
import { agentLocalStorage, Agent } from "../src/core/agent.js";
import fs from "fs";

describe("Multi-Mode Skills Classification and Filtering", () => {
  it("should have all expected multi-mode skills in MULTI_MODE_SKILLS set", () => {
    expect(MULTI_MODE_SKILLS.has("master-agent-orchestration")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("subagent-driven-development")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("dispatching-parallel-agents")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("preventing-subagent-collisions")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("testing-skills-with-subagents")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("parallel-feature-development")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("parallel-debugging")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("multi-reviewer-patterns")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("task-coordination-strategies")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("team-communication-protocols")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("team-composition-patterns")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("team-composition-analysis")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("review-agent-setup")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("requesting-code-review")).toBe(true);
    expect(MULTI_MODE_SKILLS.has("using-git-worktrees")).toBe(true);
  });

  it("isMultiModeSkill should correctly identify multi-mode vs single/general skills", () => {
    expect(isMultiModeSkill({ name: "master-agent-orchestration" })).toBe(true);
    expect(isMultiModeSkill({ name: "Subagent-Driven Development" })).toBe(true);
    expect(isMultiModeSkill({ name: "custom-skill", path: "/path/to/preventing-subagent-collisions/SKILL.md" })).toBe(true);
    expect(isMultiModeSkill({ name: "custom-skill", mode: "multi" })).toBe(true);

    expect(isMultiModeSkill({ name: "systematic-debugging" })).toBe(false);
    expect(isMultiModeSkill({ name: "react-modernization" })).toBe(false);
    expect(isMultiModeSkill({ name: "single-agent-cognitive-scaleup" })).toBe(false);
    expect(isMultiModeSkill({ name: "custom-skill", mode: "single" })).toBe(false);
  });

  it("filterSkillsByMode should filter out multi-mode skills in single mode and retain them in multi mode", () => {
    const skills: LoadedSkill[] = [
      {
        name: "systematic-debugging",
        description: "General debugging skill",
        path: "/path/to/systematic-debugging/SKILL.md",
        mode: "all",
      },
      {
        name: "master-agent-orchestration",
        description: "Multi-agent master orchestrator",
        path: "/path/to/master-agent-orchestration/SKILL.md",
        mode: "multi",
      },
      {
        name: "subagent-driven-development",
        description: "Subagent plan execution",
        path: "/path/to/subagent-driven-development/SKILL.md",
        mode: "multi",
      },
      {
        name: "react-state-management",
        description: "React state patterns",
        path: "/path/to/react-state-management/SKILL.md",
        mode: "all",
      },
    ];

    const singleModeSkills = filterSkillsByMode(skills, false);
    expect(singleModeSkills.map((s) => s.name)).toEqual([
      "systematic-debugging",
      "react-state-management",
    ]);

    const multiModeSkills = filterSkillsByMode(skills, true);
    expect(multiModeSkills.map((s) => s.name)).toEqual([
      "systematic-debugging",
      "master-agent-orchestration",
      "subagent-driven-development",
      "react-state-management",
    ]);
  });
});

describe("loadAgentSkills Mode Awareness", () => {
  it("should generate single-agent prompt without multi-agent orchestration references in single mode", () => {
    const prompt = loadAgentSkills("general", "single", undefined, false);
    expect(prompt).toContain("single-agent-cognitive-scaleup");
    expect(prompt).not.toContain("master-agent-orchestration");
    expect(prompt).not.toContain("subagent-driven-development");
    expect(prompt).toContain("plan implementation for architecture refactoring");
  });

  it("should generate multi-agent prompt with multi-agent orchestration references in multi mode", () => {
    const prompt = loadAgentSkills("general", "master", undefined, true);
    expect(prompt).toContain("master-agent-orchestration");
    expect(prompt).toContain("subagent-driven-development");
    expect(prompt).toContain("plan implementation for multi-agent orchestration feature");
  });
});

describe("getSkillsTool and useSkillTool Mode Enforcement", () => {
  const mockSkills: LoadedSkill[] = [
    {
      name: "systematic-debugging",
      description: "Root cause tracing and debugging",
      path: "/mock/skills/systematic-debugging/SKILL.md",
      author: "superagent",
      mode: "all",
      category: "General",
    },
    {
      name: "master-agent-orchestration",
      description: "Master agent 3-tier orchestration",
      path: "/mock/skills/master-agent-orchestration/SKILL.md",
      author: "superagent",
      mode: "multi",
      category: "Multi-Agent Orchestration",
    },
    {
      name: "subagent-driven-development",
      description: "Dispatch fresh subagents per task",
      path: "/mock/skills/subagent-driven-development/SKILL.md",
      author: "superagent",
      mode: "multi",
      category: "Multi-Agent Orchestration",
    },
    {
      name: "react-modernization",
      description: "Migrate and upgrade React codebases",
      path: "/mock/skills/react-modernization/SKILL.md",
      author: "superagent",
      mode: "all",
      category: "General",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(configModule, "getInstalledSkills").mockReturnValue(mockSkills);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => `Mock content of ${p}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("get_skills in single mode must NOT return multi-mode skills in full list", async () => {
    const fakeSingleAgent = {
      isMultiAgent: false,
      tier: "single",
    } as unknown as Agent;

    const result = await agentLocalStorage.run(fakeSingleAgent, async () => {
      return await getSkillsTool.execute({}, "/cwd");
    });

    expect(result).toContain("systematic-debugging");
    expect(result).toContain("react-modernization");
    expect(result).not.toContain("master-agent-orchestration");
    expect(result).not.toContain("subagent-driven-development");
  });

  it("get_skills in single mode must NOT return multi-mode skills in query search", async () => {
    const fakeSingleAgent = {
      isMultiAgent: false,
      tier: "single",
    } as unknown as Agent;

    const result = await agentLocalStorage.run(fakeSingleAgent, async () => {
      return await getSkillsTool.execute({ query: "orchestration subagent" }, "/cwd");
    });

    expect(result).not.toContain("master-agent-orchestration");
    expect(result).not.toContain("subagent-driven-development");
  });

  it("get_skills in multi mode should group multi-agent skills and general skills", async () => {
    const fakeMasterAgent = {
      isMultiAgent: true,
      tier: "master",
    } as unknown as Agent;

    const result = await agentLocalStorage.run(fakeMasterAgent, async () => {
      return await getSkillsTool.execute({}, "/cwd");
    });

    expect(result).toContain("Multi-Agent Orchestration Skills:");
    expect(result).toContain("master-agent-orchestration");
    expect(result).toContain("subagent-driven-development");
    expect(result).toContain("General & Development Skills:");
    expect(result).toContain("systematic-debugging");
    expect(result).toContain("react-modernization");
  });

  it("use_skill in single mode should block activating multi-mode skills", async () => {
    const fakeSingleAgent = {
      isMultiAgent: false,
      tier: "single",
    } as unknown as Agent;

    const result = await agentLocalStorage.run(fakeSingleAgent, async () => {
      return await useSkillTool.execute({ skillName: "master-agent-orchestration" }, "/cwd");
    });

    expect(result).toContain("is a multi-agent orchestration skill and is not available in single-agent mode");
  });

  it("use_skill in multi mode should allow activating multi-mode skills", async () => {
    const fakeMasterAgent = {
      isMultiAgent: true,
      tier: "master",
    } as unknown as Agent;

    const result = await agentLocalStorage.run(fakeMasterAgent, async () => {
      return await useSkillTool.execute({ skillName: "master-agent-orchestration" }, "/cwd");
    });

    expect(result).toContain("### Activated Skill: master-agent-orchestration");
    expect(result).toContain("Mock content of /mock/skills/master-agent-orchestration/SKILL.md");
  });
});
