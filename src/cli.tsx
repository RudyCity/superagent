#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

// SuperAgent is Bun-native. Do not silently start under Node, where the
// memory/worker pipeline may use incompatible SQLite and loader behavior.
const bunRuntimeVersion = (process.versions as any)?.bun;
const bunParts = (bunRuntimeVersion?.split(".").map(Number) ?? []) as number[];
const isAdequateBun = Boolean(
  bunRuntimeVersion &&
  (bunParts[0] > 1 || (bunParts[0] === 1 && (bunParts[1] > 4 || (bunParts[1] === 4 && bunParts[2] >= 2))))
);

if (!isAdequateBun) {
  if (!bunRuntimeVersion) {
    // Invoked under Node (e.g. global npm link or Windows superagent.cmd / superagent.ps1 shim).
    // Transparently hand off execution to Bun if available on PATH.
    try {
      const targetScript = process.argv[1];
      const result = spawnSync("bun", [targetScript, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: process.env,
      });
      if (result.error && (result.error as any).code === "ENOENT") {
        console.error("SuperAgent requires Bun 1.4.2 or newer, but 'bun' was not found in your PATH.");
        console.error("Please install Bun from https://bun.sh and ensure it is available in PATH.");
        process.exit(1);
      }
      process.exit(result.status ?? (result.signal ? 1 : 0));
    } catch {
      // Fall through to error output below
    }
  }
  console.error("SuperAgent requires Bun 1.4.2 or newer. Start with: bun dist/cli.js");
  process.exit(1);
}

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
// Prevent MaxListenersExceededWarning across CLI subsystems (mouse, SIGINT, bridges)
process.setMaxListeners(50);

