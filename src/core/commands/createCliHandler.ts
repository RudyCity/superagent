import path from "path";
import { createInstantProject } from "../project/projectScaffolder.js";
import { closeHistoryDb } from "../storage/historyDb.js";

export function printCreateHelp(): void {
  console.log(`
Usage: superagent create <project-name> [options]

Create a new instant project using Superagent as the base template.

Options:
  -d, --dir <path>       Target directory path (defaults to ../<project-name>)
  -f, --force            Overwrite destination directory if it already exists
  --no-git               Do not initialize a Git repository
  --desc <description>   Custom project description
  -h, --help             Show this help message

Examples:
  superagent create my-new-agent
  superagent create my-new-agent --dir ./projects/my-new-agent
  superagent create my-new-agent --force
`);
}

export async function handleCreateCliCommand(args: string[]): Promise<void> {
  if (
    args.length === 0 ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[0] === "help"
  ) {
    printCreateHelp();
    try {
      closeHistoryDb();
    } catch {}
    process.exit(0);
  }

  let projectName = "";
  let targetDir = "";
  let force = false;
  let initGit = true;
  let description = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir" || arg === "-d") {
      targetDir = args[++i] || "";
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--no-git") {
      initGit = false;
    } else if (arg === "--desc") {
      description = args[++i] || "";
    } else if (!arg.startsWith("-") && !projectName) {
      projectName = arg;
    }
  }

  if (!projectName) {
    console.error("\x1b[31m[ERROR]\x1b[0m Please specify a project name.");
    printCreateHelp();
    process.exit(1);
  }

  console.log(
    `\x1b[36m[SCAFFOLD]\x1b[0m Creating instant project \x1b[1m${projectName}\x1b[0m from Superagent base...`
  );

  try {
    const result = await createInstantProject({
      projectName,
      targetDir: targetDir ? path.resolve(targetDir) : undefined,
      force,
      initGit,
      description,
    });

    console.log(`\x1b[32m[SUCCESS]\x1b[0m ${result.message}`);
    console.log(`
\x1b[36mNext steps:\x1b[0m
  1. cd "${result.targetDir}"
  2. bun install  (or npm install)
  3. superagent
`);
    try {
      closeHistoryDb();
    } catch {}
    process.exit(0);
  } catch (err: any) {
    console.error(
      `\x1b[31m[ERROR]\x1b[0m Scaffolding failed: ${err?.message || err}`
    );
    try {
      closeHistoryDb();
    } catch {}
    process.exit(1);
  }
}
