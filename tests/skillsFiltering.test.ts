import { describe, it, expect } from "vitest";
import { loadAgentSkills } from "../src/core/config/skills.js";

describe("Dynamic Skill Filtering by Query", () => {
  it("should always load core skills regardless of query", () => {
    const prompt = loadAgentSkills(undefined, undefined, "random query that matches nothing");
    expect(prompt).toContain("getting-started-with-skills");
    expect(prompt).toContain("karpathy-guidelines");
    expect(prompt).toContain("when-stuck-problem-solving-dispatch");
  });

  it("should dynamically include skills matching keywords in user query", () => {
    const prompt = loadAgentSkills(undefined, undefined, "need to check vercel deployment");
    expect(prompt).toContain("getting-started-with-skills"); // core
    expect(prompt).toContain("deploy-to-vercel"); // matching keyword "vercel"
    
    // Should not contain unrelated skills
    expect(prompt).not.toContain("fastapi-templates");
    expect(prompt).not.toContain("airflow-dag-patterns");
  });

  it("should match multiple terms and support CJK / alphanumeric split", () => {
    const prompt = loadAgentSkills(undefined, undefined, "android and ios mobile apps");
    expect(prompt).toContain("mobile-android-design");
    expect(prompt).toContain("mobile-ios-design");
    expect(prompt).not.toContain("airflow-dag-patterns");
  });

  it("should filter out multi-agent specific skills in single agent mode", () => {
    // When isMultiAgent is false (default), team-composition-patterns should not be loaded
    const singlePrompt = loadAgentSkills(undefined, undefined, "need to check team composition patterns", false);
    expect(singlePrompt).not.toContain("team-composition-patterns");

    // When isMultiAgent is true, it should load team-composition-patterns
    const multiPrompt = loadAgentSkills(undefined, undefined, "need to check team composition patterns", true);
    expect(multiPrompt).toContain("team-composition-patterns");
  });
});
