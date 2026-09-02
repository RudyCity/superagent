#!/usr/bin/env node

if (process.argv.includes("--sync-history-only")) {
  try {
    const { syncAllHistoryToRMemory } = await import("./core/historySearch.js");
    await syncAllHistoryToRMemory();
  } catch (err) {
    console.error("History sync background process failed:", err);
  }
  try {
    const { closeHistoryDb } = await import("./core/config.js");
    closeHistoryDb();
  } catch {}
  process.exit(0);
}

if (process.argv[2] === "session") {
  const { handleSessionCliCommand } = await import("./core/commands/sessionCliHandler.js");
  await handleSessionCliCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === "mcp" && process.argv[3] === "register") {
  const { registerToAgyConfig } = await import("./core/mcp/mcpRegistration.js");
  const res = registerToAgyConfig();
  console.log(res.message);
  process.exit(res.success ? 0 : 1);
}

if (
  process.argv.includes("--mcp") ||
  process.argv.includes("--mcp-server") ||
  process.argv[2] === "mcp-server" ||
  (process.argv[2] === "mcp" && !["register", "list", "add", "remove"].includes(process.argv[3]))
) {
  const { startSuperagentMcpServer } = await import("./core/mcp/superagentMcpServer.js");
  await startSuperagentMcpServer();
  // Keep process alive while Stdio transport runs
  await new Promise(() => {});
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const { getSuperAgentVersion } = await import("./core/config/paths.js");
  console.log(getSuperAgentVersion());
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage: superagent [command/options] [prompt]

Commands:
  session           Manage conversation sessions (list, export, clear --empty, import)
  mcp register      Register Superagent MCP Server to Antigravity (AGY) configuration

Options:
  -r, --resume            Resume the last active session
  -w, --workspace <path>  Target workspace directory path
  --multi                 Start in Multi Superagent master orchestrator mode
  --mcp, --mcp-server     Start Superagent as an MCP (Model Context Protocol) server
  -s, --server [P]        Start API server (default port: 7888)
  -m, --client-mode <M>   Client mode for server: 'chrome-extension' or 'tline' (default: tline)
  -h, --help              Show this help message and exit

Examples:
  superagent
  superagent --mcp
  superagent mcp register
  superagent session list -w ./my-project
  superagent session export sess_123 -o output.md
  superagent session clear --empty
  superagent --resume
  superagent --multi
  superagent --server 7888 --client-mode tline
  superagent --server 7888 --client-mode chrome-extension
  superagent "explain quantum computing in simple terms"
`);
  process.exit(0);
}



const serverIndex = process.argv.findIndex(arg => arg === "--server" || arg === "-s" || arg === "--server-only");
if (serverIndex !== -1) {
  let port = 7888;
  if (serverIndex + 1 < process.argv.length) {
    const nextArg = process.argv[serverIndex + 1];
    const parsed = parseInt(nextArg, 10);
    if (!isNaN(parsed) && parsed > 0) {
      port = parsed;
    }
  }

  let clientMode: "chrome-extension" | "tline" = "tline";
  if (process.argv.includes("--chrome-extension")) {
    clientMode = "chrome-extension";
  } else if (process.argv.includes("--tline")) {
    clientMode = "tline";
  } else {
    const clientModeIndex = process.argv.findIndex(arg => arg === "--client-mode" || arg === "--clientMode" || arg === "-m");
    if (clientModeIndex !== -1 && clientModeIndex + 1 < process.argv.length) {
      const modeVal = process.argv[clientModeIndex + 1].toLowerCase();
      if (modeVal.includes("chrome") || modeVal.includes("extension") || modeVal === "ext") {
        clientMode = "chrome-extension";
      } else if (modeVal.includes("tline") || modeVal.includes("cli")) {
        clientMode = "tline";
      }
    }
  }

  const { runServer } = await import("./server.js");
  await runServer(port, false, clientMode);
} else {
  // Boot the main CLI logic
  const { runCli } = await import("./cliMain.js");
  await runCli();
}

export {};

