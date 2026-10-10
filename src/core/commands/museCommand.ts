import path from "path";
import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext, ChatLine } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  maskSecret,
  isMuseWsActive,
  RemoteAgentConfig,
  RemoteAgentTransport,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  setWatchedWorkspaces,
} from "../remoteAgent/config.js";
import { formatReadableSummary } from "../remoteAgent/formatSummary.js";

export const museCommand: SlashCommand = {
  name: "muse",
  description: "Coordinate with remote AI agent (Muse) over Cloudflare Tunnel / WebSocket or Telegram",
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

      const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
      const wsStatusStr = watchedWorkspaces.length > 1
        ? `- Watched Projects (${watchedWorkspaces.length}):\n${watchedWorkspaces.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
        : `- Workspace       : ${workspace}`;

      const transport = cfg.transport || "telegram";
      const isConfiguredEffective = transport === "websocket" ? isMuseWsActive() : isConfigured;

      const { getTunnelStatus, listActiveTunnels } = await import("../remoteAgent/cloudflareTunnel.js");
      const activeTunnels = listActiveTunnels();
      const defaultPort = cfg.wsPort || 9225;
      const wsTunnel = getTunnelStatus(defaultPort);
      const httpsTunnel = getTunnelStatus(7888);
      const firstActive = activeTunnels[0];
      const tunnelStatus = wsTunnel.isRunning
        ? wsTunnel
        : (httpsTunnel.isRunning
          ? httpsTunnel
          : (firstActive ? { isRunning: true, ...firstActive } : wsTunnel));

      const tunnelHeader = activeTunnels.length > 1
        ? `ACTIVE (${activeTunnels.length} running: ${activeTunnels.map((t) => `port ${t.port}`).join(", ")})`
        : (tunnelStatus.isRunning
          ? `ACTIVE (${tunnelStatus.wssUrl}, PID: ${tunnelStatus.pid}${tunnelStatus.port && tunnelStatus.port !== defaultPort ? `, Port: ${tunnelStatus.port}` : ""})`
          : "INACTIVE (run /muse tunnel start)");

      const multipleTunnelLines = activeTunnels.length > 1
        ? activeTunnels.map((t, idx) => `   ${idx + 1}. Port ${t.port}: ${t.wssUrl} (PID: ${t.pid}, Uptime: ${t.uptimeSeconds}s)`)
        : [];

      const transportLines = transport === "websocket"
        ? [
            `- Transport       : WEBSOCKET (${(cfg.wsMode || "server").toUpperCase()})`,
            `- WS Endpoint     : ws://${cfg.wsHost || "127.0.0.1"}:${defaultPort}${cfg.wsPath || "/muse"}`,
            `- Quick Tunnel    : ${tunnelHeader}`,
            ...multipleTunnelLines,
            `- Bearer Token    : ${maskSecret(cfg.wsToken)}`,
            `- CF-Access ID    : ${cfg.cfAccessClientId || "(disabled)"}`,
            cfg.wsMode === "client" ? `- Remote URL      : ${cfg.wsRemoteUrl || "(not set)"}` : null,
          ].filter(Boolean) as string[]
        : [
            `- Transport       : TELEGRAM`,
            `- Bot Token       : ${maskToken(cfg.botToken)}${botInfoStr}`,
            privacyInfo ? privacyInfo.trimEnd() : null,
            `- Telegram Group  : ${cfg.groupId || "(not set)"}`,
            `- Muse Bot ID     : ${cfg.museBotId || "(not set)"}`,
          ];

      const lines = [
        "Remote Agent (Muse) Status:",
        `- Configured      : ${isConfiguredEffective ? "Yes" : "No (run /muse config)"}`,
        `- Runner Mode     : ${cfg.asRunner ? "ENABLED (All terminal prompts automatically route to Muse)" : "DISABLED (type /muse <task> to coordinate with Muse)"}`,
        ...transportLines,
        wsStatusStr,
        "",
        "Architecture:",
        "- Muse acts as the remote cognitive brain over WebSocket (Cloudflare Tunnel) or Telegram bus.",
        "- Superagent acts as the local hands, executing batches of file/read/edit tools in a secure sandbox.",
        "",
        "Usage:",
        "  /muse <task>                 - Run a task with remote Muse brain",
        "  /muse status                 - View remote agent status",
        "  /muse tunnel                 - Cloudflare Tunnel setup guide & config",
        "  /muse tunnel list            - List all currently active Cloudflare tunnels",
        "  /muse tunnel start           - Start quick ephemeral Cloudflare Tunnel (optional: --port <n>)",
        "  /muse tunnel start --mcp      - MCP server ONLY via tunnel, no WSS (opts: --mcp-port <n>, --allow-dangerous, --mcp-auth static-bearer|oauth)",
        "  /muse tunnel stop            - Stop active Cloudflare Tunnel (optional: --port <n> or all)",
        "  /muse tunnel msg <text>       - Send a chat message to Muse via the tunnel",
        "  ESC (tunnel active)          - Open tunnel menu: stop / message Muse / continue",
        "  /muse tunnel restart         - Restart active Cloudflare Tunnel and watch daemon",
        "  /muse tunnel status          - Check Cloudflare Tunnel process status (optional: --port <n>)",
        "  /muse tunnel prompt          - View and copy connection prompt for Muse",
        "  /muse watch [dir1] [dir2]    - Watch one or multiple project workspaces",
        "  /muse watch --ws             - Watch projects using secure WebSocket transport",
        "  /muse watch --tunnel         - Watch projects and expose via Cloudflare Tunnel",
        "  /muse watch add <dir>        - Add project to active watch session",
        "  /muse watch remove <dir>     - Remove project from active watch session",
        "  /muse stop                   - Cancel active remote task and notify Muse",
        "  /muse cancel                 - Cancel active remote task and notify Muse",
        "  /muse msg <text>             - Send chat message directly to Telegram group (aliases: /muse send, /muse tg)",
        "  /muse steer <msg>            - Intervene and steer Muse with counter-instructions (alias: /muse chat)",
        "  /muse doctor                 - Run diagnostic checks (cloudflared, ports, credentials)",
        "  /muse connect                - Test connection to remote Muse endpoint",
        "  /muse new                    - Reset remote session memory",
        "  /muse reset                  - Reset remote session memory",
        "  /muse config                 - View current remote agent configuration",
        "  /muse config <key> <val>     - Set config key (transport, wsToken, wsPort, botToken, etc.)",
      ].filter(Boolean) as string[];

      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
      return;
    }

    // /muse tunnel or /muse cloudflare
    if (subcommand === "tunnel" || subcommand === "cloudflare") {
      const { handleMuseTunnelSubcommand } = await import("./museTunnelSubcommand.js");
      return handleMuseTunnelSubcommand(parts, ctx, now);
    }

    // /muse doctor or /muse ping or /muse test
    if (subcommand === "doctor" || subcommand === "ping" || subcommand === "test") {
      const { handleMuseDoctorSubcommand } = await import("./museDoctorSubcommand.js");
      return handleMuseDoctorSubcommand(parts, ctx, now);
    }

    // /muse connect
    if (subcommand === "connect") {
      const { handleMuseConnectSubcommand } = await import("./museDoctorSubcommand.js");
      return handleMuseConnectSubcommand(parts, ctx, now);
    }

    // /muse start [options]
    if (subcommand === "start") {
      const isTunnel = parts.some((p) => p === "--tunnel" || p === "--quick-tunnel" || p === "--https");
      if (isTunnel) {
        const { handleMuseTunnelSubcommand } = await import("./museTunnelSubcommand.js");
        return handleMuseTunnelSubcommand(parts, ctx, now);
      }
      const watchArgs = ["watch", ...parts.slice(1)].join(" ");
      return museCommand.execute(watchArgs, ctx);
    }

    // /muse restart [options]
    if (subcommand === "restart") {
      const isTunnel = parts.some((p) => p === "--tunnel" || p === "--quick-tunnel" || p === "--https");
      if (isTunnel) {
        const { handleMuseTunnelSubcommand } = await import("./museTunnelSubcommand.js");
        return handleMuseTunnelSubcommand(["tunnel", ...parts], ctx, now);
      }
      const { isMuseWatcherActive, stopMuseWatcher } = await import("../remoteAgent/museWatcher.js");
      if (isMuseWatcherActive()) {
        await stopMuseWatcher();
        ctx.addLine({
          type: "system",
          content: "[Muse Watch] Watch mode stopped. Restarting...",
          timestamp: now,
        });
      }
      const watchArgs = ["watch", ...parts.slice(1)].join(" ");
      return museCommand.execute(watchArgs, ctx);
    }

    // /muse config [key] [val]
    if (subcommand === "config") {
      const { handleMuseConfigSubcommand } = await import("./museConfigSubcommand.js");
      await handleMuseConfigSubcommand(parts, ctx, now);
      return;
    }

    // /muse new or /muse reset
    if (subcommand === "new" || subcommand === "reset") {
      const cfg = loadRemoteAgentConfig();
      if (!cfg.botToken || !cfg.groupId) {
        ctx.addLine({
          type: "error",
          content: "Remote agent (Muse) is not configured. Run /muse config.",
          timestamp: now,
        });
        return;
      }
      const { getMuseWatcher, isMuseWatcherActive } = await import("../remoteAgent/museWatcher.js");
      if (isMuseWatcherActive()) {
        getMuseWatcher()?.resetLocalSession("from terminal");
      }
      const { notifyMuseSessionReset } = await import("../remoteAgent/taskRunner.js");
      ctx.addLine({
        type: "system",
        content: "[Muse] Resetting remote session context on Telegram...",
        timestamp: now,
      });
      const ok = await notifyMuseSessionReset(ctx.agent?.sessionId);
      if (ok) {
        ctx.addLine({
          type: "system",
          content: "[Muse] Remote session context has been reset. Muse will start next task with fresh context.",
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "error",
          content: "[Muse] Failed to send reset notification to Telegram. Check bot configuration.",
          timestamp: now,
        });
      }
      return;
    }

    // /muse stop or /muse cancel
    if (subcommand === "stop" || subcommand === "cancel") {
      let stoppedSomething = false;

      // 1. Check taskRunner (single-task runner mode)
      const { abortActiveRemoteTask, getActiveRemoteTaskId } = await import("../remoteAgent/taskRunner.js");
      const activeId = getActiveRemoteTaskId();
      if (activeId) {
        ctx.addLine({
          type: "system",
          content: `[Muse] Aborting active remote task (${activeId}) and notifying Muse...`,
          timestamp: now,
        });
        const ok = await abortActiveRemoteTask("Cancelled by user via /muse stop");
        if (ok) {
          ctx.addLine({
            type: "system",
            content: "[Muse] Active remote task has been cancelled.",
            timestamp: now,
          });
          stoppedSomething = true;
        }
      }

      // 2. Check museWatcher (watch mode active batch)
      const { isMuseWatcherActive, abortActiveMuseBatch } = await import("../remoteAgent/museWatcher.js");
      if (isMuseWatcherActive()) {
        const didAbort = abortActiveMuseBatch("Cancelled by user via /muse stop");
        if (didAbort) {
          ctx.addLine({
            type: "system",
            content: "[Muse Watch] Active tool execution batch has been cancelled.",
            timestamp: now,
          });
          stoppedSomething = true;
        }
      }

      if (!stoppedSomething) {
        ctx.addLine({
          type: "system",
          content: "[Muse] No active remote task or tool batch is currently running.",
          timestamp: now,
        });
      }
      return;
    }

    // /muse steer or /muse sanggah (intervention during active batch)
    if (subcommand === "steer" || subcommand === "sanggah") {
      const text = parts.slice(1).join(" ").trim();
      if (!text) {
        ctx.addLine({
          type: "error",
          content: `Usage: /muse ${subcommand} <message>`,
          timestamp: now,
        });
        return;
      }

      const { isMuseWatcherActive, sendMuseSteerMessage, abortActiveMuseBatch } = await import("../remoteAgent/museWatcher.js");
      if (isMuseWatcherActive()) {
        abortActiveMuseBatch(`Operator intervention: ${text}`);
        const sent = await sendMuseSteerMessage(text);
        if (sent) {
          ctx.addLine({
            type: "system",
            content: `[Muse Steer] Sent counter-instruction to Muse brain: "${text}"`,
            timestamp: now,
          });
        } else {
          ctx.addLine({
            type: "error",
            content: "[Muse Steer] Failed to send message to Muse (transport not connected).",
            timestamp: now,
          });
        }
        return;
      }

      ctx.addLine({
        type: "system",
        content: "[Muse] Muse Watch mode is not currently running. Use /muse <task> to start a remote task, or /muse msg <text> to send a message to Telegram.",
        timestamp: now,
      });
      return;
    }

    // /muse msg, /muse send, /muse message, /muse tg, /muse chat, /muse say
    if (
      subcommand === "msg" ||
      subcommand === "send" ||
      subcommand === "message" ||
      subcommand === "tg" ||
      subcommand === "chat" ||
      subcommand === "say"
    ) {
      const text = parts.slice(1).join(" ").trim();
      if (!text) {
        ctx.addLine({
          type: "error",
          content: `Usage: /muse ${subcommand} <message>`,
          timestamp: now,
        });
        return;
      }

      const cfg = loadRemoteAgentConfig();
      const { isMuseWatcherActive, sendMuseSteerMessage } = await import("../remoteAgent/museWatcher.js");
      const watcherActive = isMuseWatcherActive();

      let tgSent = false;
      let tgError: string | null = null;

      // 1. Direct send to Telegram group if configured
      if (cfg.botToken && cfg.groupId) {
        try {
          const { MuseClient } = await import("../remoteAgent/museClient.js");
          const client = new MuseClient(cfg);
          tgSent = await client.sendMessage(cfg.groupId, text);
          if (tgSent) {
            ctx.addLine({
              type: "system",
              content: `[Muse Telegram] Sent message to Telegram group (${cfg.groupId}): "${text}"`,
              timestamp: now,
            });
          } else {
            tgError = `Failed to deliver message to Telegram group (${cfg.groupId}). Check bot permissions.`;
          }
        } catch (err: any) {
          tgError = err?.message || String(err);
        }
      }

      // 2. If Watcher is active, also dispatch chat envelope to Muse brain
      if (watcherActive) {
        try {
          const sentBrain = await sendMuseSteerMessage(text);
          if (sentBrain) {
            ctx.addLine({
              type: "system",
              content: `[Muse Brain] Forwarded chat message to active Muse brain session.`,
              timestamp: now,
            });
          }
        } catch {}
      }

      // 3. Fallback to WebSocket tunnel chat if Telegram is not configured
      if (!tgSent && !cfg.botToken && !cfg.groupId) {
        try {
          const { sendChatToMuse } = await import("../remoteAgent/museChat.js");
          const res = await sendChatToMuse(text);
          if (res.ok) {
            ctx.addLine({
              type: "system",
              content: `[Muse Chat] ${res.detail}`,
              timestamp: now,
            });
            return;
          }
        } catch {}

        ctx.addLine({
          type: "error",
          content: "Remote agent is not configured for Telegram. Run /muse config botToken <token> and /muse config groupId <id>.",
          timestamp: now,
        });
        return;
      }

      if (!tgSent && tgError) {
        ctx.addLine({
          type: "error",
          content: `[Muse Telegram] Error sending message to Telegram: ${tgError}`,
          timestamp: now,
        });
      }

      return;
    }

    // /muse watch [start|stop|status] or /muse unwatch
    if (subcommand === "watch" || subcommand === "unwatch") {
      const { handleMuseWatchSubcommand } = await import("./museWatchSubcommand.js");
      await handleMuseWatchSubcommand(parts, ctx, now);
      return;
    }

    // Help & default listing
    if (!rawTrimmed || subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
      ctx.addLine({
        type: "system",
        content: [
          "Usage: /muse <task description>",
          "Example: /muse cari semua TODO di src",
          "",
          "Subcommands:",
          "  /muse status                 - View remote agent, tunnel, and transport status",
          "  /muse tunnel                 - Cloudflare Tunnel setup guide & options",
          "  /muse tunnel list            - List all active Cloudflare tunnels",
          "  /muse tunnel start           - Start quick ephemeral Cloudflare Tunnel & watcher",
          "  /muse tunnel stop            - Stop active Cloudflare Tunnel (or: /muse tunnel stop all)",
          "  /muse tunnel restart         - Restart Cloudflare Tunnel & watcher",
          "  /muse tunnel status          - Check Cloudflare Tunnel process & public URL status",
          "  /muse tunnel prompt          - View and copy connection prompt for Muse",
          "  /muse watch [dirs]           - Enter watch mode (superagent controlled by Muse)",
          "  /muse watch start            - Start watch mode daemon",
          "  /muse watch stop             - Stop watch mode daemon",
          "  /muse watch status           - Show watch mode statistics",
          "  /muse watch add <dir>        - Add workspace directory to watch list",
          "  /muse watch remove <dir>     - Remove workspace directory from watch list",
          "  /muse steer <instruction>    - Intervene and steer active Muse task",
          "  /muse msg <text>             - Send chat message directly to Telegram (aliases: /muse send, /muse tg, /muse chat)",
          "  /muse doctor                 - Run diagnostic checks (cloudflared, ports, credentials)",
          "  /muse connect                - Test connection to remote Muse endpoint",
          "  /muse stop                   - Cancel active remote task",
          "  /muse cancel                 - Cancel active remote task",
          "  /muse new                    - Reset remote session memory",
          "  /muse reset                  - Reset remote session memory",
          "  /muse config                 - View current remote agent configuration",
          "  /muse config <key> <value>   - Update configuration setting",
          "",
          "Direct Shortcuts:",
          "  /tunnel [subcommand]         - Shortcut for /muse tunnel (e.g. /tunnel start, /tunnel list)",
          "  /tunnels                     - Shortcut to list all active tunnels",
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    const { isMuseWatcherActive } = await import("../remoteAgent/museWatcher.js");
    if (isMuseWatcherActive()) {
      ctx.addLine({
        type: "system",
        content: "[Muse Watch] Watch mode is currently active (Superagent is controlled by Muse). You can instruct Muse directly via Telegram, or run '/muse watch stop' to return to manual control.",
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
              "   Because Privacy Mode is on, Telegram will NOT deliver non-reply messages to this bot.",
              "   To fix: Open @BotFather -> /setprivacy -> Select your bot -> Choose 'Disable'.",
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
        signal: (ctx.agent as any)?.getAbortSignal?.(),
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
          if (msg.startsWith("Waiting")) {
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
        const readableSummary = formatReadableSummary(result.summary);
        const formattedSummary = readableSummary.startsWith("📋") || /^task summary/i.test(readableSummary)
          ? readableSummary
          : `📋 Task Summary (Muse Remote)\n────────────────────────────────────────────\n${readableSummary}`;

        // Always append the final response at the end so it appears cleanly below all tool executions
        ctx.addLine({
          type: "assistant",
          content: formattedSummary,
          timestamp: Date.now(),
        });

        // Persist interaction to conversation history & SQLite database if agent is present
        if (ctx.agent) {
          try {
            ctx.agent.getHistory().addUserMessage(rawTrimmed);
            ctx.agent.getHistory().addAssistantMessage(readableSummary);
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

export const tunnelCommand: SlashCommand = {
  name: "tunnel",
  aliases: ["tunnels"],
  description: "Manage Cloudflare quick tunnels (list, start [--https] [--mcp] [--mcp-port <n>] [--mcp-auth <mode>], stop, status, restart)",
  async execute(args, ctx) {
    const rawTrimmed = args.trim();
    if (!rawTrimmed) {
      return museCommand.execute("tunnel list", ctx);
    }
    return museCommand.execute(`tunnel ${rawTrimmed}`, ctx);
  },
};

registry.register(tunnelCommand);
