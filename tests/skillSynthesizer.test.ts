import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  extractPatterns,
  generateSkillMarkdown,
  validateSkillMarkdown,
  synthesizeSkill,
  listSynthesizedSkills
} from "../src/core/skills/skillSynthesizer.js";
import { synthesizeSkillTool } from "../src/core/tools/synthesizeSkillTool.js";
import { SkillTrajectoryStep } from "../src/core/skills/synthesizerTypes.js";

describe("Skill Synthesizer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `superagent_skill_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("extracts tools, commands, errors, and key steps from trajectory", () => {
    const trajectory: SkillTrajectoryStep[] = [
      { role: "user", content: "Optimize database indexes" },
      {
        role: "assistant",
        content: "Analyze query performance and identify missing indexes",
        toolName: "run_command",
        toolArgs: { CommandLine: "sqlite3 app.db 'EXPLAIN QUERY PLAN SELECT * FROM logs;'" }
      },
      {
        role: "tool",
        toolName: "run_command",
        toolResult: "Error: database is locked"
      },
      {
        role: "assistant",
        content: "Wait for transaction lock to release and retry with journal_mode=WAL",
        toolName: "run_command",
        toolArgs: { CommandLine: "sqlite3 app.db 'PRAGMA journal_mode=WAL;'" }
      },
      {
        role: "tool",
        toolName: "run_command",
        toolResult: "wal"
      },
      {
        role: "assistant",
        content: "Create compound index on timestamp and user_id",
        toolName: "replace_file_content",
        toolArgs: { TargetFile: "schema.sql" }
      }
    ];

    const patterns = extractPatterns(trajectory);
    expect(patterns.toolsUsed).toContain("run_command");
    expect(patterns.toolsUsed).toContain("replace_file_content");
    expect(patterns.commandPatterns).toContain("sqlite3");
    expect(patterns.recoveredErrors.length).toBeGreaterThanOrEqual(1);
    expect(patterns.keySteps.length).toBeGreaterThanOrEqual(2);
  });

  it("generates and validates compliant skill markdown", () => {
    const patterns = {
      toolsUsed: ["view_file", "run_command"],
      commandPatterns: ["git", "bun"],
      recoveredErrors: ["Handled ENOENT by creating target directory"],
      keySteps: ["Check git status", "Run tests", "Commit changes"]
    };

    const markdown = generateSkillMarkdown(
      "git-commit-helper",
      "Automates safe git commits with test verification",
      patterns,
      "Automate git commit flow",
      "workflow"
    );

    const validation = validateSkillMarkdown(markdown);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
    expect(markdown).toContain("name: git-commit-helper");
    expect(markdown).toContain("## Step-by-Step Workflow");
    expect(markdown).toContain("## Verification Protocol");
  });

  it("flags validation errors for invalid frontmatter or structure", () => {
    const invalidNoFrontmatter = "# Some Title\nJust plain markdown";
    const res1 = validateSkillMarkdown(invalidNoFrontmatter);
    expect(res1.valid).toBe(false);
    expect(res1.errors.some((e) => e.includes("frontmatter"))).toBe(true);

    const invalidName = "---\nname: Not Kebab Case!\ndescription: test\n---\n# Title\n## When to Use\n## Step-by-Step Workflow\n";
    const res2 = validateSkillMarkdown(invalidName);
    expect(res2.valid).toBe(false);
    expect(res2.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("synthesizes skill and saves to workspace .agents/skills directory", async () => {
    const synthesized = await synthesizeSkill({
      taskDescription: "Fix React memory leaks in event listeners",
      workspace: tmpDir,
      skillName: "react-event-listener-fixer",
      category: "debugging"
    });

    expect(synthesized.name).toBe("react-event-listener-fixer");
    expect(fs.existsSync(synthesized.filePath)).toBe(true);

    const content = fs.readFileSync(synthesized.filePath, "utf-8");
    expect(content).toContain("name: react-event-listener-fixer");

    const summaries = listSynthesizedSkills(tmpDir);
    expect(summaries.length).toBe(1);
    expect(summaries[0].name).toBe("react-event-listener-fixer");
  });

  it("executes synthesizeSkillTool successfully", async () => {
    const result = await synthesizeSkillTool.execute(
      {
        taskDescription: "Setup Playwright E2E testing suite",
        skillName: "playwright-suite-scaffold"
      },
      tmpDir
    );

    expect(result).toContain("Skill successfully synthesized: playwright-suite-scaffold");
    expect(result).toContain("playwright-suite-scaffold");
    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "playwright-suite-scaffold", "SKILL.md"))).toBe(true);
  });
});
