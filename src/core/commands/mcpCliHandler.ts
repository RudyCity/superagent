import { loadModelConfig, saveModelConfig } from "../config/jsonConfig.js";
import { getMcpTunnelProvidersHelp } from "./commandCatalog.js";

export function printMcpHelp(): void {
  console.log(`
Usage: superagent mcp <command> [options]

Commands:
  list, ls                              List configured MCP servers
  add <name> <command> [args...]        Add an MCP server configuration
  add-http <name> <url> [--oauth]       Add a remote Streamable HTTP MCP server
  remove, rm <name>                     Remove an MCP server configuration
  register                              Register Superagent as an MCP server to Antigravity (AGY)
  tunnel <start|stop|restart|list|status|doctor|providers>  Manage MCP tunnel providers (Cloudflare or OpenAI)

Examples:
   superagent mcp list
   superagent mcp add everything npx -y @modelcontextprotocol/server-everything
   superagent mcp add-http google https://mcp.example.com/mcp --oauth
   superagent mcp remove everything
   superagent mcp register
   superagent mcp tunnel providers
   superagent mcp tunnel start --provider cloudflare
   superagent mcp tunnel start --provider openai --tunnel-id tunnel_0123456789abcdef
   superagent mcp tunnel doctor --provider openai --profile superagent-mcp
   superagent mcp tunnel restart
   superagent mcp tunnel list
   superagent mcp tunnel stop
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
      if (srv.transport === "http" || srv.transport === "streamable-http") {
        const oauth = srv.oauth ? " | OAuth enabled" : "";
        console.log("- " + name + ": " + srv.transport + " " + srv.url + oauth);
      } else if (srv.transport === "stdio") {
        const argsStr = (srv.args || []).join(" ");
        console.log("- " + name + ": " + srv.command + " " + argsStr);
      }
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
      transport: "stdio",
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

  if (subcommand === "add-http") {
    const name = args[1];
    const rawUrl = args[2];
    if (!name || !rawUrl) {
      console.log("Usage: superagent mcp add-http <name> <url> [--oauth]");
      process.exit(1);
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("HTTP(S) URL required");
    } catch {
      console.log("Error: URL must be a valid absolute HTTP(S) URL.");
      process.exit(1);
    }

    const config = loadModelConfig();
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[name] = {
      transport: "http",
      url: url.toString(),
      oauth: args.slice(3).some((arg) => arg.toLowerCase() === "--oauth"),
    };
    if (!saveModelConfig(config)) {
      console.log("Error: Failed to save configuration to model-config.json");
      process.exit(1);
    }
    console.log("Successfully added remote MCP server \"" + name + "\".");
    console.log("URL: " + url.toString());
    console.log("OAuth: " + (config.mcpServers[name].oauth ? "enabled" : "disabled"));
    console.log("Restart SuperAgent or reload MCP servers in its active session to connect.");
    process.exit(0);
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

  if (subcommand === "tunnel") {
    const tunnelAction = (args[1] || "list").toLowerCase();
    const rawArgs = args.slice(2);

    if (tunnelAction === "providers") {
      console.log(getMcpTunnelProvidersHelp());
      process.exit(0);
    }

    if (tunnelAction === "list" || tunnelAction === "status") {
      const { listActiveMcpServers, formatActiveMcpServers } = await import("../mcp/mcpTunnel.js");
      console.log(formatActiveMcpServers(listActiveMcpServers()));
      process.exit(0);
    }

    if (tunnelAction === "doctor") {
      const providerIdx = rawArgs.findIndex((a) => a === "--provider");
      const provider = providerIdx === -1 ? "openai" : rawArgs[providerIdx + 1]?.toLowerCase();
      if (provider !== "openai" && provider !== "cloudflare") {
        console.error("Unsupported MCP tunnel doctor provider. Use --provider openai or --provider cloudflare.");
        process.exit(1);
      }
      if (provider === "cloudflare") {
        const { findCloudflaredBinary } = await import("../remoteAgent/cloudflareTunnel.js");
        const binary = await findCloudflaredBinary();
        const { listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
        const active = listActiveMcpServers().filter((server) => server.tunnelProvider === "cloudflare");
        console.log([
          "Cloudflare MCP Tunnel Doctor",
          "- cloudflared: " + (binary || "NOT FOUND"),
          "- Active Cloudflare MCP tunnels: " + active.length,
        ].join("\n"));
        process.exit(binary ? 0 : 1);
      }
      const { runTunnelClientDoctor } = await import("../mcp/openaiTunnelClient.js");
      const profileIdx = rawArgs.findIndex((a) => a === "--profile");
      const profile = profileIdx !== -1 ? rawArgs[profileIdx + 1] : undefined;
      const tunnelIdIdx = rawArgs.findIndex((a) => a === "--tunnel-id");
      const tunnelId = tunnelIdIdx !== -1 ? rawArgs[tunnelIdIdx + 1] : undefined;
      const apiKeyIdx = rawArgs.findIndex((a) => a === "--api-key" || a === "--control-plane-key");
      const apiKey = apiKeyIdx !== -1 ? rawArgs[apiKeyIdx + 1] : undefined;

      console.log("Running OpenAI Secure MCP tunnel-client doctor check...");
      const docResult = await runTunnelClientDoctor({ profile, tunnelId, apiKey });
      console.log("[OpenAI tunnel-client doctor]\n" + docResult.output);
      process.exit(docResult.success ? 0 : 1);
    }

    if (tunnelAction === "restart") {
      const portIdx = rawArgs.findIndex((a) => a === "--port" || a === "--mcp-port" || a === "-p");
      let port = 9227;
      if (portIdx !== -1 && rawArgs[portIdx + 1]) {
        const parsed = Number.parseInt(rawArgs[portIdx + 1], 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
          console.error("Invalid MCP tunnel port.");
          process.exit(1);
        }
        port = parsed;
      }
      const { listActiveMcpServers, stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
      const active = listActiveMcpServers().find((server) => server.port === port);
      if (active?.pid && active.pid !== process.pid) {
        console.error("MCP tunnel on port " + port + " is owned by PID " + active.pid + ". Use its owning SuperAgent instance to restart it.");
        process.exit(1);
      }
      const restartArgs = [...rawArgs];
      const hasProvider = restartArgs.includes("--provider") || restartArgs.includes("--openai") || restartArgs.includes("--openai-tunnel") || restartArgs.includes("--tunnel-id");
      if (active && !hasProvider) {
        restartArgs.push("--provider", active.tunnelProvider || "cloudflare");
        if (active.tunnelProvider === "openai" && active.openAiTunnelId) restartArgs.push("--tunnel-id", active.openAiTunnelId);
      }
      if (active?.authMode && !restartArgs.includes("--mcp-auth")) restartArgs.push("--mcp-auth", active.authMode);
      if (active?.toolMode === "dangerous" && !restartArgs.includes("--allow-dangerous")) restartArgs.push("--allow-dangerous");
      if (active) await stopMcpTunnel(port);
      await handleMcpCliCommand(["tunnel", "start", ...restartArgs]);
      return;
    }

    if (tunnelAction === "stop") {
      const portIdx = rawArgs.findIndex((a) => a === "--port" || a === "--mcp-port" || a === "-p");
      let port = 9227;
      if (portIdx !== -1 && rawArgs[portIdx + 1]) {
        const parsed = parseInt(rawArgs[portIdx + 1], 10);
        if (parsed > 0) port = parsed;
      }
      const { stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
      await stopMcpTunnel(port);
      console.log(`MCP tunnel on port ${port} stopped.`);
      process.exit(0);
    }

    if (tunnelAction === "start") {
      const portIdx = rawArgs.findIndex((a) => a === "--port" || a === "--mcp-port" || a === "-p");
      let port = 9227;
      if (portIdx !== -1 && rawArgs[portIdx + 1]) {
        const parsed = parseInt(rawArgs[portIdx + 1], 10);
        if (parsed > 0) port = parsed;
      }
      const providerIdx = rawArgs.findIndex((a) => a === "--provider");
      const wantOpenAi = rawArgs.some((a) => a === "--openai" || a === "--openai-tunnel");
      let provider: "cloudflare" | "openai" = wantOpenAi ? "openai" : "cloudflare";
      if (providerIdx !== -1) {
        const p = rawArgs[providerIdx + 1]?.toLowerCase();
        if (p !== "openai" && p !== "cloudflare") {
          console.error(`Unsupported MCP tunnel provider "${rawArgs[providerIdx + 1] || "(missing)"}". Supported providers: cloudflare, openai. Run "superagent mcp tunnel providers".`);
          process.exit(1);
        }
        provider = p;
      }
      const tunnelIdIdx = rawArgs.findIndex((a) => a === "--tunnel-id");
      let tunnelId: string | undefined;
      if (tunnelIdIdx !== -1 && rawArgs[tunnelIdIdx + 1]) {
        tunnelId = rawArgs[tunnelIdIdx + 1].trim();
        provider = "openai";
      }
      const apiKeyIdx = rawArgs.findIndex((a) => a === "--api-key" || a === "--control-plane-key");
      const apiKey = apiKeyIdx !== -1 ? rawArgs[apiKeyIdx + 1]?.trim() : undefined;
      const profileIdx = rawArgs.findIndex((a) => a === "--profile");
      const profile = profileIdx !== -1 ? rawArgs[profileIdx + 1]?.trim() : undefined;
      const allowDangerous = rawArgs.some((a) => a === "--allow-dangerous");

      const { startMcpTunnel } = await import("../mcp/mcpTunnel.js");
      try {
        const info = await startMcpTunnel({
          port,
          allowDangerous,
          tunnelProvider: provider,
          tunnelId,
          openAiApiKey: apiKey,
          openAiProfile: profile,
        });

        if (info.tunnelProvider === "openai") {
          console.log([
            "OpenAI Secure MCP Tunnel Online!",
            `- Tunnel ID    : ${info.openAiTunnelId}`,
            `- Local MCP URL: ${info.localUrl}`,
            info.adminUrl ? `- Admin UI     : ${info.adminUrl}` : "",
            `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
            "",
            "Responses API tool definition:",
            JSON.stringify({
              model: "gpt-4o",
              input: "Use the private MCP server to answer my request.",
              tools: [{ type: "mcp", server_label: "superagent_mcp", tunnel_id: info.openAiTunnelId }],
            }, null, 2),
            "",
            "Tunnel is active and serving traffic. Press Ctrl+C to stop.",
          ].filter(Boolean).join("\n"));
        } else {
          console.log([
            "MCP via Cloudflare Tunnel Online!",
            `- Endpoint     : ${info.publicUrl}`,
            `- Local URL    : ${info.localUrl}`,
            `- Bearer Token : ${info.bearerToken}`,
            `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
            "",
            "Tunnel is active and serving traffic. Press Ctrl+C to stop.",
          ].join("\n"));
        }

        // Keep process running so tunnel and local MCP server remain alive
        await new Promise<void>((resolve) => {
          const cleanup = async () => {
            console.log("\nStopping MCP tunnel...");
            try {
              const { stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
              await stopMcpTunnel(port);
            } catch {}
            resolve();
          };
          process.once("SIGINT", cleanup);
          process.once("SIGTERM", cleanup);
        });
        process.exit(0);
      } catch (err: any) {
        console.error(`Error starting MCP tunnel: ${err.message}`);
        process.exit(1);
      }
    }

    console.log(`Unknown tunnel action: "${tunnelAction}". Available: providers, start, stop, restart, list, status, doctor`);
    process.exit(1);
  }

  console.log(`Unknown MCP subcommand: "${subcommand}"`);
  printMcpHelp();
  process.exit(1);
}
