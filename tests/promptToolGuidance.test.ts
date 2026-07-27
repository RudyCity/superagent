import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("prompt and command guidance", () => {
  it("does not instruct Windows agents to chain commands with &&", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "src/core/config.ts"), "utf-8");
    const configBase = fs.readFileSync(path.resolve(process.cwd(), "src/core/config/base.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");

    expect(config + configBase).not.toContain("Since Git Bash is available, you CAN");
    expect(`${config}\n${configBase}\n${prompts}`).not.toContain("using `run_command` or `bash`");
  });

  it("documents the Windows command separator rule in runtime guidance", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "src/core/config.ts"), "utf-8");
    const configBase = fs.readFileSync(path.resolve(process.cwd(), "src/core/config/base.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");
    const combined = `${config}\n${configBase}\n${prompts}`;

    expect(combined).toContain("PowerShell on Windows");
    expect(combined).toContain("Use \\`run_command\\` for validation commands");
  });

  it("does not reference unsupported prompt tool schemas", () => {
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");

    expect(prompts).not.toContain("'Subagents' array");
    expect(prompts).not.toContain("manage_tasks_bulk");
    expect(prompts).not.toContain("Spawn a 'researcher' subagent to explore the codebase");
  });

  it("keeps prompt hardening guidance aligned", () => {
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");

    expect(prompts).toContain("Target PID ONLY");
    expect(prompts).not.toContain("taskkill /F /IM bun.exe");
    expect(prompts).not.toContain("## Rencana Perubahan");
    expect(prompts).toContain("Plain terminal text only");
    expect(prompts).toContain("spawn 'researcher' for broad");
  });

  it("documents tool failure recovery guidance", () => {
    const configBase = fs.readFileSync(path.resolve(process.cwd(), "src/core/config/base.ts"), "utf-8");
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");

    expect(configBase).toContain("Do not repeat stale exact-match edits");
    expect(configBase).toContain("Pass one path per call");
    expect(configBase).toContain("Use action 'report' (singular), not 'reports'");
    expect(configBase).toContain("npm.cmd");

    expect(prompts).toContain("Re-read range → line-range replace. Avoid stale edits.");
    expect(prompts).toContain("DIRTY_WORKSPACE");
  });

  it("requires bulk and parallel tool guidance in prompts", () => {
    const prompts = fs.readFileSync(path.resolve(process.cwd(), "src/core/prompts.ts"), "utf-8");
    const base = fs.readFileSync(path.resolve(process.cwd(), "src/core/config/base.ts"), "utf-8");

    expect(prompts).toContain("BATCH_OPS: Consolidate parallel ops in single turn");
    expect(prompts).toContain("concurrent calls for independent");
    expect(base).toContain("Plan batches upfront");
    expect(base).toContain("conversationIds");
  });

  it("requires single-agent cognitive scale-up guidelines in skills config", () => {
    const skillsConfig = fs.readFileSync(path.resolve(process.cwd(), "src/core/config/skills.ts"), "utf-8");

    expect(skillsConfig).toContain("single-agent-cognitive-scaleup");
  });
});
