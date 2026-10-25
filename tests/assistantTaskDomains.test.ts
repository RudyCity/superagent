import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TASK_DOMAINS, getAssistantTaskDomain, taskDomainPrompt,
  validAssistantTaskDomain,
} from "../src/core/assistant/assistantTaskDomains.js";

describe("general assistant domain capability boundaries", () => {
  it("supports general, research, planning, local files and coding without requiring a coding task", () => {
    expect(ASSISTANT_TASK_DOMAINS).toEqual([
      "general", "research", "analysis", "planning", "files", "coding",
    ]);
    expect(ASSISTANT_TASK_DOMAINS.every(validAssistantTaskDomain)).toBe(true);
    expect(validAssistantTaskDomain("browser")).toBe(false);
    expect(validAssistantTaskDomain("automation")).toBe(false);
    expect(() => getAssistantTaskDomain("../anything")).toThrow();
  });
  it("assigns only relevant tool capabilities and never a mutation tool", () => {
    const general = getAssistantTaskDomain("general");
    const planning = getAssistantTaskDomain("planning");
    const research = getAssistantTaskDomain("research");
    const files = getAssistantTaskDomain("files");
    const coding = getAssistantTaskDomain("coding");
    expect(general.toolNames).toHaveLength(0);
    expect(planning.toolNames).toHaveLength(0);
    expect(research.toolNames).toContain("web_search");
    expect(research.toolNames).toContain("fetch_url");
    expect(research.toolNames).not.toContain("read");
    expect(files.toolNames).toContain("read_document");
    expect(files.toolNames).not.toContain("web_search");
    expect(coding.patchPreview).toBe(true);
    expect(research.patchPreview).toBe(false);
    for (const domain of ASSISTANT_TASK_DOMAINS) {
      const policy = getAssistantTaskDomain(domain);
      expect(policy.toolNames).not.toContain("execute_command");
      expect(policy.toolNames).not.toContain("write_to_file");
      expect(policy.toolNames).not.toContain("apply_patch");
      expect(policy.toolNames).not.toContain("control_chrome_cdp");
      expect(policy.toolNames).not.toContain("invoke_subagent");
      expect(taskDomainPrompt(domain, "Summarize")).toContain("Summarize");
    }
  });
});
