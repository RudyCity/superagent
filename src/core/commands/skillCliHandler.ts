import path from "path";
import { getInstalledSkills, filterSkillsByMode } from "../config/skills.js";
import { synthesizeSkill, listSynthesizedSkills } from "../skills/skillSynthesizer.js";

export function printSkillHelp(): void {
  console.log(`
Usage: superagent skill <command> [options]

Commands:
  list, ls                              List all installed and synthesized skills
  show <skill_name>                     Display instructions and markdown of a skill
  run <skill_name> [options]            Execute an automated skill workflow via agent
  stats, metrics                        Show skill usage counts and execution stats
  synth <task_description> [options]    Synthesize a new reusable skill (SKILL.md)
  help                                  Show this help message

Options for synth:
  --name <name>                         Custom kebab-case name for the skill
  --category <category>                 Skill category (e.g. testing, refactor, automation)
  --workspace <path>                    Workspace directory (defaults to current directory)

Options for run:
  --workspace <path>                    Workspace directory
  --multi                               Run in 3-tier multi-agent mode

Examples:
  superagent skill list
  superagent skill show tdd
  superagent skill run tdd
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

  if (subcommand === "show" || subcommand === "view") {
    const name = args[1]?.toLowerCase();
    if (!name) {
      console.log("Usage: superagent skill show <skill_name>");
      process.exit(1);
    }

    const fs = await import("fs");
    const workspace = process.cwd();
    const installed = getInstalledSkills();
    const synthesized = listSynthesizedSkills(workspace);

    const foundInstalled = installed.find((s) => s.name.toLowerCase() === name);
    const foundSynthesized = synthesized.find((s) => s.name.toLowerCase() === name);
    const targetPath = foundSynthesized?.path || foundInstalled?.path;

    if (targetPath && fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, "utf-8");
      console.log(`\n--- Skill: ${name} (${targetPath}) ---\n`);
      console.log(content);
      process.exit(0);
    } else {
      console.log(`Error: Skill "${name}" not found.`);
      console.log("Run 'superagent skill list' to inspect available skills.");
      process.exit(1);
    }
  }

  if (subcommand === "run" || subcommand === "exec") {
    const name = args[1]?.toLowerCase();
    if (!name) {
      console.log("Usage: superagent skill run <skill_name> [--workspace <path>] [--multi]");
      process.exit(1);
    }

    const wsIndex = args.indexOf("--workspace");
    const isMulti = args.includes("--multi");
    const workspace = wsIndex !== -1 && args[wsIndex + 1] ? args[wsIndex + 1] : process.cwd();

    const fs = await import("fs");
    const installed = getInstalledSkills();
    const synthesized = listSynthesizedSkills(workspace);

    const foundInstalled = installed.find((s) => s.name.toLowerCase() === name);
    const foundSynthesized = synthesized.find((s) => s.name.toLowerCase() === name);
    const targetPath = foundSynthesized?.path || foundInstalled?.path;

    if (!targetPath || !fs.existsSync(targetPath)) {
      console.log(`Error: Skill "${name}" not found.`);
      process.exit(1);
    }

    const skillContent = fs.readFileSync(targetPath, "utf-8");
    console.log(`Executing workflow for skill: ${name}...`);
    console.log(`- Workspace: ${workspace}`);
    console.log(`- Mode: ${isMulti ? "multi" : "single"}\n`);

    const { recordSkillExecution } = await import("../skills/skillTracker.js");
    recordSkillExecution(name);

    const { createAgentExecutor } = await import("../gateway/gatewayServer.js");
    const executeAgent = await createAgentExecutor(workspace);

    const prompt = `Please follow and execute the following skill guide carefully to complete the task:\n\n${skillContent}`;
    try {
      const output = await executeAgent(prompt, workspace);
      console.log("\n--- Execution Output ---");
      console.log(output);
      console.log("\nSkill execution completed.");
      process.exit(0);
    } catch (err: any) {
      console.log(`\nExecution failed: ${err.message}`);
      process.exit(1);
    }
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
