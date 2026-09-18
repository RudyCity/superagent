import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/tools/helpers.js", () => ({
  resolveWindowsShell: () => ({ isBash: false, shellPath: "powershell.exe" }),
}));

import { getSystemPrompt } from "../src/core/config/base.js";
import {
  MASTER_AGENT_SYSTEM_PROMPT,
  SUPERAGENT_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPTS,
} from "../src/core/prompts.js";

const superagent = SUPERAGENT_SYSTEM_PROMPT(
  "coder", "feature/prompt-optimization", "D:/worktrees/prompt-optimization",
);
// Pre-edit measurements using the fixed arguments above and PowerShell mock.
const baselines = { base: 11652, master: 9300, superagent: 11388, researcher: 7236, coder: 8022 };
const prompts = {
  base: getSystemPrompt(), master: MASTER_AGENT_SYSTEM_PROMPT,
  superagent, researcher: SUBAGENT_SYSTEM_PROMPTS.researcher,
  coder: SUBAGENT_SYSTEM_PROMPTS.coder,
};

describe("prompt optimization", () => {
  it("does not increase rendered prompt sizes", () => {
    const sizes = Object.fromEntries(Object.entries(prompts).map(([key, prompt]) => [key, prompt.length]));
    console.log("PROMPT_SIZES " + JSON.stringify(sizes));
    for (const key of Object.keys(baselines) as Array<keyof typeof baselines>) {
      expect(prompts[key].length, key).toBeLessThanOrEqual(baselines[key]);
    }
  });

  it("keeps researcher guidance read-only and delegates runtime verification", () => {
    const researcher = prompts.researcher;
    expect(researcher).toContain("Read-only. File mods BLOCKED. Shell/run_command BLOCKED");
    expect(researcher).toContain("ask parent for runtime verification");
    expect(researcher).toContain("Do not execute commands, write scratch files, or transfer files");
    expect(researcher).toContain("Browser control belongs to chrome-agent");
    for (const unavailable of ["run_background_process", "transfer_ssh_file", "SCRATCH_WORKSPACE", "Terminal Debug:", "browser_navigate", "write_to_file", "debug via terminal"]) {
      expect(researcher).not.toContain(unavailable);
    }
  });

  it("preserves process protection and tier boundaries", () => {
    for (const prompt of [prompts.master, superagent, prompts.coder]) {
      expect(prompt).toContain("PROTECT_PROCESS: NEVER kill parent/runtime. Target PID ONLY.");
    }
    expect(prompts.master).toContain("Code edits BLOCKED. Delegate ALL feature code to Superagents");
    expect(prompts.coder).toContain("Git BLOCKED outside worktree");
    expect(prompts.coder).toContain("Edits outside assigned files BLOCKED");
    expect(prompts.coder).toContain("manage_tasks/manage_plan BLOCKED");
  });

  it("retains repeated superagent identity and report fields", () => {
    for (const field of ["- Role: coder", "- Branch: feature/prompt-optimization", "- Worktree: D:/worktrees/prompt-optimization"]) {
      expect(superagent.split(field)).toHaveLength(3);
    }
    for (const field of ["- Goal:", "- Conclusion:", "- Evidence:", "- Confidence:", "- Status:"]) {
      expect(prompts.coder).toContain(field);
      expect(prompts.researcher).toContain(field);
    }
  });

  it("resolves clarification and narration without removing permission gates", () => {
    for (const prompt of Object.values(prompts)) {
      expect(prompt).toContain("unresolved_material_ambiguity_after_available_evidence");
      expect(prompt).not.toContain("if decision_point:");
      expect(prompt).toContain("Brief intent/progress narration is allowed alongside tool use, not instead of it");
    }
    expect(prompts.coder).toContain("DESTRUCTIVE: ask_question before");
    expect(prompts.master).toContain("Await user approval");
  });
});
