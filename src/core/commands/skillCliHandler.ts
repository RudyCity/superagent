import path from "path";
import { getInstalledSkills, filterSkillsByMode } from "../config/skills.js";
import { synthesizeSkill, listSynthesizedSkills } from "../skills/skillSynthesizer.js";

export function printSkillHelp(): void {
  console.log(`
Usage: superagent skill <command> [options]

Commands:
  list, ls                              List all installed and synthesized skills
  stats, metrics                        Show skill usage counts and execution stats
  synth <task_description> [options]    Synthesize a new reusable skill (SKILL.md)
  help                                  Show this help message

Options for synth:
  --name <name>                         Custom kebab-case name for the skill
  --category <category>                 Skill category (e.g. testing, refactor, automation)
  --workspace <path>                    Workspace directory (defaults to current directory)

Examples:
  superagent skill list
  superagent skill stats
  superagent skill synth "Automate SQLite schema migrations and backups" --name sqlite-backup-helper
  superagent skill synth "Review pull requests and enforce conventional commits" --category review
`);
}

export async function handleSkillCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printSkillHelp();
    process.exit(0);
  }

  if (subcommand === "stats" || subcommand === "metrics") {
    const { getSkillStats } = await import("../skills/skillTracker.js");
    const workspace = process.cwd();
    const stats = getSkillStats(workspace);

    const installedCount = stats.filter(s => s.type === "installed").length;
    const synthCount = stats.filter(s => s.type === "synthesized").length;
    const totalExecutions = stats.reduce((acc, s) => acc + s.executionCount, 0);

    console.log("Superagent Skill Execution Statistics:");
    console.log(`- Installed Skills    : ${installedCount}`);
    console.log(`- Synthesized Skills  : ${synthCount}`);
    console.log(`- Total Skill Usages  : ${totalExecutions}\n`);

    console.log("Top Active / Synthesized Skills:");
    const topSkills = stats.slice(0, 30);
    for (const s of topSkills) {
      const typeTag = s.type === "synthesized" ? "[SYNTH]" : "[BUILTIN]";
      const lastUsedStr = s.lastUsed ? new Date(s.lastUsed).toLocaleDateString() : "Never";
      console.log(`- ${typeTag} ${s.name.padEnd(30)} (used: ${s.executionCount}x | last: ${lastUsedStr})`);
    }

    process.exit(0);
  }

  if (subcommand === "list" || subcommand === "ls") {
    const workspace = process.cwd();
    const installed = filterSkillsByMode(getInstalledSkills(), false);
    const synthesized = listSynthesizedSkills(workspace);

    console.log(`Installed Agent Skills (${installed.length}):`);
    for (const s of installed) {
      console.log(`- ${s.name}: ${s.description.slice(0, 80)}`);
    }

    if (synthesized.length > 0) {
      console.log(`\nSynthesized Workspace Skills (${synthesized.length}):`);
      for (const s of synthesized) {
        console.log(`- ${s.name}: ${s.description.slice(0, 80)}`);
        console.log(`  Path: ${s.path}`);
      }
    }

    process.exit(0);
  }

  if (subcommand === "synth" || subcommand === "synthesize") {
    const nameIndex = args.indexOf("--name");
    const catIndex = args.indexOf("--category");
    const wsIndex = args.indexOf("--workspace");

    const skillName = nameIndex !== -1 && args[nameIndex + 1] ? args[nameIndex + 1] : undefined;
    const category = catIndex !== -1 && args[catIndex + 1] ? args[catIndex + 1] : undefined;
    const workspace = wsIndex !== -1 && args[wsIndex + 1] ? args[wsIndex + 1] : process.cwd();

    // Collect description words from args[1] until next flag
    const descParts: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        i++; // Skip the flag value
        continue;
      }
      descParts.push(args[i]);
    }
    const taskDescription = descParts.join(" ").trim();

    if (!taskDescription) {
      console.log("Error: Missing task description for skill synthesis.");
      console.log("Usage: superagent skill synth <task_description> [--name <name>] [--category <cat>]");
      console.log("Example: superagent skill synth \"Run unit tests and linting on pre-commit\" --name pre-commit-runner");
      process.exit(1);
    }

    console.log(`Synthesizing skill from workflow description: "${taskDescription}"...`);
    try {
      const skill = await synthesizeSkill({
        taskDescription,
        workspace,
        skillName,
        category,
      });

      console.log(`\nSuccessfully synthesized skill: ${skill.name}`);
      console.log(`- File Path   : ${skill.filePath}`);
      console.log(`- Category    : ${skill.category}`);
      console.log(`- Description : ${skill.description}`);
      console.log("\nThe skill is now active and immediately discoverable by Superagent.");
      process.exit(0);
    } catch (err: any) {
      console.log(`Skill synthesis failed: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`Unknown skill subcommand: "${subcommand}"`);
  printSkillHelp();
  process.exit(1);
}
