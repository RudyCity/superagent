import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { getRootConfigDir, getPackageRootDir } from "./paths.js";

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  if (os.platform() === "win32") {
    return resolved.toLowerCase().replace(/\\/g, "/");
  }
  return resolved.replace(/\\/g, "/");
}

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
  author?: string;
}

const OBRA_SKILLS = new Set([
  "brainstorming-ideas-into-designs",
  "code-review-reception",
  "collision-zone-thinking",
  "condition-based-waiting",
  "defense-in-depth-validation",
  "dispatching-parallel-agents",
  "executing-plans",
  "find-skills",
  "finishing-a-development-branch",
  "gardening-skills-wiki",
  "getting-started-with-skills",
  "inversion-exercise",
  "meta-pattern-recognition",
  "preserving-productive-tensions",
  "pulling-updates-from-skills-repository",
  "remembering-conversations",
  "requesting-code-review",
  "root-cause-tracing",
  "scale-game",
  "sharing-skills",
  "simplification-cascades",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development-tdd",
  "testing-anti-patterns",
  "testing-skills-with-subagents",
  "tracing-knowledge-lineages",
  "using-git-worktrees",
  "verification-before-completion",
  "when-stuck-problem-solving-dispatch",
  "writing-plans",
  "writing-skills"
]);

let cachedSkills: LoadedSkill[] | null = null;
let lastSkillsFetchTime = 0;
const SKILLS_CACHE_TTL_MS = 5000;

export function clearSkillsCache(): void {
  cachedSkills = null;
  lastSkillsFetchTime = 0;
}

