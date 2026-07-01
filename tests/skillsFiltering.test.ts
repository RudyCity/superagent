import { describe, it, expect } from "vitest";
import { loadAgentSkills } from "../src/core/config/skills.js";

describe("Agent Skills Prompt Instructions", () => {
  it("should return the general skills instruction prompt", () => {
    const prompt = loadAgentSkills();
    expect(prompt).toContain("INSTALLED AGENT SKILLS & MANDATORY DISCOVERY RULES");
    expect(prompt).toContain(".agents/skills/");
    expect(prompt).toContain("read its `SKILL.md`");
  });
});
