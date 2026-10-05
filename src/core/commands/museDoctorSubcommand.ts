import path from "path";
import fs from "fs";
import { SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  getWatchedWorkspaces,
  maskToken,
  maskSecret,
} from "../remoteAgent/config.js";

/**
 * Handles `/muse doctor`, `/muse ping`, and `/muse test` diagnostic checks.
 */
export async function handleMuseDoctorSubcommand(
  parts: string[],
  ctx: SlashCommandContext,
  now: number
): Promise<void> {
  ctx.addLine({
    type: "system",
    content: "Running Muse environment and connectivity diagnostics...",
    timestamp: now,
  });

  const cfg = loadRemoteAgentConfig();
  const transport = cfg.transport || "telegram";
  const checks: string[] = [];
  let hasWarnings = false;
  let hasErrors = false;

  // 1. Cloudflare Tunnel Binary Check
  try {
    const { findCloudflaredBinary } = await import("../remoteAgent/cloudflareTunnel.js");
    const bin = await findCloudflaredBinary();
    if (bin) {
      checks.push(`✔ Cloudflare Binary : FOUND (${bin})`);
    } else {
      checks.push("✖ Cloudflare Binary : NOT FOUND on PATH\n   Recommendation: Install via 'winget install Cloudflare.cloudflared' or 'brew install cloudflared'");
      hasWarnings = true;
    }
  } catch (err: any) {
    checks.push(`✖ Cloudflare Binary : Error detecting (${err.message})`);
    hasWarnings = true;
  }

  // 2. Transport Configuration
  checks.push(`ℹ Active Transport  : ${transport.toUpperCase()}`);

  if (transport === "websocket") {
    // WebSocket Checks
    const port = cfg.wsPort || 9225;
    const token = cfg.wsToken;
    const mode = cfg.wsMode || "server";

    checks.push(`ℹ WebSocket Mode    : ${mode.toUpperCase()} (port ${port}, host ${cfg.wsHost || "127.0.0.1"})`);

    if (token) {
      if (token.length >= 24) {
        checks.push(`✔ Bearer Token      : CONFIGURED (secure 256-bit token: ${maskSecret(token)})`);
      } else {
        checks.push(`⚠ Bearer Token      : WEAK (< 24 chars). Recommend running '/muse config wsToken generate'`);
        hasWarnings = true;
      }
    } else {
      checks.push("✖ Bearer Token      : NOT CONFIGURED. Run '/muse config wsToken generate'");
      hasErrors = true;
    }

    if (mode === "client") {
      if (cfg.wsRemoteUrl) {
        checks.push(`✔ Remote Endpoint   : ${cfg.wsRemoteUrl}`);
      } else {
        checks.push("✖ Remote Endpoint   : wsRemoteUrl not set. Run '/muse config wsRemoteUrl <url>'");
        hasErrors = true;
      }
    }

    // Active Tunnel Check
    try {
      const { getTunnelStatus, listActiveTunnels } = await import("../remoteAgent/cloudflareTunnel.js");
      const status = getTunnelStatus(port);
      const activeList = listActiveTunnels();
      if (status.isRunning) {
        checks.push(`✔ Quick Tunnel      : ACTIVE (PID: ${status.pid}, Public: ${status.publicUrl}, WSS: ${status.wssUrl})`);
      } else if (activeList.length > 0) {
        checks.push(`✔ Quick Tunnels     : ${activeList.length} active on ports: ${activeList.map((t) => t.port).join(", ")}`);
      } else {
        checks.push("ℹ Quick Tunnel      : INACTIVE. Run '/muse tunnel start' to expose over Internet.");
      }
    } catch {}
  } else {
    // Telegram Checks
    if (cfg.botToken) {
      checks.push(`✔ Bot Token         : CONFIGURED (${maskToken(cfg.botToken)})`);
      try {
        const { MuseClient } = await import("../remoteAgent/museClient.js");
        const client = new MuseClient(cfg);
        const me = await client.getMeInfo();
        if (me.ok) {
          checks.push(`✔ Telegram Bot API  : ONLINE (@${me.username || me.firstName})`);
          if (me.canReadGroupMessages === false) {
            checks.push("⚠ Group Privacy     : ENABLED (Bot cannot read non-reply messages! In @BotFather: /setprivacy -> @bot -> Disable)");
            hasWarnings = true;
          } else {
            checks.push("✔ Group Privacy     : DISABLED (Bot can read all group messages)");
          }
        } else {
          checks.push(`✖ Telegram Bot API  : FAILED (${me.error || "Invalid bot token"})`);
          hasErrors = true;
        }
      } catch (err: any) {
        checks.push(`✖ Telegram Bot API  : ERROR (${err.message})`);
        hasErrors = true;
      }
    } else {
      checks.push("✖ Bot Token         : NOT SET. Run '/muse config botToken <token>'");
      hasErrors = true;
    }

    if (cfg.groupId) {
      checks.push(`✔ Telegram Group ID : ${cfg.groupId}`);
    } else {
      checks.push("✖ Telegram Group ID : NOT SET. Run '/muse config groupId <numeric_id>'");
      hasErrors = true;
    }

    if (cfg.museBotId) {
      checks.push(`✔ Muse Bot ID       : ${cfg.museBotId}`);
    } else {
      checks.push("✖ Muse Bot ID       : NOT SET. Run '/muse config museBotId <numeric_id>'");
      hasErrors = true;
    }
  }

  // 3. Watched Workspaces Check
  const watched = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
  if (watched.length > 0) {
    let allExist = true;
    for (const w of watched) {
      if (!fs.existsSync(w)) {
        checks.push(`⚠ Watched Directory : NOT FOUND on disk (${w})`);
        allExist = false;
        hasWarnings = true;
      }
    }
    if (allExist) {
      checks.push(`✔ Watched Workspace : ${watched.length} directory/directories accessible`);
    }
  } else {
    checks.push("ℹ Watched Workspace : None configured (defaults to current directory)");
  }

  // 4. Watcher Daemon State
  try {
    const { isMuseWatcherActive, getMuseWatcher } = await import("../remoteAgent/museWatcher.js");
    if (isMuseWatcherActive()) {
      const stats = getMuseWatcher()?.getStats();
      checks.push(`✔ Muse Watcher      : RUNNING (Uptime: ${stats?.uptimeSeconds || 0}s, Batches: ${stats?.batchesExecuted || 0})`);
    } else {
      checks.push("ℹ Muse Watcher      : IDLE (Run '/muse watch' or '/muse tunnel start' to listen)");
    }
  } catch {}

  const header = [
    "═════════════════════════════════════════════════════════════════════════════",
    "  Muse Health & Diagnostics (Doctor)",
    "═════════════════════════════════════════════════════════════════════════════",
  ];

  const conclusion = hasErrors
    ? "\n❌ Diagnostic result: Configuration errors detected. Please address items marked with ✖."
    : hasWarnings
      ? "\n⚠️ Diagnostic result: Environment ready with warnings. Review items marked with ⚠."
      : "\n✅ Diagnostic result: All checks passed! Ready for remote Muse coordination.";

  ctx.addLine({
    type: "system",
    content: [...header, ...checks, conclusion].join("\n"),
    timestamp: Date.now(),
  });
}