// Suppress experimental warnings (e.g. node:sqlite) from cluttering user terminal
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning: any, ...args: any[]) => {
  if (typeof warning === "string" && warning.includes("SQLite")) return;
  if (warning && typeof warning === "object" && warning.name === "ExperimentalWarning" && String(warning.message).includes("SQLite")) return;
  return (originalEmitWarning as any).call(process, warning, ...args);
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

if (process.argv[2] === "studio" || process.argv[2] === "motion") {
  const { handleMotionCliCommand } = await import("./core/commands/motionCliHandler.js");
  process.exit(await handleMotionCliCommand(process.argv.slice(3)));
}

if (process.argv[2] === "memory") {
  const { handleMemorySweepCliCommand } = await import("./core/commands/memorySweepCliHandler.js");
  const exitCode = await handleMemorySweepCliCommand(process.argv.slice(3));
  process.exit(exitCode);
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

if (process.argv[2] === "create" || process.argv[2] === "init-project" || process.argv[2] === "new-project") {
  const { handleCreateCliCommand } = await import("./core/commands/createCliHandler.js");
  await handleCreateCliCommand(process.argv.slice(3));
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
// Never accept OS sandbox requirements based solely on an application toggle.
// A trusted launcher must verify the OS token and enforce ACL access probes.
if (process.env.SUPERAGENT_REQUIRE_OS_SANDBOX === "1") {
  const { execFileSync } = await import("node:child_process");
  const expected = process.env.SUPERAGENT_OS_RUNNER_IDENTITY?.trim();
  let actual = "";
  try {
    if (process.platform === "win32") actual = execFileSync("whoami.exe", [], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {}
  if (!expected || actual.toLowerCase() !== expected.toLowerCase()) {
    process.stderr.write("OS sandbox required: Windows process identity does not match SUPERAGENT_OS_RUNNER_IDENTITY; refusing to start.\n");
    process.exit(78);
  }
  const probePath = process.env.SUPERAGENT_OS_DENIED_PROBE_PATH;
  if (!probePath) {
    process.stderr.write("OS sandbox required: SUPERAGENT_OS_DENIED_PROBE_PATH must identify a denied file for access verification.\n");
    process.exit(78);
  }
  const { openSync, closeSync } = await import("node:fs");
  let unexpectedlyReadable = false;
  try { const handle = openSync(probePath, "r"); closeSync(handle); unexpectedlyReadable = true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      process.stderr.write("OS sandbox probe inconclusive (not a permission denial): " + String(error) + "\n");
      process.exit(78);
    }
  }
  if (unexpectedlyReadable) {
    process.stderr.write("OS sandbox required: denied probe was readable; refusing to start.\n");
    process.exit(78);
  }
}

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
  } else if ([ "list", "ls", "add", "add-http", "remove", "rm", "delete", "use", "tunnel", "help", "--help", "-h"].includes(sub) || !sub) {
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
  const path = await import("path");
  const fs = await import("fs");
  const workspaceIndex = process.argv.findIndex((arg) => arg === "--workspace" || arg === "-w");
  let workspaceVal: string | undefined = undefined;
  if (workspaceIndex !== -1 && workspaceIndex + 1 < process.argv.length) {
    const nextArg = process.argv[workspaceIndex + 1];
    workspaceVal = nextArg;
  }
  const resolvedWs = workspaceVal ? path.resolve(workspaceVal) : process.cwd();
  if (workspaceVal && fs.existsSync(resolvedWs)) {
    try {
      process.chdir(resolvedWs);
    } catch {}
  }
  const { startSuperagentMcpServer } = await import("./core/mcp/superagentMcpServer.js");
  await startSuperagentMcpServer({ workspace: resolvedWs });
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
  memory            Review RMemory retention (sweep [--apply])
  daemon            Manage background daemon & cron scheduler (start, stop, status, list, add, remove, run)
  gateway           Manage the omnichannel messaging gateway (status, enable, disable, listen, poll)
  muse              Coordinate with remote AI agent (status, config, watch [projects...], run)
  tunnel            Manage Cloudflare quick tunnels (list, start [--https], stop, status)
  mcp               Manage MCP servers (list, add, remove, register)
  selfdev           Manage self-development behavioral lessons (status, list, distill, approve, reject, retire)
  skill             Manage and synthesize reusable skills (list, synth)
  create <name>     Create a new instant project workspace (empty project by default)

Options:
  -r, --resume            Resume the last active session
  -w, --workspace <path>  Target workspace directory path
  -ws, --workspace-ssh <T> Target remote SSH workspace (e.g. user@host:/path)
  -p, --preset <name>     Activate a model preset for this session
  --model <model_name>    Override active model for this session
  --provider <id>         Override active provider profile for this session
  --multi                 Start in Multi Superagent master orchestrator mode
  -y, --yolo              Enable Scoped YOLO mode (auto-approve within project & 1 parent level above)
  --yolo-full             Enable Full YOLO mode (auto-approve system-wide, unrestricted)
  --mcp, --mcp-server     Start Superagent as an MCP (Model Context Protocol) server
  -q, --quick             Fast startup path, bypass interactive progress UI
  --skip-startup-check    Alias for --quick
  -s, --server [P]        Start API server (default port: 7888)
  -t, --tunnel            Pair with --server to expose API server via Cloudflare HTTPS quick tunnel
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
  superagent tunnel list
  superagent tunnel start --https
  superagent --server 7888 --tunnel
  superagent muse tunnel list
  superagent muse watch ./backend ./frontend
  superagent -q "explain quantum computing in simple terms"
  superagent --preset dev "explain quantum computing in simple terms"
  superagent --multi --preset dev "build authentication module"
  superagent -ws root@192.168.1.100:/home/app
  superagent --mcp
  superagent mcp register
  superagent session list -w ./my-project
  superagent memory sweep                 # preview only
  superagent memory sweep --apply         # mark eligible records expired, never delete
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
      console.log("Available: status | enable | disable | listen [port] | poll [telegram|discord|slack|all]");
      break;
  }
  process.exit(0);
}

if (process.argv[2] === "muse") {
  const { handleMuseCliCommand } = await import("./core/remoteAgent/museCli.js");
  await handleMuseCliCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === "tunnel" || process.argv[2] === "tunnels") {
  const { handleMuseCliCommand } = await import("./core/remoteAgent/museCli.js");
  const subArgs = process.argv[2] === "tunnels"
    ? ["tunnel", "list", ...process.argv.slice(3)]
    : ["tunnel", ...process.argv.slice(3)];
  await handleMuseCliCommand(subArgs);
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

  const hasTunnel = process.argv.includes("--tunnel") || process.argv.includes("-t");
  const { runServer } = await import("./server.js");
  const serverInstance = await runServer(port, false, clientMode);

  if (hasTunnel && serverInstance) {
    try {
      const { startQuickTunnel, stopQuickTunnel } = await import("./core/remoteAgent/cloudflareTunnel.js");
      const { getServerAuthToken } = await import("./core/utils/serverSecurity.js");
      console.log(`[Cloudflare Tunnel] Starting quick HTTPS tunnel for port ${port}...`);
      const meta = await startQuickTunnel({ port, host: "127.0.0.1", path: "" });
      const token = getServerAuthToken(port);
      console.log("");
      console.log("═════════════════════════════════════════════════════════════════════════════");
      console.log("  Superagent HTTP REST/SSE Server & Cloudflare Quick Tunnel Online!");
      console.log("═════════════════════════════════════════════════════════════════════════════");
      console.log(`  Public HTTPS URL  : ${meta.publicUrl}`);
      console.log(`  Local Target      : ${meta.localUrl}`);
      console.log(`  Server Port       : ${port}`);
      console.log(`  Process PID       : ${meta.pid}`);
      console.log(`  Bearer Token      : ${token}`);
      console.log("═════════════════════════════════════════════════════════════════════════════");
      console.log(`Test: curl -H "Authorization: Bearer ${token}" ${meta.publicUrl}/api/status\n`);

      const cleanTunnelExit = async () => {
        try {
          await stopQuickTunnel(port);
        } catch {}
      };
      process.on("SIGINT", cleanTunnelExit);
      process.on("SIGTERM", cleanTunnelExit);
    } catch (err: any) {
      console.error(`[Cloudflare Tunnel Error] ${err?.message}`);
    }
  }
} else {
  // Boot the main CLI logic
  const { runCli } = await import("./cliMain.js");
  await runCli();
}

export {};

