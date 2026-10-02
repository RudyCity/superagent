import path from "path";
import { createInstantProject } from "../project/projectScaffolder.js";
import { closeHistoryDb } from "../storage/historyDb.js";

export function printCreateHelp(): void {
  console.log(`
Usage: superagent create <project-name> [options]

Create a new instant project workspace.

Options:
  -d, --dir <path>          Target directory path (defaults to Documents/superagent/<project-name>)
  -t, --template <type>     Project template: empty (default), minimal, or superagent
  -f, --force               Overwrite destination directory if it already exists
  --no-git                  Do not initialize a Git repository
  --desc <description>      Custom project description
  -h, --help                Show this help message

Examples:
  superagent create my-new-app
  superagent create my-new-app --template minimal
  superagent create my-new-app --template superagent
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
  let template: "empty" | "minimal" | "superagent" = "empty";

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
    } else if (arg === "--template" || arg === "-t") {
      const val = (args[++i] || "").toLowerCase();
      if (val === "superagent" || val === "base") template = "superagent";
      else if (val === "minimal" || val === "ts" || val === "node") template = "minimal";
      else template = "empty";
    } else if (!arg.startsWith("-") && !projectName) {
      projectName = arg;
    }
  }

  if (!projectName) {
    console.error("\x1b[31m[ERROR]\x1b[0m Please specify a project name.");
    printCreateHelp();
    process.exit(1);
  }

  const templateDisplay =
    template === "empty"
      ? "empty project"
      : template === "minimal"
      ? "minimal TypeScript project"
      : "Superagent base template";

  console.log(
    `\x1b[36m[SCAFFOLD]\x1b[0m Creating instant project \x1b[1m${projectName}\x1b[0m (${templateDisplay})...`
  );

  try {
    const result = await createInstantProject({
      projectName,
      targetDir: targetDir ? path.resolve(targetDir) : undefined,
      force,
      initGit,
      description,
      template,
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
