import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { getRootConfigDir } from "./paths.js";

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
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
              try {
                const content = fs.readFileSync(skillMdPath, "utf-8");
                let name = item.name;
                let description = "No description provided.";
                
                // Simple frontmatter parser
                const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                if (fmMatch) {
                  const fm = fmMatch[1];
                  const nameMatch = fm.match(/^name:\s*(.*)$/m);
                  const descMatch = fm.match(/^description:\s*(.*)$/m);
                  if (nameMatch) name = nameMatch[1].trim();
                  if (descMatch) description = descMatch[1].trim();
                } else {
                  // Fallback to searching first heading or lines
                  const headingMatch = content.match(/^#\s*(.*)$/m);
                  if (headingMatch) name = headingMatch[1].trim();
                }
                
                if (!skills.some(s => s.path === skillMdPath)) {
                  skills.push({
                    name,
                    description,
                    path: skillMdPath
                  });
                }
              } catch (e) {
                // Ignore parsing errors for individual skills
              }
            }
          }
        }
      } catch (e) {
        // Ignore directory read errors
      }
    }
  }
  return skills;
}

export function loadAgentSkills(): string {
  const skills = getInstalledSkills();
  if (skills.length === 0) {
    return "";
  }

  let text = "\n\nINSTALLED AGENT SKILLS:\n";
  text += "The following specialized agent skills are installed. If a user's task matches one of these skills, you should read the specified 'SKILL.md' file using a file read tool to obtain the detailed instructions, and execute any scripts or workflows it specifies:\n";
  for (const s of skills) {
    text += `- **${s.name}**: ${s.description}\n  Instruction File: ${s.path}\n`;
  }
  return text;
}
