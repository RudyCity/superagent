import path from "path";
import type { SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  maskSecret,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  setWatchedWorkspaces,
  RemoteAgentConfig,
} from "../remoteAgent/config.js";

export async function handleMuseConfigSubcommand(
  parts: string[],
  ctx: SlashCommandContext,
  now: number
): Promise<void> {
  const key = parts[1]?.toLowerCase();
  const val = parts.slice(2).join(" ").trim();

  if (!key) {
    const cfg = loadRemoteAgentConfig();
    const watchedList = getWatchedWorkspaces(cfg);
    const lines = [
      "Remote Agent Configuration:",
      `- transport          : ${cfg.transport || "telegram"}`,
      `- as_runner_model    : ${cfg.asRunner ? "on (enabled)" : "off (disabled)"}`,
      `- botToken           : ${maskToken(cfg.botToken)}`,
      `- groupId            : ${cfg.groupId || "(not set)"}`,
      `- museBotId          : ${cfg.museBotId || "(not set)"}`,
      `- wsPort             : ${cfg.wsPort || 9225}`,
      `- wsHost             : ${cfg.wsHost || "127.0.0.1"}`,
      `- wsToken            : ${maskSecret(cfg.wsToken)}`,
      `- wsPath             : ${cfg.wsPath || "/muse"}`,
      `- wsMode             : ${cfg.wsMode || "server"}`,
      `- wsRemoteUrl        : ${cfg.wsRemoteUrl || "(not set)"}`,
      `- cfAccessClientId   : ${cfg.cfAccessClientId || "(not set)"}`,
      `- autoTokenRefresh   : ${cfg.autoTokenRefresh ? "on (enabled)" : "off (disabled)"}`,
      `- defaultWorkspace   : ${cfg.defaultWorkspace || "(default to current workspace)"}`,
      `- watchedWorkspaces (${watchedList.length}):\n${watchedList.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`,
      `- systemPrompt       : ${cfg.systemPrompt ? `configured (${cfg.systemPrompt.length} chars)` : "default (auto-injected)"}`,
      "",
      "Usage: /muse config <key> <value>",
      "Keys:",
      "  transport        - Transport type: 'websocket' or 'telegram'",
      "  as_runner_model  - Route all terminal prompts to Muse directly without /muse (on/off)",
      "  wsPort           - Local WebSocket listen port (default: 9225)",
      "  wsHost           - Local WebSocket listen host (default: 127.0.0.1)",
      "  wsToken          - Bearer token ('generate', 'refresh', 'rotate', or raw string)",
      "  wsMode           - WebSocket mode: 'server' or 'client'",
      "  wsRemoteUrl      - Remote WebSocket URL when in client mode",
      "  cfAccessClientId - Cloudflare Access Service Token Client ID",
      "  cfAccessClientSecret - Cloudflare Access Service Token Client Secret",
      "  autoTokenRefresh - Background automatic token refresh (on/off)",
      "  botToken         - Telegram runner bot token (Bot B)",
      "  groupId          - Numeric private group chat ID (e.g. -100xxxxxxxxxx)",
      "  museBotId        - Numeric Telegram user ID of Muse bot (Bot A)",
      "  defaultWorkspace - Default project workspace path",
      "  workspaces       - Configure watched workspaces (add <dir>, remove <dir>, or comma list)",
      "  systemPrompt     - Custom system instructions injected into Muse requests",
      "",
      "Examples:",
      "  /muse config transport telegram",
      "  /muse config transport websocket",
      "  /muse config wsToken generate",
      "  /muse config wsPort 9225",
      "  /muse config workspaces add ./backend",
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
}
