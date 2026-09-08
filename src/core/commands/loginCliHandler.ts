import {
  getConfiguredProviders,
  switchActiveProvider,
  addProvider,
  getProviders,
  removeProvider,
  closeHistoryDb
} from "../config.js";

export function printLoginHelp(): void {
  console.log(`
Usage: superagent login <command> [options]

Commands:
  list, ls                                List configured provider profiles
  add <provider> <api_key> [base_url]     Add or update a provider profile
  add <api_key>                           Add with auto-detected provider
  add custom <base_url> <api_key>         Add custom OpenAI/Anthropic endpoint
  use, switch <provider_id>               Switch active provider profile
  remove, rm <provider_id>                Remove a provider profile

Supported provider types:
  openrouter, openai, anthropic, gemini, custom, custom-anthropic, opencode,
  deepseek, xai, mistral, groq, azure, zai, kimi, cerebras, together,
  fireworks, ollama, lmstudio, tokenrouter, commandcode, zenmux, kilo

Examples:
  superagent login list
  superagent login add openrouter sk-or-v1-...
  superagent login add anthropic sk-ant-...
  superagent login add custom http://localhost:11434/v1 sk-ollama
  superagent login use openrouter
  superagent login remove old-profile
`);
}

export async function handleLoginCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printLoginHelp();
    try { closeHistoryDb(); } catch {}
    process.exit(0);
  }

  if (subcommand === "list" || subcommand === "ls") {
    const providers = getConfiguredProviders();
    if (providers.length === 0) {
      console.log("No providers configured yet. Use 'superagent login add <provider> <api_key>' to configure one.");
      try { closeHistoryDb(); } catch {}
      process.exit(0);
    }

    console.log(`\n📋 Configured Providers (${providers.length} total):\n`);
    console.log(
      `${"ID".padEnd(20)} ${"Type".padEnd(16)} ${"Active".padEnd(8)} ${"API Key".padEnd(16)} ${"Base URL"}`
    );
    console.log("-".repeat(85));

    for (const p of providers) {
      const masked = p.apiKey
        ? (p.apiKey.length <= 8 ? "*".repeat(p.apiKey.length) : `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}`)
        : "(none)";
      const activeMark = p.isActive ? "✓" : "";
      const baseStr = p.baseUrl || "-";
      console.log(
        `${p.id.padEnd(20)} ${(p.type || p.name).padEnd(16)} ${activeMark.padEnd(8)} ${masked.padEnd(16)} ${baseStr}`
      );
    }
    console.log("");
    try { closeHistoryDb(); } catch {}
    process.exit(0);
  }

  if (subcommand === "use" || subcommand === "switch") {
    const targetId = args[1]?.toLowerCase();
    if (!targetId) {
      console.error("Error: Please provide a provider ID. Usage: superagent login use <provider_id>");
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    const providers = getProviders();
    const target = providers.find(p => p.id.toLowerCase() === targetId);
    if (!target) {
      console.error(`Error: Provider "${targetId}" not found. Run 'superagent login list' to see configured providers.`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    try {
      switchActiveProvider(target.id);
      console.log(`✅ Switched active provider to: ${target.id} (${target.provider || target.name})`);
      try { closeHistoryDb(); } catch {}
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Failed to switch provider: ${err.message}`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }
  }

  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const targetId = args[1]?.toLowerCase();
    if (!targetId) {
      console.error("Error: Please provide a provider ID. Usage: superagent login remove <provider_id>");
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    const providers = getProviders();
    const target = providers.find(p => p.id.toLowerCase() === targetId);
    if (!target) {
      console.error(`Error: Provider "${targetId}" not found.`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    try {
      removeProvider(target.id);
      console.log(`✅ Successfully removed provider profile: ${target.id}`);
      try { closeHistoryDb(); } catch {}
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Failed to remove provider: ${err.message}`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }
  }

  if (subcommand === "add") {
    const subArgs = args.slice(1);
    if (subArgs.length === 0) {
      console.error("Error: 'superagent login add' requires arguments.");
      console.error("Usage: superagent login add <provider> <api_key> [base_url]");
      console.error("       superagent login add custom <base_url> <api_key>");
      console.error("       superagent login add <api_key>");
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    let provider = "";
    let apiKey = "";
    let baseUrl = "";

    if (subArgs[0].toLowerCase() === "custom") {
      if (subArgs.length < 3) {
        console.error("Error: 'superagent login add custom' requires <base_url> and <api_key>");
        console.error("Usage: superagent login add custom <base_url> <api_key>");
        try { closeHistoryDb(); } catch {}
        process.exit(1);
      }
      provider = "custom";
      baseUrl = subArgs[1];
      apiKey = subArgs[2];
    } else if (subArgs.length >= 2) {
      provider = subArgs[0].toLowerCase();
      apiKey = subArgs[1];
      if (subArgs.length >= 3) {
        baseUrl = subArgs[2];
      }
    } else {
      apiKey = subArgs[0];
      if (apiKey.startsWith("sk-or-")) {
        provider = "openrouter";
      } else if (apiKey.startsWith("sk-ant-")) {
        provider = "anthropic";
      } else if (apiKey.startsWith("AIza")) {
        provider = "gemini";
      } else {
        provider = "openai";
      }
    }

    const profileId = provider.toLowerCase().replace(/[^a-z0-9_-]/g, "");

    const defaultBaseUrl = provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : provider === "opencode"
      ? "https://opencode.ai/zen/v1"
      : provider === "kilo"
      ? "https://api.kilo.ai/api/gateway"
      : undefined;

    try {
      addProvider({
        id: profileId,
        name: provider,
        provider: provider,
        apiKey: apiKey,
        baseUrl: baseUrl || defaultBaseUrl,
      });

      switchActiveProvider(profileId);

      const resolvedBase = baseUrl || defaultBaseUrl;
      const baseInfo = resolvedBase ? ` (Base URL: ${resolvedBase})` : "";
      console.log(`✅ Successfully configured and activated provider: ${profileId} (${provider})${baseInfo}`);
      try { closeHistoryDb(); } catch {}
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Failed to configure provider: ${err.message}`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }
  }

  console.error(`Unknown login subcommand: "${subcommand}".`);
  printLoginHelp();
  try { closeHistoryDb(); } catch {}
  process.exit(1);
}
