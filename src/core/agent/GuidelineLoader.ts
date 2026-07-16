import path from "path";
import fs from "fs";
import { getPackageRootDir } from "../config.js";

export class GuidelineLoader {
  private static readonly MAX_SKILL_LINES = 300;
  private static readonly MANDATORY_SKILLS: Array<{ key: string; label: string }> = [
    { key: "karpathy-guidelines",           label: "BEHAVIORAL CODING GUIDELINES (karpathy-guidelines)" },
    { key: "pragmatic-minimalism",          label: "PRAGMATIC MINIMALISM GUIDELINES (pragmatic-minimalism)" },
    { key: "superagent-planning",            label: "PLANNING AND TASK GUIDELINES (superagent-planning)" },
    { key: "writing-plans",                  label: "PLAN WRITING GUIDELINES (writing-plans)" },
    { key: "executing-plans",                label: "PLAN EXECUTION GUIDELINES (executing-plans)" },
    { key: "track-management",               label: "TRACK MANAGEMENT GUIDELINES (track-management)" },
    { key: "systematic-debugging",           label: "DEBUGGING GUIDELINES (systematic-debugging)" },
    { key: "verification-before-completion", label: "VERIFICATION GUIDELINES (verification-before-completion)" },
    { key: "subagent-driven-development",    label: "SUBAGENT DELEGATION GUIDELINES (subagent-driven-development)" },
  ];
  private static readonly MASTER_ONLY_SKILLS: Array<{ key: string; label: string }> = [
    { key: "master-agent-orchestration",     label: "MASTER AGENT ORCHESTRATION GUIDELINES (master-agent-orchestration)" },
  ];