export function getInstalledSkills(): LoadedSkill[] {
  const isTesting = process.env.VITEST === "true";
  const now = Date.now();
  if (!isTesting && cachedSkills && (now - lastSkillsFetchTime < SKILLS_CACHE_TTL_MS)) {
    return cachedSkills;
  }

  const skills: LoadedSkill[] = [];
  const packageRootDir = getPackageRootDir();

  // Load skills-lock.json if available to map authors/providers
  const lockMap = new Map<string, string>();
  const possibleLockPaths = [
    path.join(process.cwd(), "skills-lock.json"),
    path.join(packageRootDir, "skills-lock.json")
  ];
  for (const lockPath of possibleLockPaths) {
    if (fs.existsSync(lockPath)) {
      try {
        const lockContent = fs.readFileSync(lockPath, "utf-8");
        const lockData = JSON.parse(lockContent);
        if (lockData && lockData.skills) {
          for (const [k, v] of Object.entries(lockData.skills)) {
            if (v && typeof v === "object" && "source" in v && typeof v.source === "string") {
              const sourceStr = v.source as string;
              const resolvedAuthor = sourceStr.includes("/") ? sourceStr.split("/")[0] : sourceStr;
              const keyKebab = k.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
              lockMap.set(keyKebab, resolvedAuthor);
              if ("skillPath" in v && typeof v.skillPath === "string") {
                const pathBase = path.basename(path.dirname(v.skillPath as string)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
                lockMap.set(pathBase, resolvedAuthor);
              }
            }
          }
        }
        break; // Successfully loaded one
      } catch (err) {
        // Ignore JSON or read errors
      }
    }
  }

  // Precedence order: Package built-in (base/lowest) -> Global -> Hooks -> Workspace local (highest/overrides)
  // Skills are deduplicated by name: first occurrence wins, so higher-priority dirs are appended LAST.
  const searchDirs: string[] = [
    path.join(packageRootDir, ".agents", "skills"),
    path.join(packageRootDir, "skills"),
    path.join(os.homedir(), ".superagent-r", "skills"),
  ];

  // Append active internal hooks' skills subdirectories (above global, below workspace)
  const hooksRoot = path.join(process.cwd(), "internal-hooks");
  if (fs.existsSync(hooksRoot)) {
    try {
      const projectPath = process.cwd();
      let activeHooks: string[] | null = null;
      const configMapPath = path.join(os.homedir(), ".superagent-r", "model-config.json");
      if (fs.existsSync(configMapPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configMapPath, "utf-8"));
          activeHooks = config.activeHooks?.[projectPath] || null;
        } catch {}
      }

      const items = fs.readdirSync(hooksRoot, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const isActive = activeHooks === null || activeHooks.includes(item.name);
          if (isActive) {
            const hookAgentsSkillsDir = path.join(hooksRoot, item.name, ".agents", "skills");
            if (fs.existsSync(hookAgentsSkillsDir)) {
              searchDirs.push(hookAgentsSkillsDir);
            }
            const hookSkillsDir = path.join(hooksRoot, item.name, "skills");
            if (fs.existsSync(hookSkillsDir)) {
              searchDirs.push(hookSkillsDir);
            }
          }
        }
      }
    } catch {}
  }

  // Workspace-local directories have highest precedence — appended last so they override duplicates
  searchDirs.push(
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), ".superagent", "skills"),
    path.join(process.cwd(), ".agents", "skills")
  );

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            const skillDir = path.join(dir, item.name);
            const skillMdPath = path.join(skillDir, "SKILL.md");
            if (fs.existsSync(skillMdPath)) {
              // Flat structure: e.g. .agents/skills/writing-plans/SKILL.md
              processSkillFile(skillMdPath, item.name, "local");
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
      let hasAuthorInFm = false;
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameMatch = fm.match(/^\s*name:\s*(.*)$/m);
        const descMatch = fm.match(/^\s*description:\s*(.*)$/m);
        const authorMatch = fm.match(/^\s*(author|provider|owner):\s*(.*)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
        if (authorMatch) {
          author = authorMatch[2].trim();
          hasAuthorInFm = true;
        }
      } else {
        // Fallback to searching first heading
        const headingMatch = content.match(/^#\s*(.*)$/m);
        if (headingMatch) name = headingMatch[1].trim();
      }

      // Resolve author from lockfile if not specified in frontmatter
      if (!hasAuthorInFm) {
        const folderKebab = folderName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const nameKebab = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const lockAuthor = lockMap.get(folderKebab) || lockMap.get(nameKebab);
        if (lockAuthor) {
          author = lockAuthor;
        } else if (OBRA_SKILLS.has(folderName)) {
          author = "obra";
        }
      }

      const normalizedPath = normalizePath(skillMdPath);
      const hasPathDuplicate = skills.some(s => normalizePath(s.path) === normalizedPath);
      if (hasPathDuplicate) return; // exact same file — skip

      // Replace same-named skill (later/higher-priority dirs override earlier ones)
      const existingIndex = skills.findIndex(
        s => s.name.toLowerCase() === name.toLowerCase() &&
             (s.author || "").toLowerCase() === (author || "").toLowerCase()
      );

      const entry = { name, description, path: skillMdPath, author };
      if (existingIndex !== -1) {
        skills[existingIndex] = entry; // project-local overrides package version
      } else {
        skills.push(entry);
      }
    } catch (e) {
      // Ignore parsing errors for individual files
    }
  }

  if (!isTesting) {
    cachedSkills = skills;
    lastSkillsFetchTime = now;
  }

  return skills;
}

export function loadAgentSkills(subagentType?: string, tier?: string, userQuery?: string, isMultiAgent?: boolean): string {
  // Option 2: Return a concise general instruction prompt about searching and reading skills in the workspace,
  // instead of listing all of them, to optimize token usage.
  return `

INSTALLED AGENT SKILLS & MANDATORY DISCOVERY RULES:
CRITICAL: Specialized skills (workflows, platforms, tools) are installed across multiple locations.
You MUST use the \`get_skills\` tool to search or list installed skills.
Before starting any coding, plan, or command, check if a relevant skill exists by calling \`get_skills\`. If a relevant skill exists, you MUST read its \`SKILL.md\` using the exact absolute path before taking action. Do not guess or execute from memory.
IMPORTANT: If no matching skills are found, proceed directly with your task. Do NOT repeatedly execute filesystem search or directory listing commands if no skills are present.`;
}

