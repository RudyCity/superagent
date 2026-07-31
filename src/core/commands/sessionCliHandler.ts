import fs from "fs";
import path from "path";
import { listHistorySessions, purgeEmptySessions, exportSession, importSession, closeHistoryDb } from "../config.js";

function parseWorkspaceArg(args: string[]): string {
  const wsIdx = args.findIndex(a => a === "--workspace" || a === "-w");
  if (wsIdx !== -1 && args[wsIdx + 1] && !args[wsIdx + 1].startsWith("-")) {
    const raw = args[wsIdx + 1];
    return (raw.startsWith("ssh:") || raw.startsWith("ssh://") || raw.startsWith("chain:")) ? raw : path.resolve(raw);
  }
  return process.cwd();
}

export async function handleSessionCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase() || "list";
  const targetWorkspace = parseWorkspaceArg(args);

  if (subcommand === "list" || subcommand === "ls") {
    const isAll = args.includes("--all") || args.includes("-a");
    const sessions = listHistorySessions(false, isAll, targetWorkspace);

    if (sessions.length === 0) {
      console.log("No conversation sessions found.");
      closeHistoryDb();
      process.exit(0);
    }

    console.log(`\n📋 SuperAgent Sessions (${isAll ? "All Workspaces" : "Workspace: " + targetWorkspace}):\n`);
    console.log(`${"ID".padEnd(32)} ${"Messages".padEnd(10)} ${"Last Modified".padEnd(22)} ${"Display Name"}`);
    console.log("-".repeat(90));

    for (const s of sessions) {
      const idStr = s.id.substring(0, 30).padEnd(32);
      const msgStr = String(s.messageCount).padEnd(10);
      const dateStr = s.lastModified.toLocaleString().padEnd(22);
      const nameStr = s.displayName || "(unnamed)";
      console.log(`${idStr} ${msgStr} ${dateStr} ${nameStr}`);
    }
    console.log(`\nTotal: ${sessions.length} sessions.\n`);
    closeHistoryDb();
    process.exit(0);
  }

  if (subcommand === "export") {
    const sessionId = args[1];
    if (!sessionId || sessionId.startsWith("-")) {
      console.error("Error: Please provide a session ID to export.");
      console.log("Usage: superagent session export <sessionId> [-w <workspace-path>] [--format json|markdown] [-o <output-file>]");
      closeHistoryDb();
      process.exit(1);
    }

    const formatIdx = args.findIndex(a => a === "--format" || a === "-f");
    const format = formatIdx !== -1 && args[formatIdx + 1]?.toLowerCase() === "json" ? "json" : "markdown";

    const outIdx = args.findIndex(a => a === "-o" || a === "--output");
    const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

    const exported = exportSession(sessionId, format);
    if (!exported) {
      console.error(`Error: Session with ID '${sessionId}' not found.`);
      closeHistoryDb();
      process.exit(1);
    }

    if (outFile) {
      const resolvedOut = path.resolve(outFile);
      fs.writeFileSync(resolvedOut, exported, "utf-8");
      console.log(`✅ Session '${sessionId}' exported to: ${resolvedOut}`);
    } else {
      console.log(exported);
    }
    closeHistoryDb();
    process.exit(0);
  }

  if (subcommand === "clear" || subcommand === "purge") {
    const hasEmptyFlag = args.includes("--empty") || args.includes("-e");
    if (!hasEmptyFlag) {
      console.log("Notice: Specify --empty to clear draft sessions with 0 messages.");
    }
    const result = purgeEmptySessions(0);
    console.log(`\n🧹 Cleaned up ${result.purgedCount} empty draft sessions.\n`);
    closeHistoryDb();
    process.exit(0);
  }

  if (subcommand === "import") {
    const filePath = args[1];
    if (!filePath) {
      console.error("Error: Please provide a file path to import.");
      console.log("Usage: superagent session import <file-path.json>");
      closeHistoryDb();
      process.exit(1);
    }

    const res = importSession(path.resolve(filePath));
    if (res.success) {
      console.log(`✅ Successfully imported session ID '${res.id}'.`);
    } else {
      console.error(`❌ Import failed: ${res.error}`);
    }
    closeHistoryDb();
    process.exit(res.success ? 0 : 1);
  }

  console.log(`
Usage: superagent session <command> [options]

Commands:
  list, ls                 List sessions (-w <path>, --all for all)
  export <id>              Export session log (--format json|markdown, -o file)
  clear --empty            Purge draft sessions with 0 messages
  import <file.json>       Import session log JSON

Options:
  -w, --workspace <path>   Specify target workspace directory
  -a, --all                List sessions across all workspaces
  -o, --output <file>      Output file path for export
  -f, --format <fmt>       Export format (markdown or json)
`);

  closeHistoryDb();
  process.exit(0);
}