  public static compressTelegraphic(text: string): string {
    let cleaned = text.replace(/<!--[\s\S]*?-->/g, "");
    cleaned = cleaned.replace(/please\s+make\s+sure\s+to\s+/gi, "");
    cleaned = cleaned.replace(/please\s+ensure\s+that\s+you\s+/gi, "");
    cleaned = cleaned.replace(/you\s+should\s+always\s+/gi, "Always ");
    cleaned = cleaned.replace(/in\s+order\s+to\s+/gi, "To ");
    cleaned = cleaned.replace(/it\s+is\s+recommended\s+that\s+you\s+/gi, "Recommend: ");
    cleaned = cleaned.replace(/remember\s+to\s+/gi, "");
    cleaned = cleaned.replace(/it\s+is\s+mandatory\s+to\s+/gi, "Mandatory: ");
    cleaned = cleaned.replace(/note\s+that\s+/gi, "");
    cleaned = cleaned.replace(/do\s+not\s+forget\s+to\s+/gi, "Must ");
    cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, "\n\n");
    return cleaned;
  }

  public static trimSkillContent(raw: string, absolutePath: string): string {
    const minified = this.compressTelegraphic(raw);
    const lines = minified.split("\n");
    let frontmatterEnd = 0;
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
          frontmatterEnd = i + 1;
          break;
        }
      }
    }
    const frontmatter = lines.slice(0, frontmatterEnd);
    const body = lines.slice(frontmatterEnd);
    if (body.length <= this.MAX_SKILL_LINES) {
      return minified;
    }
    const trimmedBody = body.slice(0, this.MAX_SKILL_LINES);
    return [
      ...frontmatter,
      ...trimmedBody,
      "",
      `... [truncated — full content at: ${absolutePath}]`,
    ].join("\n");
  }

  public static buildGuidelines(opts: {
    workingDirectory: string;
    workspaceCacheAgentsMd?: string;
    isSimpleTask: boolean;
    planState: string;
    userQuery?: string;
    tier: string;
    skillContentCache: Map<string, string>;
    preloadedSkillKeys: Set<string>;
  }): string {
    let text = "";
    const searchPaths = [
      path.join(process.cwd(), "agents.md"),
      path.join(opts.workingDirectory, "agents.md"),
    ];
    if (!opts.workspaceCacheAgentsMd) {
      for (const p of searchPaths) {
        if (fs.existsSync(p)) {
          text += `\n\nPROJECT GUIDELINES (agents.md):\n${fs.readFileSync(p, "utf-8")}\n`;
          break;
        }
      }
    }

    const targetSkills: Array<{ key: string; label: string }> = [];
    const karpathy = this.MANDATORY_SKILLS.find(s => s.key === "karpathy-guidelines");
    if (karpathy) targetSkills.push(karpathy);
    const minimalism = this.MANDATORY_SKILLS.find(s => s.key === "pragmatic-minimalism");
    if (minimalism) targetSkills.push(minimalism);

    if (!opts.isSimpleTask && (opts.planState === "IDLE" || opts.planState === "PLANNING_PENDING")) {
      const planning = this.MANDATORY_SKILLS.find(s => s.key === "superagent-planning");
      const writing = this.MANDATORY_SKILLS.find(s => s.key === "writing-plans");
      if (planning) targetSkills.push(planning);
      if (writing) targetSkills.push(writing);
    }

    if (!opts.isSimpleTask && opts.planState === "APPROVED") {
      const executing = this.MANDATORY_SKILLS.find(s => s.key === "executing-plans");
      const subagent = this.MANDATORY_SKILLS.find(s => s.key === "subagent-driven-development");
      const verification = this.MANDATORY_SKILLS.find(s => s.key === "verification-before-completion");
      if (executing) targetSkills.push(executing);
      if (subagent) targetSkills.push(subagent);
      if (verification) targetSkills.push(verification);
    }

    const hasTrackQuery = opts.userQuery && /track|milestone/i.test(opts.userQuery);
    if (hasTrackQuery) {
      const track = this.MANDATORY_SKILLS.find(s => s.key === "track-management");
      if (track) targetSkills.push(track);
    }

    const hasDebugQuery = opts.userQuery && /debug|error|fail|bug|crash|incorrect|fix|issue|broken|slow|diagnose/i.test(opts.userQuery);
    if (hasDebugQuery) {
      const debugging = this.MANDATORY_SKILLS.find(s => s.key === "systematic-debugging");
      if (debugging) targetSkills.push(debugging);
    }

    if (opts.tier === "master") {
      const orchestration = this.MASTER_ONLY_SKILLS.find(s => s.key === "master-agent-orchestration");
      if (orchestration) targetSkills.push(orchestration);
    }

    opts.preloadedSkillKeys.clear();

    for (const skill of targetSkills) {
      let trimmedContent = opts.skillContentCache.get(skill.key) || "";
      if (!trimmedContent) {
        const candidatePaths = [
          path.join(process.cwd(), ".agents", "skills", skill.key, "SKILL.md"),
          path.join(opts.workingDirectory, ".agents", "skills", skill.key, "SKILL.md"),
          path.join(getPackageRootDir(), ".agents", "skills", skill.key, "SKILL.md"),
        ];
        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            const rawContent = fs.readFileSync(p, "utf-8");
            trimmedContent = this.trimSkillContent(rawContent, p);
            opts.skillContentCache.set(skill.key, trimmedContent);
            break;
          }
        }
      }
      if (trimmedContent) {
        text += `\n\n${skill.label}:\n${trimmedContent}\n`;
        opts.preloadedSkillKeys.add(skill.key);
      }
    }
    return text;
  }

  public static markPreloadedSkills(skillsPrompt: string, preloadedSkillKeys: Set<string>): string {
    if (preloadedSkillKeys.size === 0) return skillsPrompt;
    let result = skillsPrompt;
    for (const key of preloadedSkillKeys) {
      const escapedKey = key.replace(/[-]/g, "[-]");
      const regex = new RegExp(`(Instruction File: [^\\n]*${escapedKey}[^\\n]*)`, "gi");
      result = result.replace(regex, `$1 [Content already loaded in context above — no need to re-read]`);
    }
    return result;
  }
}