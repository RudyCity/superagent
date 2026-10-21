import { describe, expect, it } from "vitest";
import type { Message } from "../src/core/conversation.js";
import {
  getCurrentSkillQuery, getModeGuidance, getToolDiscoveryGuidance,
  getExecutionGuidance, shouldIncludePlanningContext,
} from "../src/core/agent/SystemPromptPolicy.js";

describe("system prompt runtime policy", () => {
  it("uses only the current user request for skill selection", () => {
    const messages = [
      { role: "user", content: "Audit browser integrations", timestamp: 1 },
      { role: "assistant", content: "Browser audit completed", timestamp: 2 },
      { role: "user", content: "Fix backend API rate limiting", timestamp: 3 },
      { role: "assistant", content: "Working...", timestamp: 4 },
    ] as Message[];
    expect(getCurrentSkillQuery(messages)).toBe("Fix backend API rate limiting");
    expect(getCurrentSkillQuery([{ role: "user", content: [{ type: "text", text: "Check UI" }], timestamp: 1 }])).toBe("Check UI");
    expect(getCurrentSkillQuery([])).toBe("");
  });

  it("keeps the substantive task for a bare continuation prompt", () => {
    const msgs = [
      { role: "user", content: "Implement Motion Studio new effects", timestamp: 1 },
      { role: "assistant", content: "Phase 1 done", timestamp: 2 },
      { role: "user", content: "lanjut", timestamp: 3 },
    ] as Message[];
    expect(getCurrentSkillQuery(msgs)).toBe("Implement Motion Studio new effects lanjut");
    msgs.push({ role: "user", content: "audit security now", timestamp: 4 });
    expect(getCurrentSkillQuery(msgs)).toBe("audit security now");
  });
  it("keeps Q&A read-only and does not demand code tools without evidence", () => {
    const ask = getModeGuidance("ask", true);
    expect(ask).toContain("Answer directly");
    expect(ask).toContain("Do not edit");
    expect(ask).not.toContain("immediately to inspect");
    expect(ask).toContain("switch_mode");
    expect(getModeGuidance("ask", false)).not.toContain("switch_mode");
  });

  it("does not advertise discovery tools outside authorized catalog or subagent tier", () => {
    expect(getToolDiscoveryGuidance("single", [])).toBe("");
    expect(getToolDiscoveryGuidance("subagent", ["describe_tool", "list_tools"])).toBe("");
    const noCatalog = getToolDiscoveryGuidance("single", ["describe_tool"]);
    expect(noCatalog).not.toContain("For unknown tool names");
    expect(noCatalog).toContain("authorized/described tools");
    expect(getToolDiscoveryGuidance("single", ["describe_tool", "list_tools"])).toContain("File calls require arrays");
  });

  it("uses a smaller discovery prompt for Q&A and retains tool permission gates", () => {
    const tools = ["describe_tool", "list_tools"];
    const full = getToolDiscoveryGuidance("single", tools, "implement");
    const ask = getToolDiscoveryGuidance("single", tools, "ask");
    expect(ask.length).toBeLessThan(full.length / 2);
    expect(ask).toContain("authorized tools");
    expect(full).toContain("replace_file_content");
    expect(full).toContain("apply_patch");
  });

  it("requires explicit completion evidence and preserves goal mode partial status", () => {
    const goal = getExecutionGuidance("500", true, true);
    expect(goal).toContain("GOAL_COMPLETE");
    expect(goal).toContain("GOAL_PARTIAL");
    expect(goal).toContain("Never override loop guards");
    expect(goal).toContain("observed results");
    expect(goal).toContain("subagent results");
    const question = getExecutionGuidance("3", false, false);
    expect(question).not.toContain("GOAL_COMPLETE");
    expect(question).not.toContain("Delegate");
    expect(question).toContain("Stop when the request is answered");
  });

  it("does not pollute simple questions with stale plans but retains pending safety gates", () => {
    expect(shouldIncludePlanningContext("question", "IDLE", false, false)).toBe(false);
    expect(shouldIncludePlanningContext("question", "APPROVED", false, false)).toBe(false);
    expect(shouldIncludePlanningContext("conversation", "IDLE", false, false)).toBe(false);
    expect(shouldIncludePlanningContext("question", "PLANNING_PENDING", false, false)).toBe(true);
    expect(shouldIncludePlanningContext("question", "IDLE", true, false)).toBe(true);
    expect(shouldIncludePlanningContext("question", "IDLE", false, true)).toBe(true);
    expect(shouldIncludePlanningContext("complex_task", "IDLE", false, false)).toBe(true);
  });
});
