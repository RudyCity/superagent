import type { RemoteAgentConfig } from "./config.js";

export interface WatcherTunnelMetadata {
  publicUrl?: string;
  wssUrl?: string;
  localUrl?: string;
  pid?: number;
  port?: number;
}

export interface WatcherTunnelParams {
  isHttps: boolean;
  wsPort?: number;
  config: RemoteAgentConfig;
  customConfigPath?: string;
  primaryWorkspace: string;
  workspaces: string[];
  emitLine: (type: string, content: string) => void;
  onLog?: (msg: string) => void;
}

export async function startWatcherTunnel(
  params: WatcherTunnelParams
): Promise<{ started: boolean; metadata: WatcherTunnelMetadata | null }> {
  try {
    const { isHttps, wsPort, config, customConfigPath, primaryWorkspace, workspaces, emitLine, onLog } = params;
    const effectivePort = wsPort || (isHttps ? 7888 : config.wsPort || 9225);
    emitLine("system", `[Cloudflare Tunnel] Launching quick ephemeral tunnel for port ${effectivePort}...`);

    const { startQuickTunnel, getTunnelStatus } = await import("./cloudflareTunnel.js");
    let tunnelMeta: WatcherTunnelMetadata | null = null;
    const existingStatus = getTunnelStatus(effectivePort);

    if (existingStatus.isRunning) {
      tunnelMeta = existingStatus;
    } else {
      tunnelMeta = await startQuickTunnel({
        port: effectivePort,
        host: isHttps ? "127.0.0.1" : (config.wsHost || "127.0.0.1"),
        path: isHttps ? "" : (config.wsPath || "/muse"),
        customConfigPath,
        workspace: primaryWorkspace,
        workspaces,
        onLog: (msg) => onLog?.(`[Tunnel] ${msg.trim()}`),
      });
    }

    if (isHttps) {
      const { getServerAuthToken } = await import("../utils/serverSecurity.js");
      const { copyTextToClipboard } = await import("./cloudflareTunnel.js");
      const serverToken = getServerAuthToken(effectivePort);
      const publicHttpsUrl = tunnelMeta.publicUrl || `http://127.0.0.1:${effectivePort}`;
      const curlSnippet = `curl -H "Authorization: Bearer ${serverToken}" ${publicHttpsUrl}/api/status`;
      const copied = await copyTextToClipboard(curlSnippet);

      emitLine(
        "system",
        [
          "═════════════════════════════════════════════════════════════════════════════",
          "  Superagent HTTP REST/SSE Server Watch Online (Cloudflare Quick Tunnel)!",
          "═════════════════════════════════════════════════════════════════════════════",
          `- Public HTTPS URL : ${tunnelMeta.publicUrl || "(initializing)"}`,
          `- Local Target     : ${tunnelMeta.localUrl || `http://127.0.0.1:${effectivePort}`}`,
          `- Server Port      : ${effectivePort}`,
          `- Process PID      : ${tunnelMeta.pid || process.pid}`,
          `- Bearer Token     : ${serverToken}`,
          "═════════════════════════════════════════════════════════════════════════════",
          "",
          copied
            ? "Test with curl (copied to clipboard, ready to run):"
            : "Test with curl (copy & run):",
          "-----------------------------------------------------------------------------",
          curlSnippet,
          "-----------------------------------------------------------------------------",
          "",
          "Superagent is actively listening in WATCH mode over HTTPS (REST API & SSE).",
          "External clients or Muse can connect using Bearer token authentication.",
          "Run '/muse watch stop' or '/muse tunnel stop --https' to stop watch mode.",
        ].join("\n")
      );
    } else {
      const { buildMuseConnectionPrompt, copyTextToClipboard } = await import("./cloudflareTunnel.js");
      const musePrompt = buildMuseConnectionPrompt({
        wssUrl: tunnelMeta.wssUrl || "",
        token: config.wsToken,
        publicUrl: tunnelMeta.publicUrl,
        localUrl: tunnelMeta.localUrl,
        workspaces,
        cfClientId: config.cfAccessClientId,
        cfClientSecret: config.cfAccessClientSecret,
      });
      const copied = await copyTextToClipboard(musePrompt);

      emitLine(
        "system",
        `[Cloudflare Tunnel] Quick tunnel online!\n- Public WSS URL : ${tunnelMeta.wssUrl}\n- Bearer Token   : ${config.wsToken}\n- Local Target   : ${tunnelMeta.localUrl}\n\n${copied ? "Prompt for Muse (copied to clipboard, ready to send):" : "Prompt for Muse (copy & send to Muse):"}\n-----------------------------------------------------------------------------\n${musePrompt}\n-----------------------------------------------------------------------------`
      );
    }

    return { started: true, metadata: tunnelMeta };
  } catch (err: any) {
    params.emitLine(
      "system",
      `[Cloudflare Tunnel] Warning: Failed to establish quick tunnel: ${err?.message}`
    );
    return { started: false, metadata: null };
  }
}

export async function stopWatcherTunnel(effectivePort: number): Promise<void> {
  try {
    const { stopQuickTunnel } = await import("./cloudflareTunnel.js");
    await stopQuickTunnel(effectivePort);
  } catch {}
}
