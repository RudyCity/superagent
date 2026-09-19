#!/usr/bin/env node

// Emergency terminal cleanup for uncaught crashes in the CLI
const emergencyRestoreTerminal = () => {
  try {
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h");
    }
  } catch {}
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  } catch {}
};
process.once("uncaughtException", (err) => {
  emergencyRestoreTerminal();
  console.error("\n[FATAL ERROR]:", err);
  process.exit(1);
});
process.once("unhandledRejection", (reason) => {
  emergencyRestoreTerminal();
  console.error("\n[FATAL REJECTION]:", reason);
  process.exit(1);
});

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

if (process.argv[2] === "login") {
  const { handleLoginCliCommand } = await import("./core/commands/loginCliHandler.js");
  await handleLoginCliCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === "preset") {
  const { handlePresetCliCommand } = await import("./core/commands/presetCliHandler.js");
  await handlePresetCliCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === "session") {
  const { handleSessionCliCommand } = await import("./core/commands/sessionCliHandler.js");
  await handleSessionCliCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === "setup") {
  const { handleLoginCliCommand } = await import("./core/commands/loginCliHandler.js");
  // Launch login wizard in guided add mode
  const args = process.argv.slice(3);
  if (args.length === 0) {
    // If no args, print guided setup instructions and redirect to login add
    console.log(`
Superagent Setup Wizard
=======================

To configure an AI provider, run one of the following:

  superagent login add openrouter   <api_key>
  superagent login add anthropic    <api_key>
  superagent login add openai       <api_key>
  superagent login add gemini       <api_key>
  superagent login add custom       <base_url> <api_key>

After adding a provider, use:
  superagent preset list            - list available model presets
  superagent preset use <name>      - activate a preset
  superagent                        - start the interactive terminal

For full login help:
  superagent login --help
`);
  } else {
    await handleLoginCliCommand(["add", ...args]);
  }
  process.exit(0);
}

if (process.argv[2] === "mcp") {
  const sub = process.argv[3]?.toLowerCase();
  if (sub === "register") {
    const { registerToAgyConfig } = await import("./core/mcp/mcpRegistration.js");
    const res = registerToAgyConfig();
    console.log(res.message);
    process.exit(res.success ? 0 : 1);
  } else if (["list", "ls", "add", "remove", "rm", "delete", "help", "--help", "-h"].includes(sub) || !sub) {
    const { handleMcpCliCommand } = await import("./core/commands/mcpCliHandler.js");
    await handleMcpCliCommand(process.argv.slice(3));
    process.exit(0);
  }
}

if (
  process.argv.includes("--mcp") ||
  process.argv.includes("--mcp-server") ||
  process.argv[2] === "mcp-server"
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
  setup             Run interactive provider and initial setup wizard
  login             Manage provider authentication (add, list, use, remove)
  preset            Manage model presets (list, use, show)
  session           Manage conversation sessions (list, export, clear --empty, import)
  daemon            Manage background daemon & cron scheduler (start, stop, status, list, add, remove, run)
  gateway           Manage the omnichannel messaging gateway (status, enable, disable, listen, poll)
  mcp               Manage MCP servers (list, add, remove, register)
  selfdev           Manage self-development behavioral lessons (status, list, distill, approve, reject, retire)
  skill             Manage and synthesize reusable skills (list, synth)

Options:
  -r, --resume            Resume the last active session
  -w, --workspace <path>  Target workspace directory path
  -ws, --workspace-ssh <T> Target remote SSH workspace (e.g. user@host:/path)
  -p, --preset <name>     Activate a model preset for this session
  --model <model_name>    Override active model for this session
  --provider <id>         Override active provider profile for this session
  --multi                 Start in Multi Superagent master orchestrator mode
  --mcp, --mcp-server     Start Superagent as an MCP (Model Context Protocol) server
  -q, --quick             Fast startup path, bypass interactive progress UI
  --skip-startup-check    Alias for --quick
  -s, --server [P]        Start API server (default port: 7888)
  -m, --client-mode <M>   Client mode for server: 'chrome-extension' or 'tline' (default: tline)
  -v, --version           Show version number and exit
  -h, --help              Show this help message and exit

Examples:
  superagent login list
  superagent login add openrouter sk-or-v1-...
  superagent preset list
  superagent preset use dev
  superagent daemon list
  superagent daemon add --name nightly --cron "0 2 * * *" --prompt "Clean cache"
  superagent -q "explain quantum computing in simple terms"
  superagent --preset dev "explain quantum computing in simple terms"
  superagent --multi --preset dev "build authentication module"
  superagent -ws root@192.168.1.100:/home/app
  superagent --mcp
  superagent mcp register
  superagent session list -w ./my-project
  superagent session export sess_123 -o output.md
  superagent session clear --empty
  superagent --resume
  superagent --server 7888 --client-mode tline
`);
  process.exit(0);
}

const daemonIndex = process.argv.findIndex(arg => arg === "daemon" || arg === "--daemon");
if (daemonIndex !== -1) {
  const daemonArgs = process.argv.slice(daemonIndex + 1);
  const { handleDaemonCli } = await import("./core/daemon/daemonCli.js");
  await handleDaemonCli(daemonArgs);
  process.exit(0);
}

if (process.argv[2] === "gateway") {
  const { gatewayManager } = await import("./core/gateway/gatewayManager.js");
  const subcommand = process.argv[3]?.toLowerCase() || "status";
  switch (subcommand) {
    case "status": {
      const status = gatewayManager.getStatus();
      const cfg = gatewayManager.getConfig();
      console.log(`Gateway: ${status.enabled ? "enabled" : "disabled"} | Mode: ${cfg.defaultMode}`);
      for (const [ch, st] of Object.entries(status.channels)) {
        const s = st as any;
        console.log(`  ${ch.padEnd(10)}: ${s.enabled ? "on" : "off"} | configured=${s.configured} | recv=${s.messagesReceived} sent=${s.messagesSent}`);
      }
      break;
    }
    case "enable":
      gatewayManager.updateConfig({ enabled: true });
      console.log("Gateway enabled.");
      break;
    case "disable":
      gatewayManager.updateConfig({ enabled: false });
      console.log("Gateway disabled.");
      break;
    case "listen":
    case "start": {
      const port = parseInt(process.argv[4], 10) || 7890;
      const { startGatewayServer } = await import("./core/gateway/gatewayServer.js");
      await startGatewayServer({ port });
      // Keep process alive while listening
      await new Promise(() => {});
      break;
    }
    case "poll": {
      const channel = process.argv[4] || "all";
      const { startGatewayPolling } = await import("./core/gateway/gatewayPoller.js");
      await startGatewayPolling({ channels: channel });
      // Keep process alive while polling
      await new Promise(() => {});
      break;
    }
    default:
      console.log(`Unknown gateway subcommand: ${subcommand}`);
      console.log("Available: status | enable | disable | listen [port] | poll [telegram|discord|all]");
      break;
  }
  process.exit(0);
}

if (process.argv[2] === "selfdev") {
  const { handleSelfDevCliCommand } = await import("./core/commands/selfdevCliHandler.js");
  await handleSelfDevCliCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === "skill" || process.argv[2] === "skills") {
  const { handleSkillCliCommand } = await import("./core/commands/skillCliHandler.js");
  await handleSkillCliCommand(process.argv.slice(3));
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

