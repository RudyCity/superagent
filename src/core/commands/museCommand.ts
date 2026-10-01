import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext, ChatLine } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  RemoteAgentConfig,
} from "../remoteAgent/config.js";

export const museCommand: SlashCommand = {
  name: "muse",
  description: "Coordinate with remote AI agent (Muse) over Telegram bot bus",
  async execute(args, ctx) {
    const rawTrimmed = args.trim();
    const parts = rawTrimmed.split(/\s+/).filter(Boolean);
    const subcommand = (parts[0] || "").toLowerCase();
    const now = Date.now();

    // /muse status
    if (subcommand === "status") {
      const cfg = loadRemoteAgentConfig();
      const workspace = cfg.defaultWorkspace || ctx.agent?.workingDirectory || process.cwd();
      const isConfigured = Boolean(cfg.botToken && cfg.groupId && cfg.museBotId);

      let botInfoStr = "";
      let privacyInfo = "";
      if (cfg.botToken) {
        try {
          const { MuseClient } = await import("../remoteAgent/museClient.js");
          const client = new MuseClient(cfg);
          const me = await client.getMeInfo();
          if (me.ok) {
            botInfoStr = ` (@${me.username || me.firstName})`;
            if (me.canReadGroupMessages === false) {
              privacyInfo = "- Group Privacy   : ENABLED (WARNING: Telegram blocks non-reply messages! Run /setprivacy -> @bot -> Disable in @BotFather)\n";
            } else {
              privacyInfo = "- Group Privacy   : DISABLED (OK: Bot reads all group messages)\n";
            }
          } else {
            botInfoStr = ` (Error: ${me.error})`;
          }
        } catch {}
      }

      const lines = [
        "Remote Agent (Muse) Status:",
        `- Configured      : ${isConfigured ? "Yes" : "No (run /muse config)"}`,
        `- Runner Mode     : ${cfg.asRunner ? "ENABLED (All terminal prompts automatically route to Muse)" : "DISABLED (type /muse <task> to coordinate with Muse)"}`,
        `- Bot Token       : ${maskToken(cfg.botToken)}${botInfoStr}`,
        privacyInfo ? privacyInfo.trimEnd() : null,
        `- Telegram Group  : ${cfg.groupId || "(not set)"}`,
        `- Muse Bot ID     : ${cfg.museBotId || "(not set)"}`,
        `- Workspace       : ${workspace}`,
        "",
        "Architecture:",
        "- Muse acts as the remote brain over a private Telegram group bus.",
        "- Superagent acts as the local hands, executing batches of file/read/edit tools.",
        "",
        "Usage:",
        "  /muse <task>                 - Run a task with remote Muse brain",
        "  /muse status                 - View remote agent status",
        "  /muse config <key> <val>     - Set config key (botToken, groupId, museBotId, as_runner_model)",
      ].filter(Boolean) as string[];

      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
      return;
    }

    // /muse config [key] [val]
    if (subcommand === "config") {
      const key = parts[1]?.toLowerCase();
      const val = parts.slice(2).join(" ").trim();

      if (!key) {
        const cfg = loadRemoteAgentConfig();
        const lines = [
          "Remote Agent Configuration:",
          `- as_runner_model : ${cfg.asRunner ? "on (enabled)" : "off (disabled)"}`,
          `- botToken         : ${maskToken(cfg.botToken)}`,
          `- groupId          : ${cfg.groupId || "(not set)"}`,
          `- museBotId        : ${cfg.museBotId || "(not set)"}`,
          `- defaultWorkspace : ${cfg.defaultWorkspace || "(default to current workspace)"}`,
          "",
          "Usage: /muse config <key> <value>",
          "Keys:",
          "  as_runner_model  - Route all terminal prompts to Muse directly without /muse (on/off)",
          "  botToken         - Bot B (superagent's Telegram bot token)",
          "  groupId          - Numeric private group chat ID (e.g. -100xxxxxxxxxx)",
          "  museBotId        - Numeric Telegram user ID of Muse bot (Bot A)",
          "  defaultWorkspace - Default project workspace path",
          "",
          "Example:",
          "  /muse config as_runner_model on",
          "  /muse config botToken 123456789:ABCdef...",
          "  /muse config groupId -1001234567890",
          "  /muse config museBotId 987654321",
        ];
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
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
        workspace: "defaultWorkspace",
        asrunner: "asRunner",
        as_runner: "asRunner",
        asrunnermodel: "asRunner",
        as_runner_model: "asRunner",
        defaultrunner: "asRunner",
        default_runner: "asRunner",
      };

      const mappedKey = validKeys[key];
      if (!mappedKey) {
        ctx.addLine({
          type: "error",
          content: `Unknown config key: "${key}". Valid keys: as_runner_model, botToken, groupId, museBotId, defaultWorkspace`,
          timestamp: now,
        });
        return;
      }

      if (!val) {
        ctx.addLine({
          type: "error",
          content: `Usage: /muse config ${key} <value>`,
          timestamp: now,
        });
        return;
      }

      const patch: Partial<RemoteAgentConfig> = {};
      if (mappedKey === "asRunner") {
        const lowerVal = val.toLowerCase();
        if (["on", "true", "1", "yes", "enable", "enabled"].includes(lowerVal)) {
          patch.asRunner = true;
        } else if (["off", "false", "0", "no", "disable", "disabled"].includes(lowerVal)) {
          patch.asRunner = false;
        } else {
          ctx.addLine({
            type: "error",
            content: `Invalid value for ${key}: "${val}". Use "on" or "off".`,
            timestamp: now,
          });
          return;
        }
      } else if (mappedKey === "botToken") {
        patch.botToken = val;
      } else if (mappedKey === "groupId") {
        patch.groupId = val;
      } else if (mappedKey === "museBotId") {
        patch.museBotId = val;
      } else if (mappedKey === "defaultWorkspace") {
        patch.defaultWorkspace = val;
      }

      updateRemoteAgentConfig(patch);
      const maskedConfirmation =
        mappedKey === "botToken"
          ? maskToken(val)
          : mappedKey === "asRunner"
            ? (patch.asRunner ? "on (enabled)" : "off (disabled)")
            : val;

      ctx.addLine({
        type: "system",
        content: `Remote agent configuration updated: ${mappedKey} = ${maskedConfirmation}`,
        timestamp: now,
      });
      return;
    }

    // Default: /muse <task>
    if (!rawTrimmed) {
      ctx.addLine({
        type: "system",
        content: [
          "Usage: /muse <task description>",
          "Example: /muse cari semua TODO di src",
          "Subcommands:",
          "  /muse status",
          "  /muse config <key> <value>",
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    const { runRemoteTask } = await import("../remoteAgent/taskRunner.js");
    const workspace = ctx.agent?.workingDirectory || process.cwd();

    // Check Telegram Group Privacy Mode status to proactively warn user if misconfigured
    const cfg = loadRemoteAgentConfig();
    if (cfg.botToken) {
      try {
        const { MuseClient } = await import("../remoteAgent/museClient.js");
        const client = new MuseClient(cfg);
        const me = await client.getMeInfo();
        if (me.ok && me.canReadGroupMessages === false) {
          ctx.addLine({
            type: "system",
            content: [
              `⚠️  [Muse Warning] Telegram Group Privacy Mode is ENABLED for @${me.username || "your_bot"}.`,
              "   Telegram will NOT deliver standalone messages from Muse in group chats!",
              "   To fix: Open @BotFather in Telegram -> send /setprivacy -> select bot -> Disable.",
              "   Alternatively, instruct Muse to reply directly to bot messages.",
            ].join("\n"),
            timestamp: now,
          });
        }
      } catch {}
    }

    ctx.addLine({
      type: "system",
      content: `[Muse] Initiating remote task in workspace: ${workspace}\nTask: "${rawTrimmed}"`,
      timestamp: now,
    });

    ctx.setIsProcessing?.(true);

    const assistantTimestamp = Date.now();
    let assistantLineCreated = false;
    const ensureAssistantLine = () => {
      if (assistantLineCreated) return;
      assistantLineCreated = true;
      if (ctx.setLines) {
        ctx.setLines((prev) => [
          ...prev,
          {
            type: "assistant",
            content: "",
            timestamp: assistantTimestamp,
            children: [],
          },
        ]);
      }
    };

    try {
      const result = await runRemoteTask({
        task: rawTrimmed,
        workspace,
        agent: ctx.agent,
        onToolStart: (toolCall, description) => {
          ensureAssistantLine();
          if (ctx.agent?.onEvent) {
            ctx.agent.onEvent({
              type: "tool_start",
              toolCall,
              description,
            });
            return;
          }
          if (ctx.setLines) {
            const child: ChatLine = {
              type: "tool_start",
              content: `⚡ ${description}\n   Detail: ${toolCall.name}(${JSON.stringify(toolCall.args || {})})`,
              timestamp: Date.now(),
            };
            ctx.setLines((prev) => {
              if (prev.length === 0) {
                return [{ type: "assistant", content: "", timestamp: Date.now(), children: [child] }];
              }
              const last = prev[prev.length - 1];
              if (last.type === "assistant") {
                const updated = [...prev];
                updated[prev.length - 1] = {
                  ...last,
                  children: [...(last.children || []), child],
                };
                return updated;
              }
              return [...prev, { type: "assistant", content: "", timestamp: Date.now(), children: [child] }];
            });
          }
        },
        onToolEnd: (toolCall, toolResult, description) => {
          if (ctx.agent?.onEvent) {
            ctx.agent.onEvent({
              type: "tool_end",
              toolCall,
              toolResult,
              description,
            });
            return;
          }
          if (ctx.setLines) {
            const resultContent = toolResult.isError
              ? `Detail: ${toolResult.result}`
              : `Output: ${String(toolResult.result).slice(0, 500)}${String(toolResult.result).length > 500 ? "..." : ""}`;
            ctx.setLines((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].type === "assistant" && prev[i].children) {
                  const children = prev[i].children!;
                  for (let c = children.length - 1; c >= 0; c--) {
                    if (children[c].type === "tool_start" && !children[c].mergedResult) {
                      const updated = [...prev];
                      const updatedChildren = [...children];
                      updatedChildren[c] = {
                        ...updatedChildren[c],
                        mergedResult: {
                          isError: !!toolResult.isError,
                          content: resultContent,
                          description,
                        },
                      };
                      updated[i] = {
                        ...updated[i],
                        children: updatedChildren,
                      };
                      return updated;
                    }
                  }
                }
              }
              return prev;
            });
          }
        },
        onProgress: (msg) => {
          if (ctx.agent?.onEvent) {
            ctx.agent.onEvent({
              type: "tool_progress",
              toolCallId: "muse_progress",
              message: msg,
            });
          }
          if (msg.startsWith("Warning") || msg.startsWith("Duplicate") || msg.startsWith("Waiting")) {
            ctx.addLine({
              type: "system",
              content: `[Muse] ${msg}`,
              timestamp: Date.now(),
            });
          }
        },
        onChat: (msg) => {
          if (ctx.agent?.onEvent) {
            ctx.agent.onEvent({
              type: "reasoning",
              content: `\n[Muse Note]: ${msg}\n`,
            });
          }
          ctx.addLine({
            type: "assistant",
            content: `[Muse Note]: ${msg}`,
            timestamp: Date.now(),
          });
        },
      });

      if (result.success) {
        if (assistantLineCreated && ctx.setLines) {
          ctx.setLines((prev) => {
            let found = false;
            const updated = prev.map((l) => {
              if (l.type === "assistant" && l.timestamp === assistantTimestamp) {
                found = true;
                return {
                  ...l,
                  content: result.summary,
                };
              }
              return l;
            });
            if (found) {
              return updated;
            }
            return [
              ...prev,
              {
                type: "assistant",
                content: result.summary,
                timestamp: Date.now(),
              },
            ];
          });
        } else {
          ctx.addLine({
            type: "assistant",
            content: result.summary,
            timestamp: Date.now(),
          });
        }

        // Persist interaction to conversation history & SQLite database if agent is present
        if (ctx.agent) {
          try {
            ctx.agent.getHistory().addUserMessage(rawTrimmed);
            ctx.agent.getHistory().addAssistantMessage(result.summary);
            const histPath = ctx.agent.getCurrentHistoryFilePath?.();
            if (histPath) {
              await ctx.agent.getHistory().saveToFile(
                histPath,
                ctx.agent.planState,
                ctx.agent.workingDirectory
              );
            }
          } catch {}
        }
      } else {
        ctx.addLine({
          type: "error",
          content: `Remote task failed: ${result.error || "Unknown error"}`,
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to execute remote task: ${err.message}`,
        timestamp: Date.now(),
      });
    } finally {
      ctx.setIsProcessing?.(false);
    }
  },
};

registry.register(museCommand);
