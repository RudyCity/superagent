import { execa } from "execa";
import path from "path";
import { registry } from "./registry.js";
import { SlashCommand, SlashCommandContext } from "./types.js";
import { listHistorySessions, formatSessionLabel } from "../config.js";
import { searchHistory } from "../historySearch.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
  restoreCheckpointById,
  deleteCheckpointById,
  terminateActiveTasksAndSubagents,
} from "../checkpoints.js";

// /resume command
export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a conversation session from history via wizard dialog",
  execute(args, ctx) {
    const isMulti = ctx.agent?.isMultiAgent || false;
    const sessions = listHistorySessions(isMulti, false, ctx.agent?.workingDirectory, 20).slice(0, 10);
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
      (s) => `📁 ${formatSessionLabel(s)}  |  ${s.messageCount} msgs  |  ${relTime(s.lastModified)}`
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

export const searchHistoryCommand: SlashCommand = {
  name: "search-history",
  aliases: ["sh"],
  description: "Search conversation history. Use --all to search across ALL sessions/projects. Use --debug to show live AI matching steps.",
  async execute(args, ctx) {
    const now = Date.now();
    if (!args) {
      ctx.addLine({
        type: "error",
        content: "Usage: /search-history <query-text> [--all] [--debug]\n\nExamples:\n  /search-history refactor background task\n  /search-history auth login --all --debug    (search ALL sessions with live debug logs)",
        timestamp: now,
      });
      return;
    }

    // Check for flags: --all / -a and --debug / -d
    const hasAllFlag = args.includes("--all") || args.includes("-a");
    const hasDebugFlag = args.includes("--debug") || args.includes("-d");
    
    // Strip flags to get the raw search query
    const query = args.replace(/\b(--all|-a|--debug|-d)\b/g, "").trim().replace(/\s+/g, " ");
    
    if (!query) {
      ctx.addLine({
        type: "error",
        content: "Please provide a search query.",
        timestamp: now,
      });
      return;
    }

    const scope = hasAllFlag ? "ALL sessions (cross-project)" : "current workspace";
    ctx.addLine({
      type: "system",
      content: `Searching ${scope} for: "${query}"...`,
      timestamp: now,
    });
    
    const onDebug = hasDebugFlag
      ? (msg: string) => {
          ctx.addLine({
            type: "system",
            content: msg,
            timestamp: Date.now(),
          });
        }
      : undefined;

    ctx.setIsProcessing?.(true);
    try {
      const result = await searchHistory(query, ctx.agent?.isMultiAgent || false, hasAllFlag, onDebug);
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

// /knowledge command — browse global pinned knowledge
export const knowledgeCommand: SlashCommand = {
  name: "knowledge",
  aliases: ["k"],
  description: "Browse and search the global pinned knowledge store (cross-session)",
  async execute(args, ctx) {
    const now = Date.now();
    const trimmed = (args || "").trim();

    try {
      const { getAllKnowledge, searchKnowledge, getKnowledgeProjects, syncAllPinnedToRMemory } = await import("../pinnedKnowledge.js");
      // Fire-and-forget sync of existing pins to RMemory in the background
      syncAllPinnedToRMemory().catch(() => {});

      // /knowledge projects — list all projects with pinned knowledge
      if (trimmed === "projects" || trimmed === "p") {
        const projects = getKnowledgeProjects();
        if (projects.length === 0) {
          ctx.addLine({ type: "system", content: "No projects with pinned knowledge found.", timestamp: now });
          return;
        }
        const lines = ["📂 Projects with pinned knowledge:", ""];
        for (const p of projects) {
          const entries = getAllKnowledge({ workingDirectory: p, limit: 1 });
          lines.push(`  📁 ${p} (${entries.length}+ entries)`);
        }
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        return;
      }

      // /knowledge <query> — search
      if (trimmed && trimmed !== "list" && trimmed !== "l") {
        ctx.setIsProcessing?.(true);
        const results = await searchKnowledge(trimmed, { limit: 15 });
        if (results.length === 0) {
          ctx.addLine({ type: "system", content: `No pinned knowledge entries found for: "${trimmed}"`, timestamp: now });
          return;
        }
        const lines: string[] = [`📌 Found ${results.length} pinned knowledge entries for "${trimmed}":`, ""];
        for (let i = 0; i < results.length; i++) {
          const e = results[i];
          const tagStr = e.tag ? ` #${e.tag}` : "";
          const agentStr = e.agentTag ? ` [${e.agentTag.tier}${e.agentTag.subagentType ? ":" + e.agentTag.subagentType : ""}]` : "";
          lines.push(`  [${i + 1}] ${e.role.toUpperCase()}${agentStr}${tagStr}`);
          lines.push(`      ${e.preview.replace(/\n/g, " ").substring(0, 150)}`);
          lines.push(`      📁 ${e.workingDirectory}`);
          lines.push("");
        }
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: Date.now() });
        ctx.setIsProcessing?.(false);
        return;
      }

      // /knowledge or /knowledge list — show all entries
      const entries = getAllKnowledge({ limit: 20 });
      if (entries.length === 0) {
        ctx.addLine({
          type: "system",
          content: [
            "No pinned knowledge entries. Pins from any session are stored here.",
            "",
            "Usage:",
            "  /knowledge              Show all pinned knowledge entries",
            "  /knowledge <query>      Search pinned knowledge",
            "  /knowledge projects     List all projects with pins",
            "  /search-history <q> --all  Search history across all sessions",
          ].join("\n"),
          timestamp: now,
        });
        return;
      }

      const lines: string[] = [];
      lines.push("╔══════════════════════════════════════════════════════════════╗");
      lines.push("║            🌐 GLOBAL PINNED KNOWLEDGE                         ║");
      lines.push("╚══════════════════════════════════════════════════════════════╝");
      lines.push("");

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const tagStr = e.tag ? ` #${e.tag}` : "";
        const agentStr = e.agentTag ? ` [${e.agentTag.tier}${e.agentTag.subagentType ? ":" + e.agentTag.subagentType : ""}]` : "";
        const preview = e.preview.replace(/\n/g, " ").substring(0, 120);

        lines.push(`  📌 [${i + 1}] ${e.role.toUpperCase()}${agentStr}${tagStr}`);
        lines.push(`     ${preview}`);
        lines.push(`     📁 ${e.workingDirectory}  |  pinned ${timeAgo(e.pinnedAt)}`);
        lines.push("");
      }

      lines.push("──────────────────────────────────────────────────────────────");
      lines.push(`  ${entries.length} entries shown  |  AI agents can use search_pinned_knowledge & load_pinned_session tools`);
      lines.push("");
      lines.push("  /knowledge <query>      Search knowledge");
      lines.push("  /knowledge projects     List projects with pins");
      lines.push("  /search-history <q> --all  Search full history cross-project");

      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
    } catch (err: any) {
      ctx.addLine({ type: "error", content: `Knowledge command failed: ${err.message}`, timestamp: now });
    }
  }
};

/** Helper: format timestamp to relative time (same as pinCommand) */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// Helper: open checkpoint wizard
async function openCheckpointWizard(ctx: SlashCommandContext, action: "browse" | "restore" | "delete") {
  const now = Date.now();
  if (!ctx.agent) {
    ctx.addLine({ type: "error", content: "Agent not initialized.", timestamp: now });
    return;
  }
  const sessionFilePath = ctx.agent.getCurrentHistoryFilePath();
  ctx.setIsProcessing?.(true);
  try {
    const checkpoints = await listCheckpointsForSession(sessionFilePath);
    if (checkpoints.length === 0) {
      ctx.addLine({ type: "system", content: "No checkpoints found. Use /checkpoint <name> to create one.", timestamp: Date.now() });
      return;
    }
    ctx.setCheckpointsList?.(checkpoints);
    const relTime = (ts: number) => {
      const diff = Math.floor((Date.now() - ts) / 1000);
      if (diff < 60) return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    };
    const actionPrefix = action === "restore" ? "🔄 " : action === "delete" ? "🗑️ " : "📌 ";
    const options = checkpoints.map((c) => {
      const gitTag = c.gitSha ? ` [${c.gitSha}]` : "";
      return `${actionPrefix}${c.name}  |  ${c.messages.length} msgs  |  ${relTime(c.timestamp)}${gitTag}`;
    });
    ctx.setActiveWizard?.({ type: "checkpoint", step: 1, data: { action } });
    ctx.setWizardOptions?.(options);
    ctx.setWizardSelectedIndex?.(0);
  } catch (err: any) {
    ctx.addLine({ type: "error", content: `Failed to list checkpoints: ${err.message}`, timestamp: Date.now() });
  } finally {
    ctx.setIsProcessing?.(false);
  }
}

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

    if (subCommand === "list" || subCommand === "") {
      // Show interactive wizard for browsing checkpoints
      await openCheckpointWizard(ctx, "browse");
    } else if (subCommand === "restore") {
      const targetId = parts[1];
      if (!targetId) {
        // No ID provided → show wizard filtered for restore
        await openCheckpointWizard(ctx, "restore");
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
                content: `Git restore failed: ${checkoutRes.stderr || checkoutRes.message}. Conversation history still restored.`,
                timestamp: Date.now()
              });
            } else {
              ctx.addLine({
                type: "system",
                content: `✓ Workspace restored to Git commit: ${checkpoint.gitSha} (uncommitted changes stashed)`,
                timestamp: Date.now()
              });
            }
          } catch (gitErr: any) {
            ctx.addLine({
              type: "error",
              content: `Git restore failed: ${gitErr.message}. Conversation history still restored.`,
              timestamp: Date.now()
            });
          }
        }
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: Date.now() });
      }
    } else if (subCommand === "delete") {
      const targetId = parts[1];
      if (!targetId) {
        // No ID provided → show wizard filtered for delete
        await openCheckpointWizard(ctx, "delete");
        return;
      }

      ctx.addLine({ type: "system", content: `Deleting checkpoint ${targetId}...`, timestamp: now });
      try {
        const deleted = await deleteCheckpointById(targetId, sessionFilePath);
        if (deleted) {
          ctx.addLine({
            type: "system",
            content: `✓ Checkpoint "${targetId}" deleted successfully.`,
            timestamp: Date.now(),
          });
        } else {
          ctx.addLine({
            type: "error",
            content: `Checkpoint with ID "${targetId}" not found.`,
            timestamp: Date.now(),
          });
        }
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to delete checkpoint: ${err.message}`, timestamp: Date.now() });
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

// /history command
export const historyCommand: SlashCommand = {
  name: "history",
  description: "Manage SQLite history database (export session, backup database, migrate legacy files)",
  async execute(args, ctx) {
    const now = Date.now();
    const parts = args.trim().split(/\s+/);
    const action = parts[0] ? parts[0].toLowerCase() : "";

    if (action === "export") {
      const sessionId = parts[1] || (ctx.agent ? path.basename(ctx.agent.getCurrentHistoryFilePath(), ".json") : "");
      if (!sessionId) {
        ctx.addLine({ type: "error", content: "Usage: /history export <session_id>", timestamp: now });
        return;
      }
      try {
        const { exportSessionToJson } = await import("../storage/historyDb.js");
        const exported = exportSessionToJson(sessionId);
        if (!exported) {
          ctx.addLine({ type: "error", content: `Session "${sessionId}" not found in database.`, timestamp: now });
          return;
        }
        ctx.addLine({
          type: "system",
          content: `Exported session "${sessionId}":\n\n${exported.slice(0, 1000)}${exported.length > 1000 ? "\n... [truncated]" : ""}`,
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to export session: ${err.message}`, timestamp: now });
      }
    } else if (action === "backup") {
      try {
        const { backupDatabase } = await import("../storage/historyDb.js");
        const backupPath = backupDatabase(parts[1]);
        ctx.addLine({ type: "system", content: `✓ Database backed up successfully to:\n  ${backupPath}`, timestamp: now });
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to backup database: ${err.message}`, timestamp: now });
      }
    } else if (action === "migrate") {
      try {
        const { migrateLegacyJsonToDb, migrateLegacyCheckpointsToDb } = await import("../storage/historyDb.js");
        const count = migrateLegacyJsonToDb();
        const cpCount = migrateLegacyCheckpointsToDb();
        ctx.addLine({ type: "system", content: `✓ Migrated ${count} sessions and ${cpCount} checkpoints into SQLite database.`, timestamp: now });
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Migration failed: ${err.message}`, timestamp: now });
      }
    } else if (action === "stats") {
      try {
        const { getDatabaseStats } = await import("../storage/historyDb.js");
        const stats = getDatabaseStats();
        ctx.addLine({
          type: "system",
          content: [
            "📊 SQLite Database Metrics (history.db)",
            `  Database File  : ${stats.dbPath}`,
            `  Size on Disk   : ${stats.dbSizeMb} MB`,
            `  Journal Mode   : ${stats.journalMode.toUpperCase()} (WAL Enabled)`,
            `  Total Sessions : ${stats.sessionCount}`,
            `  Total Messages : ${stats.messageCount}`,
            `  Compaction Logs: ${stats.compactionCount}`,
            `  Checkpoints    : ${stats.checkpointCount}`,
            `  Daily Backups  : ${stats.backupCount} files`,
          ].join("\n"),
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to fetch stats: ${err.message}`, timestamp: now });
      }
    } else if (action === "tag") {
      const sessionId = parts[1];
      const tagLabel = parts.slice(2).join(" ").trim();
      if (!sessionId || !tagLabel) {
        ctx.addLine({ type: "error", content: "Usage: /history tag <session_id> <tag_label>", timestamp: now });
        return;
      }
      try {
        const { tagSessionInDb } = await import("../storage/historyDb.js");
        const updated = tagSessionInDb(sessionId, tagLabel);
        if (updated) {
          ctx.addLine({ type: "system", content: `✓ Tagged session "${sessionId}" with label "${tagLabel}".`, timestamp: now });
        } else {
          ctx.addLine({ type: "error", content: `Session "${sessionId}" not found.`, timestamp: now });
        }
      } catch (err: any) {
        ctx.addLine({ type: "error", content: `Failed to tag session: ${err.message}`, timestamp: now });
      }
    } else {
      ctx.addLine({
        type: "system",
        content: [
          "Usage:",
          "  /history stats              - View database metrics, file size & counts",
          "  /history tag <id> <tag>     - Tag a session with custom labels",
          "  /history export [id]        - Export session to JSON string",
          "  /history backup [path]      - Create a backup of history.db",
          "  /history migrate           - Auto-import legacy files into SQLite",
          "  /history clean             - Purge legacy JSON files",
        ].join("\n"),
        timestamp: now,
      });
    }
  }
};

// Auto-run legacy migration, cleanup, and rolling backup on startup
try {
  import("../storage/historyDb.js").then((mod) => {
    mod.migrateLegacyJsonToDb();
    mod.cleanLegacyJsonFiles();
    mod.migrateLegacyCheckpointsToDb();
    mod.cleanLegacyCheckpointsFiles();
    mod.migrateLegacyInputHistoryToDb();
    mod.cleanLegacyInputHistoryFiles();
    mod.performRollingBackup();
  }).catch(() => {});
} catch {}

export const sessionSlashCommand: SlashCommand = {
  name: "session",
  aliases: ["sess"],
  description: "Manage session history: list, export <id>, clear --empty",
  async execute(args, ctx) {
    const now = Date.now();
    const parts = (args || "").trim().split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() || "list";

    if (action === "list" || action === "ls") {
      const isAll = parts.includes("--all") || parts.includes("-a");
      const isMulti = ctx.agent?.isMultiAgent || false;
      const sessions = listHistorySessions(isMulti, isAll, ctx.agent?.workingDirectory, 20);

      if (sessions.length === 0) {
        ctx.addLine({ type: "system", content: "No conversation sessions found.", timestamp: now });
        return;
      }

      const lines = [`📋 Active & Past Sessions (${isAll ? "All Workspaces" : "Current Workspace"}):`, ""];
      for (const s of sessions) {
        lines.push(`  ID: ${s.id}`);
        lines.push(`  Name: ${formatSessionLabel(s)} | Msgs: ${s.messageCount} | Last Modified: ${s.lastModified.toLocaleString()}`);
        lines.push("");
      }
      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
      return;
    }

    if (action === "export") {
      const sessionId = parts[1];
      if (!sessionId) {
        ctx.addLine({ type: "error", content: "Usage: /session export <sessionId> [markdown|json]", timestamp: now });
        return;
      }
      const format = parts[2]?.toLowerCase() === "json" ? "json" : "markdown";
      const { exportSession } = await import("../config/history.js");
      const exported = exportSession(sessionId, format);
      if (!exported) {
        ctx.addLine({ type: "error", content: `Session "${sessionId}" not found.`, timestamp: now });
      } else {
        ctx.addLine({ type: "system", content: `Session "${sessionId}" Export:\n\n${exported}`, timestamp: now });
      }
      return;
    }

    if (action === "clear" || action === "purge") {
      const { purgeEmptySessions } = await import("../config/history.js");
      const res = purgeEmptySessions(0);
      ctx.addLine({ type: "system", content: `✓ Cleaned up ${res.purgedCount} empty draft sessions.`, timestamp: now });
      return;
    }

    ctx.addLine({
      type: "system",
      content: [
        "Usage:",
        "  /session list [--all]         - List active and past sessions",
        "  /session export <id> [format] - Export session to Markdown or JSON",
        "  /session clear --empty        - Purge empty draft sessions (0 messages)",
      ].join("\n"),
      timestamp: now,
    });
  }
};

// Register session commands
registry.register(resumeCommand);
registry.register(searchHistoryCommand);
registry.register(checkpointCommand);
registry.register(knowledgeCommand);
registry.register(historyCommand);
registry.register(sessionSlashCommand);


