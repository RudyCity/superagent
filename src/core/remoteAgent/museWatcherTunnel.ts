import { updateRemoteAgentConfig, type RemoteAgentConfig } from "./config.js";
import { clearWsRemoteUrl, isProcessRunning, readTunnelState } from "./cloudflareTunnel.js";

export interface WatcherTunnelMetadata {
  publicUrl?: string;
  wssUrl?: string;
  localUrl?: string;
  pid?: number;
  port?: number;
  serviceKind?: "muse-websocket" | "superagent-http" | "mcp-http" | "unknown";
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
): Promise<{ started: boolean; metadata: WatcherTunnelMetadata | null; owned: boolean }> {
  let effectivePort: number | undefined;
  let createdTunnel = false;
  const { isHttps, wsPort, config, customConfigPath, primaryWorkspace, workspaces, emitLine, onLog } = params;
  const serviceKind = isHttps ? "superagent-http" : "muse-websocket";
  try {
    effectivePort = wsPort || (isHttps ? 7888 : config.wsPort || 9225);
    emitLine("system", `[Cloudflare Tunnel] Launching quick ephemeral tunnel for port ${effectivePort}...`);

    const { startQuickTunnel, getTunnelStatus, stopQuickTunnel, isSameTunnelTarget } = await import("./cloudflareTunnel.js");
    let tunnelMeta: WatcherTunnelMetadata | null = null;
    const existingStatus = getTunnelStatus(effectivePort);
    const expectedLocalTarget = `http://${isHttps ? "127.0.0.1" : (config.wsHost || "127.0.0.1")}:${effectivePort}`;
    if (
      existingStatus.isRunning &&
      existingStatus.serviceKind &&
      existingStatus.serviceKind !== "unknown" &&
      existingStatus.serviceKind !== serviceKind
    ) {
      throw new Error(`Port ${effectivePort} already has a ${existingStatus.serviceKind} tunnel.`);
    }
    if (existingStatus.isRunning && !isSameTunnelTarget(existingStatus.localUrl, expectedLocalTarget)) {
      throw new Error(`Tunnel on port ${effectivePort} forwards to ${existingStatus.localUrl || "an unknown target"}, not ${expectedLocalTarget}.`);
    }

    if (existingStatus.isRunning) {
      tunnelMeta = existingStatus;
    } else {
      tunnelMeta = await startQuickTunnel({
        port: effectivePort,
        host: isHttps ? "127.0.0.1" : (config.wsHost || "127.0.0.1"),
        path: isHttps ? "" : (config.wsPath || "/muse"),
        serviceKind,
        customConfigPath,
        workspace: primaryWorkspace,
        workspaces,
        onLog: (msg) => onLog?.(`[Tunnel] ${msg.trim()}`),
        onExit: (metadata) => {
          if (serviceKind === "muse-websocket" && metadata.wssUrl) {
            clearWsRemoteUrl(metadata.wssUrl, customConfigPath);
          }
        },
      });
      createdTunnel = true;
    }

    const { claimTunnelServiceKind } = await import("./cloudflareTunnel.js");
    const claimed = claimTunnelServiceKind(effectivePort, serviceKind, customConfigPath);
    if (!claimed) {
      throw new Error(`Could not claim tunnel on port ${effectivePort} as ${serviceKind}.`);
    }
    tunnelMeta = claimed;
    if (serviceKind === "muse-websocket" && claimed.wssUrl) {
      updateRemoteAgentConfig({ wsRemoteUrl: claimed.wssUrl }, customConfigPath);
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

    return { started: true, metadata: tunnelMeta, owned: createdTunnel };
  } catch (err: any) {
    if (createdTunnel && effectivePort) {
      try {
        await stopWatcherTunnel(effectivePort, serviceKind, customConfigPath);
      } catch {}
    }
    params.emitLine(
      "error",
      `[Cloudflare Tunnel] Failed to establish quick tunnel: ${err?.message || String(err)}`
    );
    return { started: false, metadata: null, owned: false };
  }
}

/** Stops a Muse-owned tunnel and clears only that tunnel's matching remote URL. */
export async function stopOwnedMuseTunnel(
  effectivePort: number,
  customConfigPath?: string
): Promise<boolean> {
  const { stopQuickTunnel } = await import("./cloudflareTunnel.js");
  const before = readTunnelState(effectivePort);
  const stopped = await stopQuickTunnel(effectivePort, "muse-websocket").catch(() => false);
  const staleOwnedState = Boolean(before?.serviceKind === "muse-websocket" && before.pid && !isProcessRunning(before.pid));
  if (before?.serviceKind === "muse-websocket" && before.wssUrl && (stopped || staleOwnedState)) {
    clearWsRemoteUrl(before.wssUrl, customConfigPath);
  }
  return stopped;
}

export async function stopWatcherTunnel(
  effectivePort: number,
  serviceKind: "muse-websocket" | "superagent-http" = "muse-websocket",
  customConfigPath?: string
): Promise<void> {
  try {
    if (serviceKind === "muse-websocket") {
      await stopOwnedMuseTunnel(effectivePort, customConfigPath);
    } else {
      const { stopQuickTunnel } = await import("./cloudflareTunnel.js");
      await stopQuickTunnel(effectivePort, serviceKind);
    }
  } catch {}
}
