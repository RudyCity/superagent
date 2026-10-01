import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  RemoteAgentConfig,
} from "./config.js";
import { runRemoteTask } from "./taskRunner.js";

export async function handleMuseCliCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || "status").toLowerCase();

  if (subcommand === "status") {
    const cfg = loadRemoteAgentConfig();
    const isConfigured = Boolean(cfg.botToken && cfg.groupId && cfg.museBotId);

    console.log("Remote Agent (Muse) Status:");
    console.log(`  Configured      : ${isConfigured ? "Yes" : "No (run: superagent muse config)"}`);
    console.log(`  Bot Token       : ${maskToken(cfg.botToken)}`);
    console.log(`  Telegram Group  : ${cfg.groupId || "(not set)"}`);
    console.log(`  Muse Bot ID     : ${cfg.museBotId || "(not set)"}`);
    console.log(`  Default Ws      : ${cfg.defaultWorkspace || process.cwd()}`);
    console.log("");
    console.log("To set config:");
    console.log("  superagent muse config botToken <token>");
    console.log("  superagent muse config groupId <groupId>");
    console.log("  superagent muse config museBotId <botId>");
    return;
  }

  if (subcommand === "config") {
    const key = args[1]?.toLowerCase();
    const val = args.slice(2).join(" ").trim();

    if (!key) {
      const cfg = loadRemoteAgentConfig();
      console.log("Current Remote Agent Configuration:");
      console.log(`  botToken         : ${maskToken(cfg.botToken)}`);
      console.log(`  groupId          : ${cfg.groupId || "(not set)"}`);
      console.log(`  museBotId        : ${cfg.museBotId || "(not set)"}`);
      console.log(`  defaultWorkspace : ${cfg.defaultWorkspace || "(not set)"}`);
      console.log("");
      console.log("Usage: superagent muse config <key> <value>");
      return;
    }

    const validKeys: Record<string, keyof RemoteAgentConfig> = {
      bottoken: "botToken",
      bot_token: "botToken",
      groupid: "groupId",
      group_id: "groupId",
      musebotid: "museBotId",
      muse_bot_id: "museBotId",
      defaultworkspace: "defaultWorkspace",
      default_workspace: "defaultWorkspace",
    };

    const mappedKey = validKeys[key];
    if (!mappedKey) {
      console.error(`Unknown config key: ${key}`);
      return;
    }

    if (!val) {
      console.error(`Usage: superagent muse config ${key} <value>`);
      return;
    }

    const patch: Partial<RemoteAgentConfig> = { [mappedKey]: val };
    updateRemoteAgentConfig(patch);
    const maskedVal = mappedKey === "botToken" ? maskToken(val) : val;
    console.log(`Updated remoteAgent config: ${mappedKey} = ${maskedVal}`);
    return;
  }

  // Treat rest as a task
  const taskPrompt = args.join(" ").trim();
  if (!taskPrompt) {
    console.log("Usage: superagent muse [status|config|<task prompt>]");
    return;
  }

  console.log(`[Muse CLI] Running remote task: "${taskPrompt}"`);
  const result = await runRemoteTask({
    task: taskPrompt,
    workspace: process.cwd(),
    onProgress: (msg) => console.log(`[Muse] ${msg}`),
    onChat: (msg) => console.log(`[Muse Note] ${msg}`),
  });

  if (result.success) {
    console.log("\n--- Task Summary ---");
    console.log(result.summary);
  } else {
    console.error(`\nTask Failed: ${result.error || "Unknown error"}`);
    process.exit(1);
  }
}
