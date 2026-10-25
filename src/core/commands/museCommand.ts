import path from "path";
import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext, ChatLine } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
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

    // /muse host status|steer|task|abort --port N
    // Deliberately explicit: legacy local Muse watchers are not silently
    // rerouted, started, stopped, or migrated into another process.
    if (subcommand === "host") {
      const action = (parts[1] || "status").toLowerCase();
      if (action === "help") {
        ctx.addLine({ type: "system", content:
          "Use /muse host status, /muse host steer <text> --port 7892, " +
          "/muse host task <task> --port 7892, or /muse host abort [reason] --port 7892. " +
          "Requires a separately running verified channel host.", timestamp: now });
        return;
      }
      const { listVerifiedChannelHosts, requestChannelHostIpc } =
        await import("../runtime/channelHost.js");
      if (action === "status") {
        const hosts = await listVerifiedChannelHosts();
        const lines = hosts.filter(host => host.mode !== "idle").map(host =>
          host.mode + " on port " + host.port + ": " + host.status +
          ", watcher " + (host.watcherActive ? "active" : "inactive") +
          ", task " + (host.taskActive ? "active" : "idle"));
        ctx.addLine({ type: "system", content:
          lines.length ? "Independent Muse/Telegram hosts:\n" + lines.join("\n") :
          "No verified active Muse/Telegram channel hosts. Start an opt-in channel-host process separately.",
          timestamp: now });
        return;
      }
      if (action !== "steer" && action !== "task" && action !== "abort") {
        ctx.addLine({ type: "error", content: "Use /muse host help for supported operations.", timestamp: now });
        return;
      }
      const portIndex = parts.indexOf("--port");
      const port = portIndex < 0 ? 7892 : Number(parts[portIndex + 1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        ctx.addLine({ type: "error", content: "Invalid --port", timestamp: now });
        return;
      }
      const message = parts.slice(2).filter((_word, i) =>
        !(portIndex >= 2 && (i + 2 === portIndex || i + 2 === portIndex + 1))).join(" ");
      if (!message.trim() && action !== "abort") {
        ctx.addLine({ type: "error", content: "A message is required for /muse host " + action, timestamp: now });
        return;
      }
      try {
        await requestChannelHostIpc(port, action, message);
        ctx.addLine({ type: "system", content: "[Muse Host] " + action +
          " acknowledged by verified channel host on port " + port + ".", timestamp: now });
      } catch (err) {
        ctx.addLine({ type: "error", content: "[Muse Host] " + String(err), timestamp: now });
      }
      return;
    }

    // /muse status
    if (subcommand === "status") {
      const cfg = loadRemoteAgentConfig();
      const workspace = ctx.agent?.workingDirectory || cfg.defaultWorkspace || process.cwd();
      // Session task information is local-only and scoped to this T-Line workspace.
      const { getActiveRemoteTaskSnapshot } = await import("../remoteAgent/taskRunner.js");
      const { projectMuseRemoteTask } = await import("../channels/unifiedChannelTask.js");
      const active = getActiveRemoteTaskSnapshot();
      const sameWorkspace = (candidate: string) => {
        const normalize = (input: string) => {
          const normalized = path.resolve(input);
          return process.platform === "win32" ? normalized.toLowerCase() : normalized;
        };
        return normalize(candidate) === normalize(workspace);
      };
      const normalizedMuseTask = active && sameWorkspace(active.workspace)
        ? projectMuseRemoteTask(active, "tline")
        : null;
      // Telegram credentials and Bot API health are intentionally owned by /telegram.

      const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
      const wsStatusStr = watchedWorkspaces.length > 1
        ? `- Watched Projects (${watchedWorkspaces.length}):\n${watchedWorkspaces.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
        : `- Workspace       : ${workspace}`;

      const transport = cfg.transport || "telegram";
      const configuredLabel = transport === "websocket"
        ? (isMuseWsActive() ? "Yes" : "No (run /muse watch or /muse tunnel start)")
        : "Telegram adapter selected (run /telegram status to verify Telegram)";

      const { getTunnelStatus, listActiveTunnels } = await import("../remoteAgent/cloudflareTunnel.js");
      // Muse status must not accidentally display the MCP or SuperAgent REST/SSE tunnel.
      const activeTunnels = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
      const defaultPort = cfg.wsPort || 9225;
      const wsTunnelRaw = getTunnelStatus(defaultPort);
      const wsTunnel = wsTunnelRaw.serviceKind === "muse-websocket"
        ? wsTunnelRaw
        : { ...wsTunnelRaw, isRunning: false };
      const firstMuseTunnel = activeTunnels[0];
      const tunnelStatus = wsTunnel.isRunning
        ? wsTunnel
        : (firstMuseTunnel ? { isRunning: true, ...firstMuseTunnel } : wsTunnel);

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
            "- Transport       : TELEGRAM adapter selected",
            "- Telegram health : not checked here (run /telegram status)",
          ];

      const lines = [
        "Remote Agent (Muse) Status:",
        `- Active task     : ${normalizedMuseTask ? normalizedMuseTask.taskId : "none in this workspace"}`,
        `- Unified status  : ${normalizedMuseTask?.status ?? "idle"} (evidence: ${normalizedMuseTask?.evidence ?? "not_applicable"})`,
        `- Task session    : ${normalizedMuseTask?.sessionId ?? "not available"}`,
        `- Configured      : ${configuredLabel}`,
        `- Runner Mode     : ${cfg.asRunner ? "ENABLED (All terminal prompts automatically route to Muse)" : "DISABLED (type /muse <task> to coordinate with Muse)"}`,
        ...transportLines,
        wsStatusStr,
        "",
        "Architecture:",
        "- Muse manages remote task coordination, watch sessions, and its own WebSocket connection.",
        "- Direct Telegram operations live under /telegram; MCP tunnel providers live under /mcp tunnel.",
        "",
        "Usage:",
        "  /muse <task>                 - Run or coordinate a task with Muse",
        "  /muse status                 - View Muse task, watch, and WebSocket status",
        "  /muse host status            - List independently owned channel hosts",
        "  /muse host steer <text>      - Steer verified remote host (explicit opt-in)",
        "  /muse host task <text>       - Request Muse task from independent host",
        "  /muse host abort [reason]    - Abort active batch on independent host",
        "  /muse watch [dirs]           - Start watch mode for one or more workspaces",
        "  /muse watch start            - Start the Muse watcher",
        "  /muse watch stop             - Stop only the Muse watcher",
        "  /muse watch status           - Show Muse watcher state",
        "  /muse watch add <dir>        - Add a workspace to watch",
        "  /muse watch remove <dir>     - Remove a watched workspace",
        "  /muse steer <message>       - Steer an active Muse task",
        "  /muse stop                   - Cancel an active Muse task",
        "  /muse cancel                 - Alias for /muse stop",
        "  /muse tunnel list            - List Muse WebSocket tunnels only",
        "  /muse tunnel start           - Start Muse WebSocket tunnel and watcher",
        "  /muse tunnel stop            - Stop Muse WebSocket tunnel only",
        "  /muse tunnel restart         - Restart Muse WebSocket tunnel",
        "  /muse tunnel status          - Check Muse WebSocket tunnel status",
        "  /muse tunnel prompt          - View/copy connection prompt for Muse",
        "  /muse doctor                 - Check Muse environment and watch readiness",
        "  /muse connect                - Test the configured Muse connection",
        "  /muse new                    - Start a fresh Muse session",
        "  /muse reset                  - Reset remote Muse session context",
        "  /muse config                 - View/update Muse-specific configuration",
        "  /telegram help               - Manage Telegram bot, group, and direct messages",
        "  /mcp tunnel providers        - List MCP tunnel providers",
        "  /mcp tunnel start            - Start an MCP tunnel via its selected provider",
        "  /server tunnel               - Manage SuperAgent REST/SSE exposure",
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

    // Telegram bot configuration is maintained under /telegram; keep legacy keys as explicit forwards.
    if (subcommand === "config") {
      const telegramKeys = new Set(["bottoken", "bot_token", "token", "groupid", "group_id", "chatid", "chat_id", "musebotid", "muse_bot_id"]);
      const configKey = parts[1]?.toLowerCase();
      if (configKey && telegramKeys.has(configKey)) {
        ctx.addLine({
          type: "system",
          content: `[Compatibility] /muse config ${parts[1]} is deprecated; use /telegram config ${parts[1]}.`,
          timestamp: now,
        });
        const { handleTelegramCommand } = await import("./telegramCommand.js");
        await handleTelegramCommand(`config ${parts.slice(1).join(" ")}`, ctx);
        return;
      }
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

    // Compatibility aliases: explicit message sends are Telegram-only now.
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
          content: `Deprecated alias. Usage: /telegram send <message> (legacy: /muse ${subcommand} <message>)`,
          timestamp: now,
        });
        return;
      }
      ctx.addLine({
        type: "system",
        content: `[Compatibility] /muse ${subcommand} is deprecated; forwarding to /telegram send. This sends only to Telegram and does not steer Muse.`,
        timestamp: now,
      });
      const { handleTelegramCommand } = await import("./telegramCommand.js");
      await handleTelegramCommand(`send ${text}`, ctx);
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
          "Muse commands:",
          "  /muse status                 - View Muse task, watch, and WebSocket status",
          "  /muse watch [dirs]            - Manage Muse watch sessions and workspaces",
          "  /muse watch start             - Start the Muse watcher",
          "  /muse watch stop              - Stop only the Muse watcher",
          "  /muse watch status            - Show Muse watcher state",
          "  /muse host status             - List independently owned channel hosts",
          "  /muse host steer <text>       - Send authenticated steer IPC to remote owner",
          "  /muse host task <text>        - Request task on independent watcher",
          "  /muse host abort [reason]     - Abort active independent watcher batch",
          "  /muse watch add <dir>         - Add a workspace to watch",
          "  /muse watch remove <dir>      - Remove a watched workspace",
          "  /muse steer <instruction>    - Steer an active Muse task",
          "  /muse stop                    - Cancel active Muse work",
          "  /muse cancel                 - Alias for /muse stop",
          "  /muse new                    - Start a fresh Muse session",
          "  /muse reset                  - Reset remote Muse session memory",
          "  /muse connect                 - Test the configured Muse connection",
          "  /muse doctor                  - Diagnose Muse transport and watcher readiness",
          "  /muse config                  - View/update Muse-specific configuration",
          "",
          "Muse WebSocket tunnel:",
          "  /muse tunnel list             - List Muse WebSocket tunnels",
          "  /muse tunnel start            - Start Muse WebSocket tunnel and watcher",
          "  /muse tunnel stop             - Stop Muse WebSocket tunnel(s) only",
          "  /muse tunnel stop all         - Stop all Muse WebSocket tunnels, never MCP/Telegram",
          "  /muse tunnel restart          - Restart Muse WebSocket tunnel and watcher",
          "  /muse tunnel status           - Show Muse WebSocket tunnel status",
          "  /muse tunnel doctor           - Diagnose Muse tunnel prerequisites",
          "  /muse tunnel prompt           - Show/copy Muse connection prompt",
          "  /muse tunnel start --port <n> - Use a custom local port",
          "",
          "Separate domains:",
          "  /telegram help                - Telegram bot/group operations and direct messaging",
          "  /mcp tunnel providers         - MCP tunnel provider management",
          "  /server tunnel                - SuperAgent REST/SSE tunnel management",
          "",
          "Compatibility:",
          "  /muse msg <text>              - Deprecated alias for /telegram send <text>",
          "  /tunnel                       - Deprecated Muse-only alias for /muse tunnel",
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    // /muse task or /muse run or /muse do
    if (subcommand === "task" || subcommand === "run" || subcommand === "do") {
      const taskText = parts.slice(1).join(" ").trim();
      if (!taskText) {
        ctx.addLine({
          type: "error",
          content: `Usage: /muse ${subcommand} <task description>`,
          timestamp: now,
        });
        return;
      }

      const { isMuseWatcherActive, sendMuseTaskRequest } = await import("../remoteAgent/museWatcher.js");
      if (isMuseWatcherActive()) {
        const workspace = ctx.agent?.workingDirectory || process.cwd();
        const sent = await sendMuseTaskRequest(taskText, workspace);
        if (sent) {
          ctx.addLine({
            type: "system",
            content: `⚡ [Muse Watch] Dispatched task_request to Muse: "${taskText}"\nMuse will now explore the repository and execute tool batches.`,
            timestamp: now,
          });
        } else {
          ctx.addLine({
            type: "error",
            content: "[Muse Watch] Failed to dispatch task_request to Muse.",
            timestamp: now,
          });
        }
        return;
      }
    }

    const { isMuseWatcherActive, sendMuseSteerMessage } = await import("../remoteAgent/museWatcher.js");
    if (isMuseWatcherActive()) {
      let sentBrain = false;
      try {
        sentBrain = await sendMuseSteerMessage(rawTrimmed);
      } catch {}

      let sentTgText = false;
      const cfg = loadRemoteAgentConfig();
      if (cfg.botToken && cfg.groupId) {
        try {
          const { MuseClient } = await import("../remoteAgent/museClient.js");
          const client = new MuseClient(cfg);
          sentTgText = await client.sendMessage(cfg.groupId, rawTrimmed);
        } catch {}
      }

      if (sentBrain || sentTgText) {
        ctx.addLine({
          type: "system",
          content: `[Muse Watch] Delivered instruction to Telegram & Muse: "${rawTrimmed}"`,
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "error",
          content: "[Muse Watch] Watch mode is active, but failed to deliver message to Telegram or Muse.",
          timestamp: now,
        });
      }
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
