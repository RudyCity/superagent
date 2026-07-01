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

export function getInstalledSkills(): LoadedSkill[] {
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

  // Precedence order: Workspace local (highest) -> Hooks -> Global -> Package default (lowest)
  const searchDirs = [
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), ".superagent", "skills"),
    path.join(process.cwd(), ".agents", "skills")
  ];

  // Append active internal hooks' skills subdirectories
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

  // Append global and package default directories (lowest precedence)
  searchDirs.push(
    path.join(os.homedir(), ".superagent-r", "skills"),
    path.join(packageRootDir, "skills"),
    path.join(packageRootDir, ".agents", "skills")
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
              // Flat structure: e.g. .agents/skills/fastcontext/SKILL.md
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
      const hasNameDuplicate = skills.some(
        s => s.name.toLowerCase() === name.toLowerCase() &&
             (s.author || "").toLowerCase() === (author || "").toLowerCase()
      );

      if (!hasPathDuplicate && !hasNameDuplicate) {
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

export function loadAgentSkills(subagentType?: string, tier?: string, userQuery?: string): string {
  let skills = getInstalledSkills();
  if (skills.length === 0) {
    return "";
  }

  const normalizeSkillName = (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // Predefined core skills that are always loaded to ensure robust agent operations
  const alwaysIncludeSkills = new Set([
    "getting-started-with-skills",
    "when-stuck-problem-solving-dispatch",
    "remembering-conversations",
    "verification-before-completion",
    "systematic-debugging",
    "root-cause-tracing",
    "karpathy-guidelines",
    "workflow-patterns",
    "superagent-planning",
    "master-agent-orchestration"
  ]);

  // 1. Filter skills based on subagent type
  if (subagentType) {
    const type = subagentType.toLowerCase();
    let keywords: string[] = [];
    if (type === "researcher") {
      keywords = ["research", "search", "literature", "find", "query", "database", "explore", "discover", "recall", "remember", "knowledge", "history", "read", "analyze", "arxiv", "pmc", "pubmed", "science", "uniprot", "pdb", "chembl", "obsidian"];
    } else if (type === "coder") {
      keywords = ["code", "implement", "write", "develop", "create", "tdd", "test", "debug", "fix", "refactor", "migrate", "git", "worktree", "finish", "branch", "deploy", "build", "linter", "style", "patterns", "api", "design", "database", "sql", "postgres", "python", "fastapi", "react", "nextjs", "typescript", "go", "rust", "solidity", "smart contract", "nft", "android", "ios", "mobile", "pre-commit"];
    } else if (type === "reviewer") {
      keywords = ["review", "test", "audit", "verify", "check", "correctness", "lint", "accessibility", "wcag", "screen reader", "e2e", "security", "sast", "threat", "mitigation", "validate", "standards"];
    }

    if (keywords.length > 0) {
      skills = skills.filter(s => {
        const normName = normalizeSkillName(s.name);
        if (alwaysIncludeSkills.has(normName) || normName.includes("getting-started") || normName.includes("when-stuck")) return true;
        const descLower = (s.description || "").toLowerCase();
        return keywords.some(kw => normName.includes(kw) || descLower.includes(kw));
      });
    }
  }

  // 2. Filter skills based on userQuery keywords
  if (userQuery) {
    const stopWords = new Set([
      "and", "the", "for", "use", "any", "our", "you", "with", "are", 
      "not", "but", "can", "this", "that", "how", "what", "why", "who", 
      "has", "had", "have", "been", "was", "were", "should", "would", 
      "could", "about", "your", "them", "they", "their", "from", "into",
      "its", "here", "there", "when", "then", "where", "which",
      "need", "needs", "want", "wants", "check", "checking", "test", 
      "testing", "deploy", "deployment", "project", "code", "codebase", 
      "file", "files", "task", "tasks", "work", "add", "adding", "create", 
      "creating", "make", "making", "build", "building", "run", "running", 
      "execute", "executing", "simple", "complex", "basic", "advanced",
      "please", "help", "with", "show", "get", "set"
    ]);

    const queryLower = userQuery.toLowerCase();
    const queryWords = queryLower
      .split(/[^a-z0-9]+/i)
      .filter(w => w.length >= 3 && !stopWords.has(w));

    if (queryWords.length > 0) {
      skills = skills.filter(s => {
        const normName = normalizeSkillName(s.name);
        if (alwaysIncludeSkills.has(normName)) return true;

        const nameWords = new Set(normName.split(/[^a-z0-9]+/i));
        const descLower = (s.description || "").toLowerCase();
        const descWords = new Set(descLower.split(/[^a-z0-9]+/i));

        return queryWords.some(w => nameWords.has(w) || descWords.has(w));
      });
    }
  }

  let text = "\n\nINSTALLED AGENT SKILLS & MANDATORY DISCOVERY RULES:\n";
  text += "CRITICAL DIRECTIVE: At the very beginning of processing the user's request, you MUST proactively scan the list of installed specialized agent skills below. Note that skills may also be loaded dynamically from active internal hooks (located under `internal-hooks/` or `ih`). If the task or any subtask involves concepts, workflows, platforms, or tools mentioned in a skill's name or description, you MUST immediately read the corresponding instruction file ('SKILL.md') using a file-reading tool (e.g. view_file) using the EXACT absolute path listed in 'Instruction File:' below BEFORE executing commands, writing code, or proposing plans. DO NOT use relative paths (like '.agents/skills/...') if they do not exist in your workspace; always use the absolute paths from this list. Do NOT attempt to guess the workflow or perform it from memory if a relevant skill exists. Always check for relevant skills first.\n\n";
  for (const s of skills) {
    const provider = s.author || "local";
    text += `- **${provider}/${s.name}**: ${s.description}\n  Instruction File: ${s.path}\n`;
  }
  return text;
}

