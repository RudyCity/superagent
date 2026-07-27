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

// OPT-4: Helper extracted, eliminates 3+ duplicate regex chains
function toKebabCase(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// OPT-2: LockMap cache with 60s TTL — avoids re-reading skills-lock.json every 5s
let cachedLockMap: Map<string, string> | null = null;
let lastLockMapFetchTime = 0;
const LOCKMAP_CACHE_TTL_MS = 60000;

function getLockMap(packageRootDir: string): Map<string, string> {
  const now = Date.now();
  if (cachedLockMap && (now - lastLockMapFetchTime < LOCKMAP_CACHE_TTL_MS)) {
    return cachedLockMap;
  }

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
              lockMap.set(toKebabCase(k), resolvedAuthor);
              if ("skillPath" in v && typeof v.skillPath === "string") {
                lockMap.set(
                  toKebabCase(path.basename(path.dirname(v.skillPath as string))),
                  resolvedAuthor
                );
              }
            }
          }
        }
        break;
      } catch { /* ignore JSON errors */ }
    }
  }

  cachedLockMap = lockMap;
  lastLockMapFetchTime = now;
  return lockMap;
}

// OPT-3: processSkillFile extracted to module scope — no longer recreated on every call
function processSkillFile(
  skillMdPath: string,
  folderName: string,
  defaultAuthor: string,
  skills: LoadedSkill[],
  lockMap: Map<string, string>
): void {
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    let name = folderName;
    let description = "No description provided.";
    let author = defaultAuthor;

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
      const headingMatch = content.match(/^#\s*(.*)$/m);
      if (headingMatch) name = headingMatch[1].trim();
    }

    if (!hasAuthorInFm) {
      const folderKebab = toKebabCase(folderName);
      const nameKebab = toKebabCase(name);
      const lockAuthor = lockMap.get(folderKebab) || lockMap.get(nameKebab);
      if (lockAuthor) {
        author = lockAuthor;
      } else if (OBRA_SKILLS.has(folderName)) {
        author = "obra";
      }
    }

    const normalizedPath = normalizePath(skillMdPath);
    if (skills.some(s => normalizePath(s.path) === normalizedPath)) return;

    const existingIndex = skills.findIndex(
      s => s.name.toLowerCase() === name.toLowerCase() &&
           (s.author || "").toLowerCase() === (author || "").toLowerCase()
    );

    const entry = { name, description, path: skillMdPath, author };
    if (existingIndex !== -1) {
      skills[existingIndex] = entry;
    } else {
      skills.push(entry);
    }
  } catch { /* ignore individual file errors */ }
}

// OPT-1: Combined flat+nested scan in single pass per directory
function scanSkillDirectory(dir: string, skills: LoadedSkill[], lockMap: Map<string, string>): void {
  if (!fs.existsSync(dir)) return;
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const skillDir = path.join(dir, item.name);

      // Flat: item/SKILL.md
      const flatMdPath = path.join(skillDir, "SKILL.md");
      if (fs.existsSync(flatMdPath)) {
        processSkillFile(flatMdPath, item.name, "local", skills, lockMap);
        continue;
      }

      // Nested: item/subdir/SKILL.md
      try {
        const subItems = fs.readdirSync(skillDir, { withFileTypes: true });
        for (const subItem of subItems) {
          if (subItem.isDirectory()) {
            const nestedMdPath = path.join(skillDir, subItem.name, "SKILL.md");
            if (fs.existsSync(nestedMdPath)) {
              processSkillFile(nestedMdPath, subItem.name, item.name, skills, lockMap);
            }
          }
        }
      } catch { /* ignore nested read errors */ }
    }
  } catch { /* ignore dir read errors */ }
}

// OPT-5: Static base dirs cached once — avoids recomputing packageRoot + homedir paths
let cachedBaseSearchDirs: string[] | null = null;

function getBaseSearchDirs(packageRootDir: string): string[] {
  if (cachedBaseSearchDirs) return cachedBaseSearchDirs;

  cachedBaseSearchDirs = [
    path.join(packageRootDir, ".agents", "skills"),
    path.join(packageRootDir, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".superagent-r", "skills"),
  ];
  return cachedBaseSearchDirs;
}

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
  const lockMap = getLockMap(packageRootDir);

  // Fresh copy prevents base array mutation by hooks/workspace pushes
  const searchDirs = [...getBaseSearchDirs(packageRootDir)];

  // Append active internal hooks subdirectories
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
        if (!item.isDirectory()) continue;
        const isActive = activeHooks === null || activeHooks.includes(item.name);
        if (!isActive) continue;

        const hookAgentsSkillsDir = path.join(hooksRoot, item.name, ".agents", "skills");
        if (fs.existsSync(hookAgentsSkillsDir)) searchDirs.push(hookAgentsSkillsDir);

        const hookSkillsDir = path.join(hooksRoot, item.name, "skills");
        if (fs.existsSync(hookSkillsDir)) searchDirs.push(hookSkillsDir);
      }
    } catch {}
  }

  // Workspace-local dirs (highest priority)
  searchDirs.push(
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), ".superagent", "skills"),
    path.join(process.cwd(), ".agents", "skills"),
    path.join(process.cwd(), ".claude", "skills")
  );

  for (const dir of searchDirs) {
    scanSkillDirectory(dir, skills, lockMap);
  }

  if (!isTesting) {
    cachedSkills = skills;
    lastSkillsFetchTime = now;
  }

  return skills;
}

export function loadAgentSkills(subagentType?: string, tier?: string, userQuery?: string, isMultiAgent?: boolean): string {
  return `

# SKILL DISCOVERY
- RULE: call get_skills(query) BEFORE coding, planning, or executing any command.
  - EXCEPT: Do NOT call get_skills(query) or use_skill() if the current mode is 'ask' (lightweight Q&A) or if the relevant skill is already preloaded/defined in your system prompt context (e.g. karpathy-guidelines, systematic-debugging, superagent-planning, writing-plans, executing-plans, track-management, subagent-driven-development, verification-before-completion, master-agent-orchestration, single-agent-cognitive-scaleup).
- QUERY CONSTRUCTION (critical for accurate results):
  - Build query from: [task_type] + [technology] + [goal]
  - Examples:
    - "debug TypeScript compilation error in React component"
    - "write TDD tests for async Node.js service"
    - "deploy Next.js app to Vercel with environment variables"
    - "refactor PostgreSQL schema for performance"
    - "plan implementation for multi-agent orchestration feature"
  - NEVER call get_skills() with an empty or single-word query.
  - Use the user's actual request as the basis for the query — include tech stack, action, and goal.
- LEARNING & PROBLEM DISCOVERY:
  - If exploring/learning a new codebase or workspace: call get_skills(query) with a query containing "learn codebase architecture design technology" to find codebase structure, design systems, or coding standards.
  - If investigating/solving a new problem, bug, or exception: call get_skills(query) with a query detailing the issue, technology, and action words (e.g. "debug", "diagnose", "troubleshoot") to retrieve debugging and validation guides.
- logic:
  if current_mode_is_ask:
      Do NOT call get_skills() or use_skill().
  elif skill_is_already_preloaded_in_prompt:
      use the preloaded content directly. Do NOT call get_skills() or use_skill().
  elif skill_found:
      use skill via use_skill(skillName/path) -> follow instructions exactly. Do NOT guess/execute from memory.
  else:
      proceed directly without searching further.
- LIMIT: call get_skills() once per task. Do NOT retry with different queries if results are returned.`;
}
