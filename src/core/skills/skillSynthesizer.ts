import fs from "fs";
import path from "path";
import {
  SkillSynthesisRequest,
  SkillTrajectoryStep,
  ExtractedWorkflowPatterns,
  SynthesizedSkill,
  SkillValidationResult,
  SynthesizedSkillSummary
} from "./synthesizerTypes.js";
import { clearSkillsCache } from "../config/skills.js";

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractPatterns(steps: SkillTrajectoryStep[] = []): ExtractedWorkflowPatterns {
  const toolsSet = new Set<string>();
  const commandPatterns: string[] = [];
  const recoveredErrors: string[] = [];
  const keySteps: string[] = [];

  let lastError: string | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.toolName) {
      toolsSet.add(step.toolName);
      if (
        (step.toolName === "run_command" || step.toolName === "bash" || step.toolName === "run_background_process") &&
        step.toolArgs?.CommandLine
      ) {
        const cmd = String(step.toolArgs.CommandLine).trim();
        const baseCmd = cmd.split(" ")[0];
        if (!commandPatterns.includes(baseCmd)) {
          commandPatterns.push(baseCmd);
        }
      }
    }

    // Check for error in step
    const errText = step.error || (typeof step.toolResult === "string" && step.toolResult.includes("Error:") ? step.toolResult : null);
    if (errText) {
      lastError = errText.slice(0, 150);
    } else if (lastError && step.role === "tool" && !errText) {
      recoveredErrors.push(`Encountered "${lastError}" then resolved using tool "${step.toolName || "action"}"`);
      lastError = null;
    }

    if (step.role === "assistant" && step.content) {
      const firstLine = step.content.split("\n")[0].replace(/^[-*#\s]+/, "").trim();
      if (firstLine.length > 5 && firstLine.length < 120 && !keySteps.includes(firstLine)) {
        keySteps.push(firstLine);
      }
    }
  }

  return {
    toolsUsed: Array.from(toolsSet),
    commandPatterns,
    recoveredErrors,
    keySteps: keySteps.slice(0, 10)
  };
}

export function generateSkillMarkdown(
  name: string,
  description: string,
  patterns: ExtractedWorkflowPatterns,
  taskDescription: string,
  category: string = "automation"
): string {
  const title = name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const stepsList =
    patterns.keySteps.length > 0
      ? patterns.keySteps.map((step, idx) => `${idx + 1}. ${step}`).join("\n")
      : `1. Inspect workspace configuration and relevant code files.\n2. Execute necessary changes and validation checks.\n3. Verify results and ensure zero regressions.`;

  const toolsList =
    patterns.toolsUsed.length > 0
      ? patterns.toolsUsed.map((t) => `- \`${t}\``).join("\n")
      : "- `view_file`\n- `run_command`\n- `replace_file_content`";

  const lessonsSection =
    patterns.recoveredErrors.length > 0
      ? `## Lessons Learned & Error Recovery\n${patterns.recoveredErrors.map((e) => `- ${e}`).join("\n")}\n\n`
      : "";

  return `---
name: ${name}
description: ${description}
category: ${category}
---

# ${title}

## Overview
Automated skill synthesized from successful resolution of:
"${taskDescription}"

## When to Use
Use this skill when handling tasks that match:
- ${taskDescription}
- Automated workflows requiring ${patterns.toolsUsed.join(", ") || "targeted tooling"}

## Step-by-Step Workflow
${stepsList}

## Key Tools & Dependencies
${toolsList}

${lessonsSection}## Verification Protocol
1. Run relevant automated test suites to confirm correctness.
2. Build the project using the standard build command to check for compile errors.
3. Validate that all generated or modified files are cleanly committed.
`;
}

export function validateSkillMarkdown(content: string): SkillValidationResult {
  const errors: string[] = [];
  const lines = content.split("\n");

  if (lines.length > 1000) {
    errors.push(`Skill content exceeds 1000 lines (${lines.length} lines)`);
  }

  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    errors.push("Missing YAML frontmatter (must start with '---' and end with '---')");
  } else {
    const yamlBody = frontmatterMatch[1];
    const nameMatch = yamlBody.match(/^name:\s*(.+)$/m);
    const descMatch = yamlBody.match(/^description:\s*(.+)$/m);

    if (!nameMatch || !nameMatch[1].trim()) {
      errors.push("Frontmatter missing required 'name' field");
    } else {
      const nameVal = nameMatch[1].trim();
      if (!/^[a-z0-9-]+$/.test(nameVal)) {
        errors.push(`Skill name "${nameVal}" must be kebab-case (lowercase letters, numbers, and hyphens only)`);
      }
    }

    if (!descMatch || !descMatch[1].trim()) {
      errors.push("Frontmatter missing required 'description' field");
    }
  }

  if (!content.includes("# ")) {
    errors.push("Skill missing main markdown header (# Title)");
  }
  if (!content.includes("## When to Use")) {
    errors.push("Skill missing '## When to Use' section");
  }
  if (!content.includes("## Step-by-Step Workflow")) {
    errors.push("Skill missing '## Step-by-Step Workflow' section");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export async function saveSynthesizedSkill(
  skill: SynthesizedSkill,
  targetDirectory?: string
): Promise<string> {
  const dir = targetDirectory || path.join(process.cwd(), ".agents", "skills", skill.name);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, "SKILL.md");
  fs.writeFileSync(filePath, skill.markdownContent, "utf-8");

  // Invalidate in-memory skills cache so the new skill is immediately loaded
  try {
    clearSkillsCache();
  } catch {}

  return filePath;
}

export async function synthesizeSkill(request: SkillSynthesisRequest): Promise<SynthesizedSkill> {
  const patterns = extractPatterns(request.conversationTrajectory || []);

  const rawName = request.skillName || request.taskDescription.slice(0, 40);
  const name = toKebabCase(rawName) || `synthesized-skill-${Date.now()}`;
  const category = request.category || "automation";
  const description = `Automated skill for: ${request.taskDescription.slice(0, 100)}`;

  const markdownContent = generateSkillMarkdown(name, description, patterns, request.taskDescription, category);

  const validation = validateSkillMarkdown(markdownContent);
  if (!validation.valid) {
    throw new Error(`Skill validation failed: ${validation.errors.join("; ")}`);
  }

  const targetDir = request.targetDir || path.join(request.workspace || process.cwd(), ".agents", "skills", name);
  const filePath = path.join(targetDir, "SKILL.md");

  const skill: SynthesizedSkill = {
    name,
    description,
    category,
    markdownContent,
    filePath,
    extractedPatterns: patterns
  };

  await saveSynthesizedSkill(skill, targetDir);

  try {
    const { recordSkillSynthesized } = await import("./skillTracker.js");
    recordSkillSynthesized(skill.name);
  } catch {}

  return skill;
}

export function listSynthesizedSkills(workspace: string = process.cwd()): SynthesizedSkillSummary[] {
  const skillsDir = path.join(workspace, ".agents", "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const summaries: SynthesizedSkillSummary[] = [];
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        const stat = fs.statSync(skillPath);
        const content = fs.readFileSync(skillPath, "utf-8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        summaries.push({
          name: entry.name,
          description: descMatch ? descMatch[1].trim() : "Custom synthesized skill",
          path: skillPath,
          createdAt: stat.birthtimeMs || stat.mtimeMs
        });
      }
    }
  } catch {}
  return summaries;
}
