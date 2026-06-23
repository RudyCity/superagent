import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { getRootConfigDir } from "./paths.js";

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
  author?: string;
}

export function getInstalledSkills(): LoadedSkill[] {
  const skills: LoadedSkill[] = [];
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageRootDir = path.resolve(__dirname, "..", "..", "..");

  const searchDirs = [
    path.join(os.homedir(), ".superagent-r", "skills"),
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), ".superagent", "skills"),
    path.join(process.cwd(), ".agents", "skills"),
    path.join(packageRootDir, "skills"),
    path.join(packageRootDir, ".agents", "skills")
  ];

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            const skillDir = path.join(dir, item.name);
            const skillMdPath = path.join(skillDir, "SKILL.md");
            if (fs.existsSync(skillMdPath)) {
              // Flat structure: e.g. .agents/skills/fastcontext/SKILL.md
              processSkillFile(skillMdPath, item.name, "obra");
            } else {
              // Check for nested structure: e.g. .agents/skills/vercel-labs/find-skills/SKILL.md
              try {
                const subItems = fs.readdirSync(skillDir, { withFileTypes: true });
                for (const subItem of subItems) {
                  if (subItem.isDirectory()) {
                    const subSkillDir = path.join(skillDir, subItem.name);
                    const subSkillMdPath = path.join(subSkillDir, "SKILL.md");
                    if (fs.existsSync(subSkillMdPath)) {
                      processSkillFile(subSkillMdPath, subItem.name, item.name);
                    }
                  }
                }
              } catch (subErr) {
                // Ignore nested folder errors
              }
            }
          }
        }
      } catch (e) {
        // Ignore directory read errors
      }
    }
  }

  function processSkillFile(skillMdPath: string, folderName: string, defaultAuthor: string) {
    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      let name = folderName;
      let description = "No description provided.";
      let author = defaultAuthor;

      // Simple frontmatter parser
      const fmMatch = content.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameMatch = fm.match(/^\s*name:\s*(.*)$/m);
        const descMatch = fm.match(/^\s*description:\s*(.*)$/m);
        const authorMatch = fm.match(/^\s*(author|provider|owner):\s*(.*)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
        if (authorMatch) author = authorMatch[2].trim();
      } else {
        // Fallback to searching first heading
        const headingMatch = content.match(/^#\s*(.*)$/m);
        if (headingMatch) name = headingMatch[1].trim();
      }

      if (!skills.some(s => s.path === skillMdPath)) {
        skills.push({
          name,
          description,
          path: skillMdPath,
          author
        });
      }
    } catch (e) {
      // Ignore parsing errors for individual files
    }
  }

  return skills;
}

export function loadAgentSkills(): string {
  const skills = getInstalledSkills();
  if (skills.length === 0) {
    return "";
  }

  let text = "\n\nINSTALLED AGENT SKILLS & MANDATORY DISCOVERY RULES:\n";
  text += "CRITICAL DIRECTIVE: At the very beginning of processing the user's request, you MUST proactively scan the list of installed specialized agent skills below. If the task or any subtask involves concepts, workflows, platforms, or tools mentioned in a skill's name or description, you MUST immediately read the corresponding instruction file ('SKILL.md') using a file-reading tool (e.g. view_file) to load its complete workflow guidelines and constraints BEFORE executing commands, writing code, or proposing plans. Do NOT attempt to guess the workflow or perform it from memory if a relevant skill exists. Always check for relevant skills first.\n\n";
  for (const s of skills) {
    const provider = s.author || "obra";
    text += `- **${provider}/${s.name}**: ${s.description}\n  Instruction File: ${s.path}\n`;
  }
  return text;
}
