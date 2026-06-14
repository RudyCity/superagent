import { execa } from "execa";
import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { listHistorySessions } from "../config.js";
import { searchHistory } from "../historySearch.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
  restoreCheckpointById,
  terminateActiveTasksAndSubagents,
} from "../checkpoints.js";

// /resume command
export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a conversation session from history via wizard dialog",
  execute(args, ctx) {
    const isMulti = ctx.agent?.isMultiAgent || false;
    const sessions = listHistorySessions(isMulti);
    const now = Date.now();
    if (sessions.length === 0) {
      ctx.addLine({ type: "system", content: "No previous sessions found. Start a conversation first!", timestamp: now });
      return;
    }
    const relTime = (d: Date) => {
      const diff = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diff < 60) return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    };
    const sessionOptions = sessions.map(
      (s) => `📁 ${s.displayName}  |  ${s.messageCount} msgs  |  ${relTime(s.lastModified)}`
    );
    ctx.setActiveWizard?.({
      type: "resume",
      step: 1,
      data: {},
    });
    ctx.setWizardOptions?.(sessionOptions);
    ctx.setWizardSelectedIndex?.(0);
  }
};

// /search-history command
export const searchHistoryCommand: SlashCommand = {
  name: "search-history",
  description: "Search all previous local workspace conversation history files",
  async execute(args, ctx) {
    const now = Date.now();
    if (!args) {
      ctx.addLine({
        type: "error",
        content: "Usage: /search-history <query-text>\nExample: /search-history refactor background task",
        timestamp: now,
      });
      return;
    }
    ctx.addLine({
      type: "system",
      content: `Searching conversation history for: "${args}"...`,
      timestamp: now,
    });
    ctx.setIsProcessing?.(true);
    try {
      const result = await searchHistory(args, ctx.agent?.isMultiAgent || false);
      ctx.addLine({
        type: "system",
        content: result,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `History search failed: ${err.message}`,
        timestamp: Date.now(),
      });
    } finally {
      ctx.setIsProcessing?.(false);
    }
  }
};

// /checkpoint command
export const checkpointCommand: SlashCommand = {
  name: "checkpoint",
  description: "Manage checkpoints to save/restore conversation state",
  async execute(args, ctx) {
    const now = Date.now();
    if (!ctx.agent) {
      ctx.addLine({ type: "error", content: "Agent not initialized.", timestamp: now });
      return;
    }

    const sessionFilePath = ctx.agent.getCurrentHistoryFilePath();
    const messages = ctx.agent.getHistory().getMessages();
    const planState = ctx.agent.planState;

    const parts = args.split(/\s+/);
    const subCommand = parts[0] ? parts[0].toLowerCase() : "";

    if (subCommand === "list") {
      ctx.addLine({ type: "system", content: "Retrieving checkpoints...", timestamp: now });
      try {
        const checkpoints = await listCheckpointsForSession(sessionFilePath);
        if (checkpoints.length === 0) {
          ctx.addLine({ type: "system", content: "No checkpoints found for this session.", timestamp: Date.now() });
          return;
        }
        const outputLines = [
          "┌───[ 📋 SESSION CHECKPOINTS ]",
          "│ ",
        ];
        checkpoints.forEach((c) => {
          const dateStr = new Date(c.timestamp).toLocaleTimeString();
          const gitInfo = c.gitSha ? ` | Git: ${c.gitSha}` : "";
          outputLines.push(`│ • ID  : ${c.id}`);
          outputLines.push(`│   Name: ${c.name} (${dateStr}${gitInfo})`);
          outputLines.push(`│   Msgs: ${c.messages.length} messages`);
          outputLines.push("│ ");
        });
        outputLines.pop();
        outputLines.push("└───────────────────────────────");
        ctx.addLine({ type: "system", content: outputLines.join("\n"), timestamp: Date.now() });
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to list checkpoints: ${err.message}`, timestamp: Date.now() });
      }
    } else if (subCommand === "restore") {
      const targetId = parts[1];
      if (!targetId) {
        ctx.addLine({ type: "error", content: "Usage: /checkpoint restore <checkpoint_id>", timestamp: now });
        return;
      }

      ctx.addLine({ type: "system", content: `Restoring checkpoint ${targetId}...`, timestamp: now });
      try {
        const checkpoint = await restoreCheckpointById(targetId, sessionFilePath);
        if (!checkpoint) {
          ctx.addLine({ type: "error", content: `Checkpoint with ID "${targetId}" not found.`, timestamp: Date.now() });
          return;
        }

        terminateActiveTasksAndSubagents();

        if (ctx.resumeFromPath) {
          await ctx.resumeFromPath(sessionFilePath);
        }
        ctx.setPlanState?.(checkpoint.planState);

        ctx.addLine({
          type: "system",
          content: `✓ Checkpoint "${checkpoint.name}" successfully restored! (${checkpoint.messages.length} messages)`,
          timestamp: Date.now()
        });

        if (checkpoint.gitSha) {
          const targetCwd = ctx.agent?.workingDirectory || process.cwd();
          try {
            await execa("git", ["stash", "--include-untracked"], { cwd: targetCwd, reject: false });
            const checkoutRes = await execa("git", ["checkout", checkpoint.gitSha], { cwd: targetCwd, reject: false });
            if (checkoutRes.failed) {
              ctx.addLine({
                type: "error",
                content: `Git restore gagal: ${checkoutRes.stderr || checkoutRes.message}. Riwayat percakapan tetap dipulihkan.`,
                timestamp: Date.now()
              });
            } else {
              ctx.addLine({
                type: "system",
                content: `✓ Workspace dipulihkan ke Git commit: ${checkpoint.gitSha} (uncommitted changes di-stash)`,
                timestamp: Date.now()
              });
            }
          } catch (gitErr: any) {
            ctx.addLine({
              type: "error",
              content: `Git restore gagal: ${gitErr.message}. Riwayat percakapan tetap dipulihkan.`,
              timestamp: Date.now()
            });
          }
        }
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: Date.now() });
      }
    } else {
      const checkpointName = args || `Manual: Checkpoint at ${new Date(now).toLocaleTimeString()}`;
      ctx.addLine({ type: "system", content: `Creating checkpoint "${checkpointName}"...`, timestamp: now });
      try {
        const c = await createCheckpoint(sessionFilePath, checkpointName, messages, planState, ctx.agent?.workingDirectory);
        const gitInfo = c.gitSha ? ` (Git: ${c.gitSha})` : "";
        ctx.addLine({
          type: "system",
          content: `✓ Checkpoint created successfully!\n  ID  : ${c.id}\n  Name: ${c.name}${gitInfo}`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to create checkpoint: ${err.message}`, timestamp: Date.now() });
      }
    }
  }
};

// Register session commands
registry.register(resumeCommand);
registry.register(searchHistoryCommand);
registry.register(checkpointCommand);
