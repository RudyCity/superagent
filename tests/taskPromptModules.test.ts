import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/tools/helpers.js", () => ({
  resolveWindowsShell: () => ({ isBash: false, shellPath: "powershell.exe" }),
}));

import { getSystemPrompt } from "../src/core/config/base.js";
import {
  MASTER_AGENT_SYSTEM_PROMPT, SUPERAGENT_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPTS,
} from "../src/core/prompts.js";
import {
  BROWSER_TRANSPORT_RULE, BROWSER_TASK_GUIDANCE, PDF_TASK_GUIDANCE, taskPromptModules,
} from "../src/core/agent/TaskPromptModules.js";

describe("context-sensitive SuperAgent prompt optimization", () => {
  it("keeps safe cross-domain invariants but avoids unconditional PDF overhead", () => {
    const prompts = [
      getSystemPrompt(),
      MASTER_AGENT_SYSTEM_PROMPT,
      SUPERAGENT_SYSTEM_PROMPT("coder", "main", "D:/project"),
      SUBAGENT_SYSTEM_PROMPTS.coder,
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("PROJECT_COMPLETION_SUMMARY");
      expect(prompt).not.toContain("PDF_SIGNING:");
      expect(prompt).not.toContain("PDF_MUTATIONS:");
    }
    expect(BROWSER_TRANSPORT_RULE).toContain("transport:'delegate'");
    expect(BROWSER_TRANSPORT_RULE).toContain("transport:'managed'");
    expect(getSystemPrompt()).toContain(BROWSER_TRANSPORT_RULE);
  });

  it("inserts PDF instructions for Indonesian and English PDF requests only", () => {
    expect(taskPromptModules("Edit teks dan nama fakultas pada file .pdf")).toContain(PDF_TASK_GUIDANCE);
    expect(taskPromptModules("Run OCR on this scanned PDF")).toContain("PDF_SIGNING");
    expect(taskPromptModules("Tolong ringkas email untuk kolega")).toBe("");
    expect(taskPromptModules("bantu perbaiki TypeScript")).toBe("");
    expect(taskPromptModules("tolong jelaskan kopi french press")).toBe("");
  });

  it("routes existing Chrome through Delegate without automatically launching managed Chrome", () => {
    const prompt = taskPromptModules("akses CDP via Delegate");
    expect(prompt).toContain(BROWSER_TASK_GUIDANCE);
    expect(prompt).toContain("transport:'delegate'");
    expect(prompt).toContain("transport:'managed'");
    expect(prompt).toContain("Do not auto-launch a new Chrome debug profile");
    expect(prompt).not.toContain(PDF_TASK_GUIDANCE);
    expect(SUBAGENT_SYSTEM_PROMPTS["chrome-agent"]).toContain("transport:'delegate'");
  });

  it("loads relevant module on an explicit continuation, not stale unrelated requests", () => {
    expect(taskPromptModules("lanjut", {
      continuationContext: "Tolong edit PDF peminjaman ruang",
    })).toContain(PDF_TASK_GUIDANCE);
    expect(taskPromptModules("lanjut", {
      continuationContext: "Tolong cek Chrome melalui Delegate",
    })).toContain(BROWSER_TASK_GUIDANCE);
    expect(taskPromptModules("Buat daftar belanja kopi", {
      continuationContext: "Cek PDF sebelumnya",
    })).toBe("");
    expect(taskPromptModules("lanjut", { goal: "Audit Chrome CDP" })).toContain(BROWSER_TASK_GUIDANCE);
  });

  it("preserves permission, scope, and destructive-change guards", () => {
    const base = getSystemPrompt();
    const master = MASTER_AGENT_SYSTEM_PROMPT;
    const superagent = SUPERAGENT_SYSTEM_PROMPT("general", "main", "D:/project");
    expect(base).toContain("NO_AUTO_COMMIT");
    expect(base).toContain("SECURITY:");
    expect(master).toContain("User prohibition on new worktrees/branches is binding");
    expect(superagent).toContain("SHARED_FILE_GUARD");
    expect(superagent).toContain("WORKSPACE_LIMIT");
    expect(PDF_TASK_GUIDANCE).toContain("Read permission is not write permission");
    expect(BROWSER_TASK_GUIDANCE).toContain("never disable security");
  });
});
