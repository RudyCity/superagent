import { loadModelConfig, saveModelConfig } from "../config/jsonConfig.js";

export function printMcpHelp(): void {
  console.log(`
Usage: superagent mcp <command> [options]

Commands:
  list, ls                              List configured MCP servers
  add <name> <command> [args...]        Add an MCP server configuration
  remove, rm <name>                     Remove an MCP server configuration
  register                              Register Superagent as an MCP server to Antigravity (AGY)

Examples:
  superagent mcp list
  superagent mcp add everything npx -y @modelcontextprotocol/server-everything
  superagent mcp remove everything
  superagent mcp register
`);
}

export async function handleMcpCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printMcpHelp();
    process.exit(0);
  }

  if (subcommand === "list" || subcommand === "ls") {
    const config = loadModelConfig();
    const servers = config.mcpServers || {};
    const names = Object.keys(servers);

    if (names.length === 0) {
      console.log("No MCP servers configured.");
      console.log("Use: superagent mcp add <name> <command> [args...]");
      process.exit(0);
    }

    console.log(`Configured MCP Servers (${names.length}):`);
    for (const name of names) {
      const srv = servers[name];
      const argsStr = (srv.args || []).join(" ");
      console.log(`- ${name}: ${srv.command} ${argsStr}`);
    }
    process.exit(0);
  }

  if (subcommand === "add") {
    const name = args[1];
    const command = args[2];
    const serverArgs = args.slice(3);

    if (!name || !command) {
      console.log("Error: Missing server name or command.");
      console.log("Usage: superagent mcp add <name> <command> [args...]");
      console.log("Example: superagent mcp add everything npx -y @modelcontextprotocol/server-everything");
      process.exit(1);
    }

    const config = loadModelConfig();
    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers[name] = {
      command,
      args: serverArgs,
    };

    const saved = saveModelConfig(config);
    if (saved) {
      console.log(`Successfully added MCP server "${name}".`);
      console.log(`Command: ${command} ${serverArgs.join(" ")}`);
      process.exit(0);
    } else {
      console.log("Error: Failed to save configuration to model-config.json");
      process.exit(1);
    }
  }

  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const name = args[1];
    if (!name) {
      console.log("Error: Missing server name to remove.");
      console.log("Usage: superagent mcp remove <name>");
      process.exit(1);
    }

    const config = loadModelConfig();
    if (!config.mcpServers || !config.mcpServers[name]) {
      console.log(`Error: MCP server "${name}" is not configured.`);
      process.exit(1);
    }

    delete config.mcpServers[name];
    const saved = saveModelConfig(config);
    if (saved) {
      console.log(`Successfully removed MCP server "${name}".`);
      process.exit(0);
    } else {
      console.log("Error: Failed to save configuration to model-config.json");
      process.exit(1);
    }
  }

  console.log(`Unknown MCP subcommand: "${subcommand}"`);
  printMcpHelp();
  process.exit(1);
}
