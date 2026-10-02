import path from "path";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  RemoteAgentConfig,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  setWatchedWorkspaces,
} from "./config.js";
import { runRemoteTask } from "./taskRunner.js";
import { formatReadableSummary } from "./formatSummary.js";

export async function handleMuseCliCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || "status").toLowerCase();

  if (subcommand === "status") {
    const cfg = loadRemoteAgentConfig();
    const isConfigured = Boolean(cfg.botToken && cfg.groupId && cfg.museBotId);
    const watched = getWatchedWorkspaces(cfg);

    console.log("Remote Agent (Muse) Status:");
    console.log(`  Configured      : ${isConfigured ? "Yes" : "No (run: superagent muse config)"}`);
    console.log(`  Runner Mode     : ${cfg.asRunner ? "ENABLED (normal terminal prompts route to Muse)" : "DISABLED"}`);
    console.log(`  Bot Token       : ${maskToken(cfg.botToken)}`);
    console.log(`  Telegram Group  : ${cfg.groupId || "(not set)"}`);
    console.log(`  Muse Bot ID     : ${cfg.museBotId || "(not set)"}`);
    if (watched.length > 1) {
      console.log(`  Watched Projects (${watched.length}):`);
      watched.forEach((w, i) => console.log(`    ${i + 1}. ${path.basename(w)} (${w})`));
    } else {
      console.log(`  Default Ws      : ${cfg.defaultWorkspace || process.cwd()}`);
    }
    console.log("");
    console.log("To set config:");
    console.log("  superagent muse config as_runner_model on");
    console.log("  superagent muse config botToken <token>");
    console.log("  superagent muse config groupId <groupId>");
    console.log("  superagent muse config museBotId <botId>");
    console.log("  superagent muse config workspaces add <path>");
    console.log("  superagent muse watch <dir1> <dir2> ...");
    return;
  }

  if (subcommand === "config") {
    const key = args[1]?.toLowerCase();
    const val = args.slice(2).join(" ").trim();

    if (!key) {
      const cfg = loadRemoteAgentConfig();
      const watched = getWatchedWorkspaces(cfg);
      console.log("Current Remote Agent Configuration:");
      console.log(`  as_runner_model  : ${cfg.asRunner ? "on (enabled)" : "off (disabled)"}`);
      console.log(`  botToken         : ${maskToken(cfg.botToken)}`);
      console.log(`  groupId          : ${cfg.groupId || "(not set)"}`);
      console.log(`  museBotId        : ${cfg.museBotId || "(not set)"}`);
      console.log(`  defaultWorkspace : ${cfg.defaultWorkspace || "(not set)"}`);
      console.log(`  watchedWorkspaces (${watched.length}):`);
      watched.forEach((w, i) => console.log(`    ${i + 1}. ${path.basename(w)} (${w})`));
      console.log("");
      console.log("Usage: superagent muse config <key> <value>");
      console.log("Examples:");
      console.log("  superagent muse config workspaces add ./backend");
      console.log("  superagent muse config workspaces add ./frontend");
      return;
    }

    if (key === "workspaces" || key === "workspace" || key === "projects") {
      if (!val || val === "list") {
        const list = getWatchedWorkspaces();
        console.log(`Watched workspaces (${list.length}):`);
        list.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
        return;
      }
      if (val.startsWith("add ")) {
        const p = val.slice(4).trim();
        const updated = addWatchedWorkspace(p);
        console.log(`Added watched workspace: ${p} (Total: ${updated.workspaces?.length || 1})`);
        return;
      }
      if (val.startsWith("remove ")) {
        const p = val.slice(7).trim();
        const updated = removeWatchedWorkspace(p);
        console.log(`Removed watched workspace: ${p} (Remaining: ${updated.workspaces?.length || 0})`);
        return;
      }
      const paths = val.split(/[,\s]+/).filter(Boolean);
      const updated = setWatchedWorkspaces(paths);
      console.log(`Watched workspaces set to (${updated.workspaces?.length || 0}):`);
      (updated.workspaces || []).forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
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
      asrunner: "asRunner",
      as_runner: "asRunner",
      asrunnermodel: "asRunner",
      as_runner_model: "asRunner",
      defaultrunner: "asRunner",
      default_runner: "asRunner",
    };

    const mappedKey = validKeys[key];
    if (!mappedKey) {
      console.error(`Unknown config key: ${key}. Valid keys: as_runner_model, botToken, groupId, museBotId, defaultWorkspace, workspaces`);
      return;
    }

    if (!val) {
      console.error(`Usage: superagent muse config ${key} <value>`);
      return;
    }

    const patch: Partial<RemoteAgentConfig> = {};
    if (mappedKey === "asRunner") {
      const lower = val.toLowerCase();
      if (["on", "true", "1", "yes", "enable", "enabled"].includes(lower)) {
        patch.asRunner = true;
      } else if (["off", "false", "0", "no", "disable", "disabled"].includes(lower)) {
        patch.asRunner = false;
      } else {
        console.error(`Invalid value for ${key}: "${val}". Use "on" or "off".`);
        return;
      }
    } else {
      (patch as any)[mappedKey] = val;
    }

    updateRemoteAgentConfig(patch);
    const maskedVal =
      mappedKey === "botToken"
        ? maskToken(val)
        : mappedKey === "asRunner"
          ? (patch.asRunner ? "on (enabled)" : "off (disabled)")
          : val;
    console.log(`Updated remoteAgent config: ${mappedKey} = ${maskedVal}`);
    return;
  }

  if (subcommand === "watch" || subcommand === "unwatch") {
    const action = subcommand === "unwatch" ? "stop" : (args[1]?.toLowerCase() || "start");
    const { startMuseWatcher, stopMuseWatcher, isMuseWatcherActive, getMuseWatcher } = await import("./museWatcher.js");

    if (action === "stop") {
      if (!isMuseWatcherActive()) {
        console.log("[Muse Watch] Watch mode is not currently running.");
        return;
      }
      await stopMuseWatcher();
      console.log("[Muse Watch] Watch mode stopped.");
      return;
    }

    if (action === "status") {
      const stats = getMuseWatcher()?.getStats();
      if (!stats || !stats.isRunning) {
        console.log("[Muse Watch] Watch mode is INACTIVE.");
        return;
      }
      console.log("Muse Watch Mode: ACTIVE (controlled by Muse)");
      if (stats.workspaces && stats.workspaces.length > 1) {
        console.log(`  Watched Projects (${stats.workspaces.length}):`);
        stats.workspaces.forEach((w, i) => console.log(`    ${i + 1}. ${path.basename(w)} (${w})`));
      } else {
        console.log(`  Workspace         : ${stats.workspace}`);
      }
      console.log(`  Telegram Group    : ${stats.groupId || "(not set)"}`);
      console.log(`  Muse Bot ID       : ${stats.museBotId || "(not set)"}`);
      console.log(`  Uptime            : ${stats.uptimeSeconds}s`);
      console.log(`  Batches Executed  : ${stats.batchesExecuted}`);
      console.log(`  Tasks Completed   : ${stats.tasksCompleted}`);
      console.log(`  Active Task       : ${stats.activeTaskId || "none (idle)"}`);
      return;
    }

    if (action === "add") {
      const dirToAdd = args.slice(2).join(" ").trim();
      if (!dirToAdd) {
        console.error("Usage: superagent muse watch add <project_directory>");
        return;
      }
      const resolved = path.resolve(dirToAdd);
      addWatchedWorkspace(resolved);
      getMuseWatcher()?.addWorkspace(resolved);
      console.log(`[Muse Watch] Added project "${path.basename(resolved)}" (${resolved}) to watched projects.`);
      return;
    }

    if (action === "remove") {
      const dirToRem = args.slice(2).join(" ").trim();
      if (!dirToRem) {
        console.error("Usage: superagent muse watch remove <project_directory>");
        return;
      }
      const resolved = path.resolve(dirToRem);
      removeWatchedWorkspace(resolved);
      getMuseWatcher()?.removeWorkspace(resolved);
      console.log(`[Muse Watch] Removed project "${path.basename(resolved)}" (${resolved}) from watched projects.`);
      return;
    }

    // Default: start
    const rawDirs = args[1]?.toLowerCase() === "start" ? args.slice(2) : args.slice(1);
    const targetDirs = rawDirs
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && d.toLowerCase() !== "start")
      .map((d) => path.resolve(d));

    const cfg = loadRemoteAgentConfig();
    const allWatched = targetDirs.length > 0 ? targetDirs : getWatchedWorkspaces(cfg);

    console.log("[Muse Watch] Starting persistent watch mode...");
    if (allWatched.length > 1) {
      console.log(`[Muse Watch] Watching ${allWatched.length} projects:`);
      allWatched.forEach((w, i) => console.log(`  ${i + 1}. ${path.basename(w)} (${w})`));
    } else {
      console.log(`[Muse Watch] Workspace: ${allWatched[0]}`);
    }
    console.log("[Muse Watch] Superagent is now controlled by Muse. Press Ctrl+C to stop.\n");

    try {
      const watcher = await startMuseWatcher({
        workspace: allWatched[0],
        workspaces: allWatched,
        onLine: (line) => console.log(line.content),
        onProgress: (msg) => console.log(`[Muse Progress] ${msg}`),
      });

      const handleExit = async () => {
        console.log("\n[Muse Watch] Shutting down watcher...");
        await watcher.stop();
        process.exit(0);
      };

      process.on("SIGINT", handleExit);
      process.on("SIGTERM", handleExit);

      // Keep process alive while watcher is active
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (!watcher.isActive()) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      });
    } catch (err: any) {
      console.error(`[Muse Watch Error] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Treat rest as a task
  const taskPrompt = args.join(" ").trim();
  if (!taskPrompt) {
    console.log("Usage: superagent muse [status|config|watch|<task prompt>]");
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
    console.log(formatReadableSummary(result.summary));
  } else {
    console.error(`\nTask Failed: ${result.error || "Unknown error"}`);
    process.exit(1);
  }
}
