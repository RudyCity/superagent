import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/tools/helpers.js", () => ({
  resolveWindowsShell: () => ({ isBash: false, shellPath: "powershell.exe" }),
}));

import { getSystemPrompt } from "../src/core/config/base.js";
import { MASTER_AGENT_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { SUBAGENT_SYSTEM_PROMPTS, SUPERAGENT_SYSTEM_PROMPT } from "../src/core/prompts.js";

describe("base system prompt", () => {
  it("encourages evidence-led creative problem solving without prescribing hidden reasoning", () => {
    const prompt = getSystemPrompt();

    expect(prompt).toContain("# CREATIVE PROBLEM SOLVING");
    expect(prompt).toContain("Evidence before inference");
    expect(prompt).toContain("Think deeply in private");
    expect(prompt).toContain("2–3 materially different approaches");
    expect(prompt).not.toContain("Mental MCTS & UCB");
    expect(prompt).not.toContain("Maximum Compression Mode");
  });
});

describe("tier reasoning prompt", () => {
  it("uses bounded divergent thinking for open-ended work", () => {
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("CREATIVE_RANGE");
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("2-3 materially different options");
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("REASONING_PRIVACY");
  });

  it("assigns decision rights to the correct tier", () => {
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("MASTER: Own decomposition");
    expect(SUPERAGENT_SYSTEM_PROMPT("feature", "branch", "worktree")).toContain("SUPERAGENT: Own technical design");
    expect(SUBAGENT_SYSTEM_PROMPTS.coder).toContain("SUBAGENT: Execute only the assigned atomic objective");
    expect(SUBAGENT_SYSTEM_PROMPTS.coder).not.toContain("May spawn subagents recursively");
  });
});