/**
 * Handles `/muse connect` command to test connectivity.
 */
export async function handleMuseConnectSubcommand(
  parts: string[],
  ctx: SlashCommandContext,
  now: number
): Promise<void> {
  const cfg = loadRemoteAgentConfig();
  const transport = cfg.transport || "telegram";

  ctx.addLine({
    type: "system",
    content: `[Muse Connect] Testing connection over ${transport.toUpperCase()}...`,
    timestamp: now,
  });

  if (transport === "websocket") {
    const mode = cfg.wsMode || "server";
    const port = cfg.wsPort || 9225;
    const { getTunnelStatus } = await import("../remoteAgent/cloudflareTunnel.js");
    const { isMuseWatcherActive } = await import("../remoteAgent/museWatcher.js");

    const status = getTunnelStatus(port);
    const watcherRunning = isMuseWatcherActive(port);

    if (mode === "client") {
      const remoteUrl = cfg.wsRemoteUrl;
      if (!remoteUrl) {
        ctx.addLine({
          type: "error",
          content: "[Muse Connect] Remote URL not set in client mode. Run '/muse config wsRemoteUrl <url>'",
          timestamp: Date.now(),
        });
        return;
      }
      ctx.addLine({
        type: "system",
        content: `[Muse Connect] Client mode target: ${remoteUrl}\nTo start background client connection, run '/muse watch --ws'`,
        timestamp: Date.now(),
      });
      return;
    }

    // Server mode
    if (status.isRunning && watcherRunning) {
      ctx.addLine({
        type: "system",
        content: [
          "[Muse Connect] WebSocket server & Cloudflare tunnel are ONLINE:",
          `- Public URL   : ${status.publicUrl}`,
          `- WSS Endpoint : ${status.wssUrl}`,
          `- Process PID  : ${status.pid}`,
          `- Token        : ${maskSecret(cfg.wsToken)}`,
          "Superagent is actively ready to receive remote Muse instructions.",
        ].join("\n"),
        timestamp: Date.now(),
      });
    } else if (watcherRunning) {
      ctx.addLine({
        type: "system",
        content: `[Muse Connect] WebSocket server is active locally on ws://${cfg.wsHost || "127.0.0.1"}:${port}${cfg.wsPath || "/muse"}, but no Cloudflare tunnel is active.\nRun '/muse tunnel start' to expose publicly.`,
        timestamp: Date.now(),
      });
    } else {
      ctx.addLine({
        type: "system",
        content: `[Muse Connect] WebSocket server is not running.\nRun '/muse tunnel start' to launch tunnel and server.`,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // Telegram
  if (!cfg.botToken || !cfg.groupId || !cfg.museBotId) {
    ctx.addLine({
      type: "error",
      content: "[Muse Connect] Telegram credentials incomplete. Required: botToken, groupId, museBotId. Run /muse config.",
      timestamp: Date.now(),
    });
    return;
  }

  try {
    const startTime = Date.now();
    const { MuseClient } = await import("../remoteAgent/museClient.js");
    const client = new MuseClient(cfg);
    const me = await client.getMeInfo();
    const latency = Date.now() - startTime;

    if (me.ok) {
      ctx.addLine({
        type: "system",
        content: [
          `[Muse Connect] Telegram Bot API connection SUCCESSFUL (${latency}ms):`,
          `- Bot Username : @${me.username || me.firstName}`,
          `- Group ID     : ${cfg.groupId}`,
          `- Muse Bot ID  : ${cfg.museBotId}`,
          me.canReadGroupMessages === false
            ? "⚠️ Warning: Group Privacy Mode is ENABLED. Bot will only receive replies or commands. Disable in @BotFather."
            : "✔ Bot is ready to receive instructions from Muse in group.",
        ].join("\n"),
        timestamp: Date.now(),
      });
    } else {
      ctx.addLine({
        type: "error",
        content: `[Muse Connect] Telegram connection failed: ${me.error || "Unknown error"}`,
        timestamp: Date.now(),
      });
    }
  } catch (err: any) {
    ctx.addLine({
      type: "error",
      content: `[Muse Connect] Telegram connection error: ${err.message}`,
      timestamp: Date.now(),
    });
  }
}
