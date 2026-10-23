import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/core/tools/helpers.js", () => ({
  resolveWindowsShell: () => ({ isBash: false, shellPath: "powershell.exe" }),
}));

import { GENERAL_ASSISTANT_IDENTITY } from "../src/core/assistantIdentity.js";
import { getSystemPrompt } from "../src/core/config/base.js";
import { CHROME_EXTENSION_SYSTEM_PROMPT, MASTER_AGENT_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPTS, SUPERAGENT_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { DEFAULT_MUSE_SYSTEM_PROMPT } from "../src/core/remoteAgent/protocol.js";

describe("general-purpose assistant identity", () => {
  it("treats programming as one capability rather than the default task", () => {
    expect(GENERAL_ASSISTANT_IDENTITY).toContain("general-purpose AI assistant");
    expect(GENERAL_ASSISTANT_IDENTITY).toContain("not primarily a programmer");
    expect(GENERAL_ASSISTANT_IDENTITY).toContain("INTENT_ROUTING");
    expect(GENERAL_ASSISTANT_IDENTITY).toContain("Do not force code edits");
  });

  it("keeps ordinary conversation direct but executes explicitly requested actions", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain(GENERAL_ASSISTANT_IDENTITY);
    expect(prompt).toContain("without forced tool calls");
    expect(prompt).toContain("for executable requests");
    expect(prompt).not.toContain("DIRECT_EXECUTION_MANDATE");
    expect(prompt).not.toContain("ANTI_TUTORIAL_MANDATE");
  });

  it("aligns master, worktree, and browser sidepanel prompts", () => {
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain(GENERAL_ASSISTANT_IDENTITY);
    expect(SUPERAGENT_SYSTEM_PROMPT("general", "main", "workspace")).toContain(GENERAL_ASSISTANT_IDENTITY);
    expect(CHROME_EXTENSION_SYSTEM_PROMPT).toContain(GENERAL_ASSISTANT_IDENTITY);
    expect(SUBAGENT_SYSTEM_PROMPTS.coder).toContain("Coder Subagent");
  });

  it("does not reintroduce coding-only identity in Muse, FastPath or MCP", () => {
    expect(DEFAULT_MUSE_SYSTEM_PROMPT).toContain("general-purpose AI reasoning partner");
    const fastPath = readFileSync(new URL("../src/core/agent/FastPath.ts", import.meta.url), "utf8");
    const mcp = readFileSync(new URL("../src/core/mcp/resourcesAndPrompts.ts", import.meta.url), "utf8");
    expect(fastPath).not.toContain("You are a helpful AI coding assistant");
    expect(mcp).not.toContain("You are an autonomous senior software engineering agent");
    expect(mcp).toContain("GENERAL_ASSISTANT_IDENTITY");
  });
});
