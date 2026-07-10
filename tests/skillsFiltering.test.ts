import { describe, it, expect } from "vitest";
import { loadAgentSkills } from "../src/core/config/skills.js";

describe("Agent Skills Prompt Instructions", () => {
  it("should return the general skills instruction prompt", () => {
    const prompt = loadAgentSkills();
    expect(prompt).toContain("SKILL DISCOVERY");
    expect(prompt).toContain("get_skills");
    expect(prompt).toContain("view_file");
  });
});
