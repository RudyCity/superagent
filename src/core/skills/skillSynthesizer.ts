import fs from "fs";
import path from "path";
import {
  SkillSynthesisRequest,
  SkillTrajectoryStep,
  ExtractedWorkflowPatterns,
  SkillEvidenceMetadata,
  SynthesizedSkill,
  SkillValidationResult,
  SynthesizedSkillSummary
} from "./synthesizerTypes.js";
import { createSkillCandidate } from "./skillLifecycle.js";

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractPatterns(steps: SkillTrajectoryStep[] = []): ExtractedWorkflowPatterns {
  // Trajectories can be supplied by external tools. Bound CPU and retained data
  // before processing so a huge transcript cannot create an oversized candidate.
  const boundedSteps = Array.isArray(steps) ? steps.slice(0, 300) : [];
  const toolsSet = new Set<string>();
  const commandPatterns: string[] = [];
  const recoveredErrors: string[] = [];
  const keySteps: string[] = [];

  let lastError: string | null = null;

  for (let i = 0; i < boundedSteps.length; i++) {
    const step = boundedSteps[i];
    if (step.toolName) {
      const safeTool = sanitizeToolName(step.toolName);
      if (safeTool) {
        if (toolsSet.size < 50) toolsSet.add(safeTool);
        if (
          (safeTool === "run_command" || safeTool === "bash" || safeTool === "run_background_process") &&
          step.toolArgs?.CommandLine
        ) {
          const cmd = String(step.toolArgs.CommandLine).slice(0, 500).trim();
          const baseCmd = cmd.split(/\s+/)[0].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 50);
          if (baseCmd && commandPatterns.length < 50 && !commandPatterns.includes(baseCmd)) {
            commandPatterns.push(baseCmd);
          }
        }
      }
    }

    // Check for error in step
    const rawErr = step.error || (typeof step.toolResult === "string" && step.toolResult.includes("Error:") ? step.toolResult : null);
    if (rawErr) {
      const errText = sanitizeOneLineText(rawErr, 150);
      lastError = errText;
    } else if (lastError && step.role === "tool" && !rawErr) {
      const safeTool = sanitizeToolName(step.toolName) || "action";
      if (recoveredErrors.length < 20) recoveredErrors.push(`Encountered "${lastError}" then resolved using tool "${safeTool}"`);
      lastError = null;
    }

    if (step.role === "assistant" && step.content) {
      const normalizedContent = String(step.content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const firstLine = sanitizeBodyStep(normalizedContent.split("\n")[0]);
      if (keySteps.length < 10 && firstLine.length > 5 && firstLine.length < 120 && !keySteps.includes(firstLine)) {
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

function sanitizeName(value: unknown): string {
  const normalized = toKebabCase(String(value ?? "").slice(0, 320)).slice(0, 80);
  return normalized || "synthesized-skill";
}

function sanitizeCategory(value: unknown): string {
  const normalized = toKebabCase(String(value ?? "").slice(0, 320)).slice(0, 60);
  return normalized || "automation";
}

function sanitizeOneLineText(value: unknown, limit = 500): string {
  let text = String(value ?? "")
    .replace(/[\r\n\x00-\x1f\x7f\u0085\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/#{1,6}\s*/g, "");
  text = text.replace(/-{3,}/g, "--");
  return text.slice(0, limit);
}

function safeFrontmatterScalar(value: unknown, limit: number = 240): string {
  const text = sanitizeOneLineText(value, limit)
    .replace(/:/g, " - ")
    .replace(/^[-*•\s]+/, "");
  return text.slice(0, limit);
}

function sanitizeBodyStep(value: unknown, limit = 200): string {
  let step = sanitizeOneLineText(value, limit);
  step = step.replace(/^(\d+[\.\)]\s*|[-*#•]+\s*)+/, "");
  step = step.replace(/#{1,6}\s*/g, "");
  return step.trim();
}

function sanitizeToolName(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\x00-\x1f\x7f\u0085\u2028\u2029`]+/g, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 60);
}

function sanitizeErrorItem(value: unknown, limit = 150): string {
  let err = sanitizeOneLineText(value, limit);
  err = err.replace(/^(\d+[\.\)]\s*|[-*#•]+\s*)+/, "");
  return err.trim();
}

function sanitizeMetadataList(values: unknown, limit = 8): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(0, limit).map(value => sanitizeBodyStep(value, 220)).filter(value => value.length >= 3))];
}

function renderMetadataSection(title: string, values: string[]): string {
  return values.length ? `## ${title}\n${values.map(value => `- ${value}`).join("\n")}\n\n` : "";
}

export function generateSkillMarkdown(
  name: string,
  description: string,
  patterns: ExtractedWorkflowPatterns,
  taskDescription: string,
  category: string = "automation",
  metadata?: SkillEvidenceMetadata
): string {
  const safeName = sanitizeName(name);
  const title = safeName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const safeDescription = safeFrontmatterScalar(description) || "Automated workflow";
  const safeCategory = sanitizeCategory(category);
  const safeTaskDescription = sanitizeOneLineText(taskDescription, 500) || "Automated workflow";

  const sanitizedSteps = (patterns.keySteps || [])
    .slice(0, 20)
    .map((step) => sanitizeBodyStep(step))
    .filter((step) => step.length >= 3);

  const stepsList =
    sanitizedSteps.length > 0
      ? sanitizedSteps.map((step, idx) => `${idx + 1}. ${step}`).join("\n")
      : `1. Inspect workspace configuration and relevant code files.\n2. Execute necessary changes and validation checks.\n3. Verify results and ensure zero regressions.`;

  const sanitizedTools = [
    ...new Set(
      (patterns.toolsUsed || [])
        .map(sanitizeToolName)
        .filter((t) => Boolean(t) && t.length > 0)
    )
  ].slice(0, 30);

  const toolsList =
    sanitizedTools.length > 0
      ? sanitizedTools.map((t) => `- \`${t}\``).join("\n")
      : "- `view_file`\n- `run_command`\n- `replace_file_content`";

  const sanitizedErrors = (patterns.recoveredErrors || [])
    .slice(0, 15)
    .map((e) => sanitizeErrorItem(e))
    .filter((e) => e.length >= 3);

  const lessonsSection =
    sanitizedErrors.length > 0
      ? `## Lessons Learned & Error Recovery\n${sanitizedErrors.map((e) => `- ${e}`).join("\n")}\n\n`
      : "";
  const applicabilitySection = renderMetadataSection("Applicability", sanitizeMetadataList(metadata?.applicability));
  const preconditionsSection = renderMetadataSection("Preconditions", sanitizeMetadataList(metadata?.preconditions));
  const expectedOutputsSection = renderMetadataSection("Expected Outputs", sanitizeMetadataList(metadata?.expectedOutputs));
  const verificationSteps = sanitizeMetadataList(metadata?.verificationSteps);
  const verificationSection = verificationSteps.length
    ? renderMetadataSection("Verification Protocol", verificationSteps)
    : "";
  const limitationsSection = renderMetadataSection("Known Limitations", sanitizeMetadataList(metadata?.knownLimitations));
  const riskText = metadata?.riskClassification && ["low", "medium", "high"].includes(metadata.riskClassification)
    ? metadata.riskClassification : "unclassified";
  const riskSection = `## Risk Classification\n${riskText}; owner review and existing permissions are still required.\n\n`;

  return `---
name: ${safeName}
description: ${safeDescription}
category: ${safeCategory}
---

# ${title}

## Overview
Automated skill synthesized from successful resolution of:
"${safeTaskDescription}"

## When to Use
Use this skill when handling tasks that match:
- ${safeTaskDescription}
- Automated workflows requiring ${sanitizedTools.join(", ") || "targeted tooling"}

## Step-by-Step Workflow
${stepsList}

${applicabilitySection}${preconditionsSection}${expectedOutputsSection}${riskSection}## Key Tools & Dependencies
${toolsList}

${lessonsSection}${limitationsSection}${verificationSection || "## Verification Protocol\n1. Run relevant automated test suites to confirm correctness.\n2. Build the project using the standard build command to check for compile errors.\n3. Validate generated or modified files and report any uncommitted changes.\n\n"}
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
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nameVal)) {
        errors.push(`Skill name "${nameVal}" must be kebab-case (lowercase letters, numbers, and hyphens only)`);
      }
    }

    if (!descMatch || !descMatch[1].trim()) {
      errors.push("Frontmatter missing required 'description' field");
    }

    // Disallow unexpected or injected frontmatter fields
    const allowedKeys = new Set(["name", "description", "category", "version", "tools"]);
    const yamlLines = yamlBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const yLine of yamlLines) {
      const keyMatch = yLine.match(/^([a-zA-Z0-9_-]+):/);
      if (keyMatch && !allowedKeys.has(keyMatch[1])) {
        errors.push(`Frontmatter contains unauthorized field "${keyMatch[1]}"`);
      }
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

/** @deprecated Direct skill activation is disabled; synthesizeSkill creates an inactive candidate. */
export async function saveSynthesizedSkill(_skill: SynthesizedSkill, _targetDirectory?: string): Promise<string> {
  throw new Error("Direct skill activation is disabled. Use synthesizeSkill(), evaluate the candidate, and explicitly approve promotion from an interactive CLI.");
}

export async function synthesizeSkill(request: SkillSynthesisRequest): Promise<SynthesizedSkill> {
  const patterns = extractPatterns(request.conversationTrajectory || []);

  const taskDescription = sanitizeOneLineText(request.taskDescription, 1000);
  if (!taskDescription) throw new Error("A non-empty task description is required to synthesize a skill candidate.");
  const rawName = request.skillName || taskDescription.slice(0, 40);
  const name = sanitizeName(rawName);
  const category = sanitizeCategory(request.category || "automation");
  const description = safeFrontmatterScalar(`Automated skill for: ${taskDescription.slice(0, 100)}`);

  const metadata = request.metadata;
  const markdownContent = generateSkillMarkdown(name, description, patterns, taskDescription, category, metadata);

  const validation = validateSkillMarkdown(markdownContent);
  if (!validation.valid) {
    throw new Error(`Skill validation failed: ${validation.errors.join("; ")}`);
  }

  // Synthesis only creates an inactive, versioned candidate. Runtime skill discovery
  // continues to read .agents/skills and only sees explicitly promoted versions.
  const candidate = await createSkillCandidate(request.workspace || process.cwd(), {
    name,
    description,
    category,
    markdownContent,
    extractedPatterns: patterns,
    sourceEvidenceIds: request.evidenceIds,
    metadata,
  });

  const skill: SynthesizedSkill = {
    name,
    description,
    category,
    markdownContent: candidate.markdownContent,
    filePath: candidate.filePath,
    version: candidate.record.version,
    extractedPatterns: patterns
  };

  try {
    const { recordSkillSynthesized } = await import("./skillTracker.js");
    recordSkillSynthesized(skill.name, skill.version, request.workspace || process.cwd());
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
