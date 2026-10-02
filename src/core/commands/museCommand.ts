import path from "path";
import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext, ChatLine } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  maskSecret,
  generateSecureWsToken,
  isMuseWsActive,
  RemoteAgentConfig,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  setWatchedWorkspaces,
} from "../remoteAgent/config.js";
import { formatReadableSummary } from "../remoteAgent/formatSummary.js";

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

      const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
      const wsStatusStr = watchedWorkspaces.length > 1
        ? `- Watched Projects (${watchedWorkspaces.length}):\n${watchedWorkspaces.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
        : `- Workspace       : ${workspace}`;

      const transport = cfg.transport || "telegram";
      const isConfiguredEffective = transport === "websocket" ? isMuseWsActive() : isConfigured;

      const { getTunnelStatus } = await import("../remoteAgent/cloudflareTunnel.js");
      const tunnelStatus = getTunnelStatus();

      const transportLines = transport === "websocket"
        ? [
            `- Transport       : WEBSOCKET (${(cfg.wsMode || "server").toUpperCase()})`,
            `- WS Endpoint     : ws://${cfg.wsHost || "127.0.0.1"}:${cfg.wsPort || 9225}${cfg.wsPath || "/muse"}`,
            `- Quick Tunnel    : ${tunnelStatus.isRunning ? `ACTIVE (${tunnelStatus.wssUrl}, PID: ${tunnelStatus.pid})` : "INACTIVE (run /muse tunnel start)"}`,
            `- Bearer Token    : ${maskSecret(cfg.wsToken)}`,
            `- CF-Access ID    : ${cfg.cfAccessClientId || "(disabled)"}`,
          ]
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
        "  /muse tunnel start           - Start quick ephemeral Cloudflare Tunnel",
        "  /muse tunnel stop            - Stop active Cloudflare Tunnel",
        "  /muse tunnel status          - Check Cloudflare Tunnel process status",
        "  /muse watch [dir1] [dir2]    - Watch one or multiple project workspaces",
        "  /muse watch --ws             - Watch projects using secure WebSocket transport",
        "  /muse watch --tunnel         - Watch projects and expose via Cloudflare Tunnel",
        "  /muse watch add <dir>        - Add project to active watch session",
        "  /muse watch remove <dir>     - Remove project from active watch session",
        "  /muse stop                   - Cancel active remote task and notify Muse",
        "  /muse cancel                 - Cancel active remote task and notify Muse",
        "  /muse new                    - Reset remote session memory",
        "  /muse reset                  - Reset remote session memory",
        "  /muse config <key> <val>     - Set config key (transport, wsToken, wsPort, botToken, etc.)",
      ].filter(Boolean) as string[];

      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
      return;
    }

    // /muse tunnel or /muse cloudflare
    if (subcommand === "tunnel" || subcommand === "cloudflare") {
      const action = (parts[1] || "").toLowerCase();
      const cfg = loadRemoteAgentConfig();
      const host = cfg.wsHost || "127.0.0.1";
      const port = cfg.wsPort || 9225;
      const pathEndpoint = cfg.wsPath || "/muse";
      let token = cfg.wsToken;

      if (!token) {
        token = generateSecureWsToken();
        updateRemoteAgentConfig({ wsToken: token, transport: "websocket" });
        ctx.addLine({
          type: "system",
          content: `[Muse Security] Generated new Bearer token: ${token}`,
          timestamp: now,
        });
      }

      const {
        startQuickTunnel,
        stopQuickTunnel,
        getTunnelStatus,
        buildMuseConnectionPrompt,
        copyTextToClipboard,
      } = await import("../remoteAgent/cloudflareTunnel.js");

      if (action === "start" || action === "quick" || action === "run") {
        const initialTask = parts.slice(2).join(" ").trim();
        const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
        const existing = getTunnelStatus();
        if (existing.isRunning) {
          const musePrompt = buildMuseConnectionPrompt({
            wssUrl: existing.wssUrl || "",
            token,
            publicUrl: existing.publicUrl,
            localUrl: existing.localUrl,
            workspaces: watchedWorkspaces,
            cfClientId: cfg.cfAccessClientId,
            cfClientSecret: cfg.cfAccessClientSecret,
            task: initialTask,
          });
          const copied = await copyTextToClipboard(musePrompt);

          ctx.addLine({
            type: "system",
            content: [
              "[Cloudflare Tunnel] Quick tunnel is ALREADY ACTIVE:",
              `- Public URL   : ${existing.publicUrl}`,
              `- WSS Endpoint : ${existing.wssUrl}`,
              `- Local Target : ${existing.localUrl}`,
              `- Process PID  : ${existing.pid}`,
              `- Uptime       : ${existing.uptimeSeconds}s`,
              `- Bearer Token : ${token}`,
              "",
              copied
                ? "Prompt for Muse (copied to clipboard, ready to send):"
                : "Prompt for Muse (copy & send to Muse):",
              "-----------------------------------------------------------------------------",
              musePrompt,
              "-----------------------------------------------------------------------------",
              "",
              "To stop the tunnel, run: /muse tunnel stop",
            ].join("\n"),
            timestamp: now,
          });
          return;
        }

        ctx.addLine({
          type: "system",
          content: "[Cloudflare Tunnel] Spawning quick ephemeral development tunnel via cloudflared...",
          timestamp: now,
        });

        try {
          const meta = await startQuickTunnel({
            port,
            host,
            path: pathEndpoint,
          });

          const musePrompt = buildMuseConnectionPrompt({
            wssUrl: meta.wssUrl,
            token,
            publicUrl: meta.publicUrl,
            localUrl: meta.localUrl,
            workspaces: watchedWorkspaces,
            cfClientId: cfg.cfAccessClientId,
            cfClientSecret: cfg.cfAccessClientSecret,
            task: initialTask,
          });
          const copied = await copyTextToClipboard(musePrompt);

          ctx.addLine({
            type: "system",
            content: [
              "═════════════════════════════════════════════════════════════════════════════",
              "  Cloudflare Quick Ephemeral Tunnel Online!",
              "═════════════════════════════════════════════════════════════════════════════",
              `- Public URL   : ${meta.publicUrl}`,
              `- WSS Endpoint : ${meta.wssUrl}`,
              `- Local Target : ${meta.localUrl}`,
              `- Process PID  : ${meta.pid}`,
              `- Bearer Token : ${token}`,
              "═════════════════════════════════════════════════════════════════════════════",
              "",
              copied
                ? "Prompt for Muse (copied to clipboard, ready to send):"
                : "Prompt for Muse (copy & send to Muse):",
              "-----------------------------------------------------------------------------",
              musePrompt,
              "-----------------------------------------------------------------------------",
              "",
              "Run '/muse tunnel stop' to terminate the tunnel at any time.",
            ].join("\n"),
            timestamp: Date.now(),
          });
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `[Cloudflare Tunnel] Error: ${err?.message}`,
            timestamp: Date.now(),
          });
        }
        return;
      }

      if (action === "stop") {
        const existing = getTunnelStatus();
        if (!existing.isRunning) {
          ctx.addLine({
            type: "system",
            content: "[Cloudflare Tunnel] No quick tunnel is currently running.",
            timestamp: now,
          });
          return;
        }
        await stopQuickTunnel();
        ctx.addLine({
          type: "system",
          content: "[Cloudflare Tunnel] Quick tunnel stopped successfully.",
          timestamp: Date.now(),
        });
        return;
      }

      if (action === "status") {
        const existing = getTunnelStatus();
        if (existing.isRunning) {
          ctx.addLine({
            type: "system",
            content: [
              "Cloudflare Quick Tunnel Status: ACTIVE",
              `- Public URL   : ${existing.publicUrl}`,
              `- WSS Endpoint : ${existing.wssUrl}`,
              `- Local Target : ${existing.localUrl}`,
              `- Process PID  : ${existing.pid}`,
              `- Uptime       : ${existing.uptimeSeconds}s`,
              `- Bearer Token : ${token ? maskSecret(token) : "(none)"}`,
              "",
              "To stop it, run: /muse tunnel stop",
            ].join("\n"),
            timestamp: now,
          });
        } else {
          ctx.addLine({
            type: "system",
            content: "Cloudflare Quick Tunnel Status: INACTIVE\nRun '/muse tunnel start' to launch a quick development tunnel.",
            timestamp: now,
          });
        }
        return;
      }

      const currentStatus = getTunnelStatus();
      const statusPrefix = currentStatus.isRunning
        ? `[Cloudflare Tunnel] Quick tunnel is ACTIVE (PID: ${currentStatus.pid}, URL: ${currentStatus.publicUrl})\n\n`
        : "";

      const guide = [
        "═════════════════════════════════════════════════════════════════════════════",
        "  Cloudflare Tunnel Setup & Ephemeral Subcommands for Muse",
        "═════════════════════════════════════════════════════════════════════════════",
        "",
        "Subcommands:",
        "  /muse tunnel start           - Start quick ephemeral tunnel in background",
        "  /muse tunnel stop            - Stop running quick tunnel",
        "  /muse tunnel status          - Check current tunnel status",
        "  /muse tunnel guide           - View full manual Cloudflare setup guide",
        "",
        "1. Prerequisites:",
        "   Install cloudflared: winget install Cloudflare.cloudflared (or brew install cloudflared)",
        "",
        "2. Quick Ephemeral Tunnel (Development):",
        `   cloudflared tunnel --url http://${host}:${port}`,
        `   Connect Muse over WSS to: wss://<subdomain>.trycloudflare.com${pathEndpoint}`,
        "",
        "3. Production Ingress config (~/.cloudflared/config.yml):",
        "   ingress:",
        "     - hostname: muse.yourdomain.com",
        `       service: ws://${host}:${port}`,
        "     - service: http_status:404",
        "",
        "4. Edge Security (Zero Trust Access):",
        "   Set Service Token in Superagent:",
        "   /muse config cfAccessClientId <CLIENT_ID>",
        "   /muse config cfAccessClientSecret <CLIENT_SECRET>",
        "",
        "5. Authentication Token:",
        `   Authorization: Bearer ${token}`,
        "",
        "6. Start Daemon with Tunnel:",
        "   /muse watch --tunnel",
        "═════════════════════════════════════════════════════════════════════════════",
      ];

      ctx.addLine({ type: "system", content: statusPrefix + guide.join("\n"), timestamp: now });
      return;
    }

    // /muse config [key] [val]
    if (subcommand === "config") {
      const key = parts[1]?.toLowerCase();
      const val = parts.slice(2).join(" ").trim();

      if (!key) {
        const cfg = loadRemoteAgentConfig();
        const watchedList = getWatchedWorkspaces(cfg);
        const lines = [
          "Remote Agent Configuration:",
          `- as_runner_model  : ${cfg.asRunner ? "on (enabled)" : "off (disabled)"}`,
          `- botToken          : ${maskToken(cfg.botToken)}`,
          `- groupId           : ${cfg.groupId || "(not set)"}`,
          `- museBotId         : ${cfg.museBotId || "(not set)"}`,
          `- defaultWorkspace  : ${cfg.defaultWorkspace || "(default to current workspace)"}`,
          `- watchedWorkspaces (${watchedList.length}):\n${watchedList.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`,
          `- systemPrompt      : ${cfg.systemPrompt ? `configured (${cfg.systemPrompt.length} chars)` : "default (auto-injected)"}`,
          "",
          "Usage: /muse config <key> <value>",
          "Keys:",
          "  as_runner_model  - Route all terminal prompts to Muse directly without /muse (on/off)",
          "  botToken         - Bot B (superagent's Telegram bot token)",
          "  groupId          - Numeric private group chat ID (e.g. -100xxxxxxxxxx)",
          "  museBotId        - Numeric Telegram user ID of Muse bot (Bot A)",
          "  defaultWorkspace - Default project workspace path",
          "  workspaces       - Configure watched workspaces (add <dir>, remove <dir>, or comma list)",
          "  systemPrompt     - Custom system instructions injected into Muse requests",
          "",
          "Examples:",
          "  /muse config workspaces add ./backend",
          "  /muse config workspaces add ./frontend",
          "  /muse config as_runner_model on",
          "  /muse config botToken 123456789:ABCdef...",
        ];
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        return;
      }

      if (key === "workspaces" || key === "workspace" || key === "projects") {
        if (!val || val === "list") {
          const list = getWatchedWorkspaces();
          ctx.addLine({
            type: "system",
            content: `Watched workspaces (${list.length}):\n${list.map((w, i) => `  ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`,
            timestamp: now,
          });
          return;
        }
        if (val.startsWith("add ")) {
          const p = val.slice(4).trim();
          const updated = addWatchedWorkspace(p);
          ctx.addLine({
            type: "system",
            content: `Watched workspace added: ${p}\nTotal configured: ${updated.workspaces?.length || 1}`,
            timestamp: now,
          });
          return;
        }
        if (val.startsWith("remove ")) {
          const p = val.slice(7).trim();
          const updated = removeWatchedWorkspace(p);
          ctx.addLine({
            type: "system",
            content: `Watched workspace removed: ${p}\nTotal configured: ${updated.workspaces?.length || 0}`,
            timestamp: now,
          });
          return;
        }
        const paths = val.split(/[,\s]+/).filter(Boolean);
        const updated = setWatchedWorkspaces(paths);
        ctx.addLine({
          type: "system",
          content: `Watched workspaces set to (${updated.workspaces?.length || 0}):\n${(updated.workspaces || []).map((w, i) => `  ${i + 1}. ${w}`).join("\n")}`,
          timestamp: now,
        });
        return;
      }

      const validKeys: Record<string, keyof RemoteAgentConfig> = {
        transport: "transport",
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
        systemprompt: "systemPrompt",
        system_prompt: "systemPrompt",
        prompt: "systemPrompt",
        wsport: "wsPort",
        ws_port: "wsPort",
        port: "wsPort",
        wshost: "wsHost",
        ws_host: "wsHost",
        wstoken: "wsToken",
        ws_token: "wsToken",
        token: "wsToken",
        wspath: "wsPath",
        ws_path: "wsPath",
        wsmode: "wsMode",
        ws_mode: "wsMode",
        wsremoteurl: "wsRemoteUrl",
        ws_remote_url: "wsRemoteUrl",
        remoteurl: "wsRemoteUrl",
        cfaccessclientid: "cfAccessClientId",
        cf_access_client_id: "cfAccessClientId",
        cfid: "cfAccessClientId",
        cfaccessclientsecret: "cfAccessClientSecret",
        cf_access_client_secret: "cfAccessClientSecret",
        cfsecret: "cfAccessClientSecret",
        tokenttl: "tokenTtlSeconds",
        token_ttl: "tokenTtlSeconds",
        ttl: "tokenTtlSeconds",
        tokengrace: "tokenGracePeriodMs",
        token_grace: "tokenGracePeriodMs",
        autotokenrefresh: "autoTokenRefresh",
        auto_token_refresh: "autoTokenRefresh",
      };

      const mappedKey = validKeys[key];
      if (!mappedKey) {
        ctx.addLine({
          type: "error",
          content: `Unknown config key: "${key}". Valid keys: transport, wsToken, wsPort, wsHost, wsPath, wsMode, cfAccessClientId, cfAccessClientSecret, tokenTtl, as_runner_model, botToken, groupId, museBotId, defaultWorkspace, workspaces, systemPrompt`,
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
      if (mappedKey === "asRunner" || mappedKey === "autoTokenRefresh") {
        const lowerVal = val.toLowerCase();
        if (["on", "true", "1", "yes", "enable", "enabled"].includes(lowerVal)) {
          (patch as any)[mappedKey] = true;
        } else if (["off", "false", "0", "no", "disable", "disabled"].includes(lowerVal)) {
          (patch as any)[mappedKey] = false;
        } else {
          ctx.addLine({
            type: "error",
            content: `Invalid value for ${key}: "${val}". Use "on" or "off".`,
            timestamp: now,
          });
          return;
        }
      } else if (mappedKey === "transport") {
        const lower = val.toLowerCase();
        if (lower === "websocket" || lower === "ws") {
          patch.transport = "websocket";
        } else if (lower === "telegram" || lower === "tg") {
          patch.transport = "telegram";
        } else {
          ctx.addLine({
            type: "error",
            content: `Invalid transport: "${val}". Supported: "telegram" or "websocket".`,
            timestamp: now,
          });
          return;
        }
      } else if (mappedKey === "wsPort" || mappedKey === "tokenTtlSeconds" || mappedKey === "tokenGracePeriodMs") {
        const p = parseInt(val, 10);
        if (isNaN(p) || p <= 0) {
          ctx.addLine({
            type: "error",
            content: `Invalid integer for ${key}: "${val}".`,
            timestamp: now,
          });
          return;
        }
        (patch as any)[mappedKey] = p;
      } else if (mappedKey === "wsToken") {
        if (
          val.toLowerCase() === "generate" ||
          val.toLowerCase() === "gen" ||
          val.toLowerCase() === "refresh" ||
          val.toLowerCase() === "rotate"
        ) {
          const { rotateWsToken } = await import("../remoteAgent/config.js");
          const rotation = rotateWsToken();
          ctx.addLine({
            type: "system",
            content: `Generated and rotated secure Bearer token (with 5-minute handover grace period):\n${rotation.newToken}`,
            timestamp: now,
          });
          return;
        }
        patch.wsToken = val;
      } else if (mappedKey === "wsMode") {
        const lower = val.toLowerCase();
        if (lower === "client" || lower === "server") {
          patch.wsMode = lower;
        } else {
          ctx.addLine({
            type: "error",
            content: `Invalid wsMode: "${val}". Use "server" or "client".`,
            timestamp: now,
          });
          return;
        }
      } else {
        (patch as any)[mappedKey] = val;
      }

      updateRemoteAgentConfig(patch);
      const maskedConfirmation =
        mappedKey === "botToken" || mappedKey === "wsToken" || mappedKey === "cfAccessClientSecret"
          ? maskSecret(String((patch as any)[mappedKey]))
          : mappedKey === "asRunner"
            ? (patch.asRunner ? "on (enabled)" : "off (disabled)")
            : (patch as any)[mappedKey];

      ctx.addLine({
        type: "system",
        content: `Remote agent configuration updated: ${mappedKey} = ${maskedConfirmation}`,
        timestamp: now,
      });
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
      // In watch mode, reset the local session directly: the Telegram loopback
      // would be ignored by the watcher's sender filter (Rule 2: only Muse bot).
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
      const { abortActiveRemoteTask, getActiveRemoteTaskId } = await import("../remoteAgent/taskRunner.js");
      const activeId = getActiveRemoteTaskId();
      if (!activeId) {
        ctx.addLine({
          type: "system",
          content: "[Muse] No active remote task is currently running.",
          timestamp: now,
        });
        return;
      }
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
      }
      return;
    }

    // /muse watch [start|stop|status] or /muse unwatch
    if (subcommand === "watch" || subcommand === "unwatch") {
      const action = subcommand === "unwatch" ? "stop" : (parts[1]?.toLowerCase() || "start");
      const {
        startMuseWatcher,
        stopMuseWatcher,
        isMuseWatcherActive,
        getMuseWatcher,
      } = await import("../remoteAgent/museWatcher.js");

      if (action === "stop") {
        if (!isMuseWatcherActive()) {
          ctx.addLine({
            type: "system",
            content: "[Muse Watch] Watch mode is not currently running.",
            timestamp: now,
          });
          return;
        }
        await stopMuseWatcher();
        return;
      }

      if (action === "status") {
        const watcher = getMuseWatcher();
        const stats = watcher?.getStats();
        if (!stats || !stats.isRunning) {
          ctx.addLine({
            type: "system",
            content: "[Muse Watch] Watch mode is INACTIVE. Run '/muse watch' or '/muse watch start' to activate.",
            timestamp: now,
          });
          return;
        }

        const wsLines = stats.workspaces && stats.workspaces.length > 1
          ? `- Watched Projects (${stats.workspaces.length}):\n${stats.workspaces.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
          : `- Workspace         : ${stats.workspace}`;

        const lines = [
          "Muse Watch Mode: ACTIVE",
          `- Transport         : ${stats.transportDetails || stats.transport || "telegram"}`,
          wsLines,
          `- Uptime            : ${stats.uptimeSeconds}s`,
          `- Batches Executed  : ${stats.batchesExecuted}`,
          `- Tasks Completed   : ${stats.tasksCompleted}`,
          `- Active Task       : ${stats.activeTaskId || "none (idle, waiting for Muse)"}`,
        ];
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        return;
      }

      if (action === "add") {
        const dirToAdd = parts.slice(2).join(" ").trim();
        if (!dirToAdd) {
          ctx.addLine({
            type: "error",
            content: "Usage: /muse watch add <project_directory>",
            timestamp: now,
          });
          return;
        }
        const resolved = path.resolve(dirToAdd);
        addWatchedWorkspace(resolved);
        const watcher = getMuseWatcher();
        if (watcher && isMuseWatcherActive()) {
          watcher.addWorkspace(resolved);
        }
        ctx.addLine({
          type: "system",
          content: `[Muse Watch] Added project "${path.basename(resolved)}" (${resolved}) to watched projects.`,
          timestamp: now,
        });
        return;
      }

      if (action === "remove") {
        const dirToRem = parts.slice(2).join(" ").trim();
        if (!dirToRem) {
          ctx.addLine({
            type: "error",
            content: "Usage: /muse watch remove <project_directory>",
            timestamp: now,
          });
          return;
        }
        const resolved = path.resolve(dirToRem);
        removeWatchedWorkspace(resolved);
        const watcher = getMuseWatcher();
        if (watcher && isMuseWatcherActive()) {
          watcher.removeWorkspace(resolved);
        }
        ctx.addLine({
          type: "system",
          content: `[Muse Watch] Removed project "${path.basename(resolved)}" (${resolved}) from watched projects.`,
          timestamp: now,
        });
        return;
      }

      // Collect directories and flags: /muse watch [start] [--ws] [--tunnel] [dir1] [dir2] ...
      const isWs = parts.some((p) => p === "--ws" || p === "--websocket");
      const isTg = parts.some((p) => p === "--telegram" || p === "--tg");
      const isTunnel = parts.some((p) => p === "--tunnel" || p === "--quick-tunnel");
      const transportType = (isWs || isTunnel) ? "websocket" : isTg ? "telegram" : undefined;

      const rawDirs = parts.slice(1).filter((p) => {
        if (p.toLowerCase() === "start") return false;
        if (
          p === "--ws" ||
          p === "--websocket" ||
          p === "--telegram" ||
          p === "--tg" ||
          p === "--tunnel" ||
          p === "--quick-tunnel"
        )
          return false;
        return true;
      });
      const targetDirs = rawDirs
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
        .map((d) => path.resolve(d));

      const cfg = loadRemoteAgentConfig();
      const allWatched = targetDirs.length > 0
        ? targetDirs
        : getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);

      // If already active:
      if (isMuseWatcherActive()) {
        const watcher = getMuseWatcher();
        if (targetDirs.length > 0 && watcher) {
          for (const d of targetDirs) {
            watcher.addWorkspace(d);
          }
          ctx.addLine({
            type: "system",
            content: `[Muse Watch] Added ${targetDirs.length} project(s) to running watch session:\n${targetDirs.map((d, i) => `  ${i + 1}. ${path.basename(d)} (${d})`).join("\n")}`,
            timestamp: now,
          });
          return;
        }
        ctx.addLine({
          type: "system",
          content: "[Muse Watch] Watch mode is already running. Superagent is actively controlled by Muse.\nRun '/muse watch stop' to deactivate.",
          timestamp: now,
        });
        return;
      }

      try {
        await startMuseWatcher({
          workspace: allWatched[0] || ctx.agent?.workingDirectory || process.cwd(),
          workspaces: allWatched,
          transportType,
          tunnel: isTunnel,
          agent: ctx.agent,
          onProgress: (msg) => {
            ctx.addLine({
              type: "system",
              content: `[Muse Progress] ${msg}`,
              timestamp: Date.now(),
            });
          },
          onToolStart: (toolCall, description) => {
            if (ctx.agent?.onEvent) {
              ctx.agent.onEvent({
                type: "tool_start",
                toolCall,
                description,
              });
              return;
            }
            ctx.addLine({
              type: "tool_start",
              content: `⚡ ${description}\n   Detail: ${toolCall.name}(${JSON.stringify(toolCall.args || {})})`,
              timestamp: Date.now(),
            });
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
            ctx.addLine({
              type: "tool_end",
              content: `✔ ${description}`,
              timestamp: Date.now(),
            });
          },
          onLine: (line) => {
            ctx.addLine({
              type: (line.type as any) || "system",
              content: line.content,
              timestamp: line.timestamp || Date.now(),
            });
          },
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `[Muse Watch] Failed to start watch mode: ${err.message}`,
          timestamp: now,
        });
      }
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
          "  /muse watch                  - Enter watch mode (superagent controlled by Muse)",
          "  /muse watch stop             - Stop watch mode",
          "  /muse watch status           - Show watch mode statistics",
          "  /muse stop                   - Cancel active remote task",
          "  /muse cancel                 - Cancel active remote task",
          "  /muse new                    - Reset remote session memory",
          "  /muse reset                  - Reset remote session memory",
          "  /muse config <key> <value>",
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
