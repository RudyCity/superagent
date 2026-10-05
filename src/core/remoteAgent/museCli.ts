import path from "path";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  maskToken,
  maskSecret,
  generateSecureWsToken,
  isMuseWsActive,
  RemoteAgentConfig,
  RemoteAgentTransport,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  setWatchedWorkspaces,
} from "./config.js";
import { runRemoteTask } from "./taskRunner.js";
import { formatReadableSummary } from "./formatSummary.js";

export async function handleMuseCliCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || "status").toLowerCase();

  if (subcommand === "status") {
    const cfg = loadRemoteAgentConfig();
    const transport = cfg.transport || "telegram";
    const isTelegramConfigured = Boolean(cfg.botToken && cfg.groupId && cfg.museBotId);
    const isWsConfigured = isMuseWsActive();
    const isConfigured = transport === "websocket" ? isWsConfigured : isTelegramConfigured;
    const watched = getWatchedWorkspaces(cfg);

    console.log("Remote Agent (Muse) Status:");
    console.log(`  Configured      : ${isConfigured ? "Yes" : "No (run: superagent muse config)"}`);
    console.log(`  Transport       : ${transport.toUpperCase()}`);
    console.log(`  Runner Mode     : ${cfg.asRunner ? "ENABLED (normal terminal prompts route to Muse)" : "DISABLED"}`);

    if (transport === "websocket") {
      const host = cfg.wsHost || "127.0.0.1";
      const port = cfg.wsPort || 9225;
      const wsPath = cfg.wsPath || "/muse";
      const { getTunnelStatus, listActiveTunnels } = await import("./cloudflareTunnel.js");
      const activeTunnels = listActiveTunnels();
      const wsTunnel = getTunnelStatus(port);
      const firstActive = activeTunnels[0];
      const tunnel = wsTunnel.isRunning ? wsTunnel : (firstActive ? { isRunning: true, ...firstActive } : wsTunnel);
      console.log(`  WS Mode         : ${(cfg.wsMode || "server").toUpperCase()}`);
      console.log(`  WS Endpoint     : ws://${host}:${port}${wsPath}`);
      if (activeTunnels.length > 1) {
        console.log(`  Quick Tunnel    : ACTIVE (${activeTunnels.length} running: ${activeTunnels.map((t) => `port ${t.port}`).join(", ")})`);
        activeTunnels.forEach((t, idx) => {
          console.log(`    ${idx + 1}. Port ${t.port}: ${t.wssUrl} (PID: ${t.pid}, Uptime: ${t.uptimeSeconds}s)`);
        });
      } else {
        console.log(`  Quick Tunnel    : ${tunnel.isRunning ? `ACTIVE (${tunnel.wssUrl}, PID: ${tunnel.pid}${tunnel.port && tunnel.port !== port ? `, Port: ${tunnel.port}` : ""})` : "INACTIVE (run: superagent muse tunnel start)"}`);
      }
      console.log(`  Bearer Token    : ${maskSecret(cfg.wsToken)}`);
      console.log(`  CF-Access ID    : ${cfg.cfAccessClientId || "(disabled)"}`);
      if (cfg.wsMode === "client") {
        console.log(`  Remote URL      : ${cfg.wsRemoteUrl || "(not set)"}`);
      }
    } else {
      console.log(`  Bot Token       : ${maskToken(cfg.botToken)}`);
      console.log(`  Telegram Group  : ${cfg.groupId || "(not set)"}`);
      console.log(`  Muse Bot ID     : ${cfg.museBotId || "(not set)"}`);
    }

    if (watched.length > 1) {
      console.log(`  Watched Projects (${watched.length}):`);
      watched.forEach((w, i) => console.log(`    ${i + 1}. ${path.basename(w)} (${w})`));
    } else {
      console.log(`  Default Ws      : ${cfg.defaultWorkspace || process.cwd()}`);
    }
    console.log("");
    console.log("Commands & Configuration:");
    console.log("  superagent muse tunnel           - Cloudflare Tunnel setup guide & config");
    console.log("  superagent muse tunnel list      - List all currently active Cloudflare quick tunnels");
    console.log("  superagent muse tunnel start     - Start quick ephemeral Cloudflare Tunnel (optional: --port <n>)");
    console.log("  superagent muse tunnel stop      - Stop running ephemeral tunnel (optional: --port <n> or all)");
    console.log("  superagent muse tunnel status    - Check Cloudflare Tunnel process status (optional: --port <n>)");
    console.log("  superagent muse watch --ws       - Watch projects via WebSocket");
    console.log("  superagent muse watch --tunnel   - Watch projects and expose via Cloudflare Tunnel");
    console.log("  superagent muse config transport websocket|telegram");
    console.log("  superagent muse config wsToken generate");
    console.log("  superagent muse config wsPort 9225");
    console.log("  superagent muse watch <dir1> <dir2> ...");
    return;
  }

  if (subcommand === "tunnel" || subcommand === "cloudflare") {
    const isHttps = args.some((a) => a.toLowerCase() === "--https" || a.toLowerCase() === "--http" || a.toLowerCase() === "--web");
    const nonFlagArgs = args.slice(1).filter((a) => !a.startsWith("-"));
    const action = (nonFlagArgs[0] || (isHttps ? "start" : "guide")).toLowerCase();
    const cfg = loadRemoteAgentConfig();
    const host = cfg.wsHost || "127.0.0.1";
    const port = cfg.wsPort || 9225;
    const pathEndpoint = cfg.wsPath || "/muse";
    let token = cfg.wsToken;

    if (!token && !isHttps) {
      token = generateSecureWsToken();
      updateRemoteAgentConfig({ wsToken: token, transport: "websocket" });
      console.log(`[Muse Security] Generated new Bearer token: ${token}\n`);
    }

    const {
      startQuickTunnel,
      stopQuickTunnel,
      stopAllQuickTunnels,
      getTunnelStatus,
      listActiveTunnels,
      formatActiveTunnels,
      buildMuseConnectionPrompt,
      copyTextToClipboard,
    } = await import("./cloudflareTunnel.js");
    const {
      startMuseWatcher,
      stopMuseWatcher,
      isMuseWatcherActive,
    } = await import("./museWatcher.js");

    if (action === "list" || action === "ls" || action === "active") {
      const tunnels = listActiveTunnels();
      console.log("");
      console.log(formatActiveTunnels(tunnels));
      console.log("");
      return;
    }

    if (action === "start" || action === "quick" || action === "run" || action === "dev") {
      const isDetach =
        args.includes("--detach") ||
        args.includes("-d") ||
        args.includes("--background") ||
        args.includes("--bg");
      const portArgIdx = args.findIndex((a) => a === "--port" || a === "-p");
      let portOverride: number | undefined;
      if (portArgIdx !== -1 && args[portArgIdx + 1]) {
        const parsed = parseInt(args[portArgIdx + 1], 10);
        if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
      }

      let promptTask: string | undefined;
      const promptArgIdx = args.findIndex((a) => a === "--prompt" || a === "--task");
      if (promptArgIdx !== -1 && args[promptArgIdx + 1]) {
        promptTask = args[promptArgIdx + 1];
      } else {
        const leftover = args.slice(2).filter((a, idx, arr) => {
          if (
            a === "--detach" ||
            a === "-d" ||
            a === "--background" ||
            a === "--bg" ||
            a === "--verbose" ||
            a === "--https" ||
            a === "--http" ||
            a === "--web"
          )
            return false;
          if (a === "--port" || a === "-p") return false;
          if (idx > 0 && (arr[idx - 1] === "--port" || arr[idx - 1] === "-p")) return false;
          return true;
        });
        if (leftover.length > 0) {
          promptTask = leftover.join(" ");
        }
      }

      const effectivePort = portOverride || (isHttps ? 7888 : port);
      const existing = getTunnelStatus(effectivePort);

      if (isHttps) {
        const { getServerAuthToken } = await import("../utils/serverSecurity.js");
        const { ensureSuperagentServer } = await import("./cloudflareTunnel.js");

        if (existing.isRunning) {
          const serverToken = getServerAuthToken(effectivePort);
          const curlSnippet = `curl -H "Authorization: Bearer ${serverToken}" ${existing.publicUrl}/api/status`;
          console.log("[Cloudflare HTTPS Tunnel] Quick tunnel and HTTP server are already ACTIVE:");
          console.log(`  Public HTTPS URL  : ${existing.publicUrl}`);
          console.log(`  Local Target      : ${existing.localUrl || `http://${host}:${effectivePort}`}`);
          console.log(`  Server Port       : ${effectivePort}`);
          console.log(`  Process PID       : ${existing.pid}`);
          console.log(`  Uptime            : ${existing.uptimeSeconds}s`);
          console.log(`  Bearer Token      : ${serverToken}`);
          console.log("");
          console.log("Test with curl (ready to run):");
          console.log("-----------------------------------------------------------------------------");
          console.log(curlSnippet);
          console.log("-----------------------------------------------------------------------------");
          await copyTextToClipboard(curlSnippet);
          return;
        }

        console.log(`[Cloudflare HTTPS Tunnel] Starting Superagent HTTP REST/SSE server (port ${effectivePort}) and Cloudflare quick tunnel...`);

        await ensureSuperagentServer(effectivePort);
        const serverToken = getServerAuthToken(effectivePort);

        const meta = await startQuickTunnel({
          port: effectivePort,
          host: "127.0.0.1",
          path: "",
        });

        const curlSnippet = `curl -H "Authorization: Bearer ${serverToken}" ${meta.publicUrl}/api/status`;
        await copyTextToClipboard(curlSnippet);

        console.log("");
        console.log("═════════════════════════════════════════════════════════════════════════════");
        console.log("  Superagent HTTP REST/SSE Server & Cloudflare Quick Tunnel Online!");
        console.log("═════════════════════════════════════════════════════════════════════════════");
        console.log(`  Public HTTPS URL  : ${meta.publicUrl}`);
        console.log(`  Local Target      : ${meta.localUrl}`);
        console.log(`  Server Port       : ${effectivePort}`);
        console.log(`  Process PID       : ${meta.pid}`);
        console.log(`  Bearer Token      : ${serverToken}`);
        console.log("═════════════════════════════════════════════════════════════════════════════");
        console.log("");
        console.log("Test with curl (copied to clipboard, ready to run):");
        console.log("-----------------------------------------------------------------------------");
        console.log(curlSnippet);
        console.log("-----------------------------------------------------------------------------");
        console.log("\nSuperagent HTTP server is listening over Cloudflare HTTPS tunnel.");
        console.log("Press Ctrl+C to stop tunnel and exit.\n");

        if (isDetach) {
          console.log("[Cloudflare HTTPS Tunnel] Running in background. Tunnel PID: " + meta.pid);
          return;
        }

        let isExiting = false;
        const cleanExit = async () => {
          if (isExiting) return;
          isExiting = true;
          console.log("\n[Cloudflare HTTPS Tunnel] Stopping tunnel...");
          await stopQuickTunnel(effectivePort);
          process.exit(0);
        };

        process.on("SIGINT", cleanExit);
        process.on("SIGTERM", cleanExit);

        await new Promise<void>(() => {});
        return;
      }

      if (existing.isRunning) {
        console.log("[Cloudflare Tunnel] Quick tunnel and WebSocket server are already ACTIVE:");
        console.log(`  Public URL        : ${existing.publicUrl}`);
        console.log(`  WSS Endpoint      : ${existing.wssUrl}`);
        console.log(`  Local Target      : ${existing.localUrl}`);
        console.log(`  Process PID       : ${existing.pid}`);
        console.log(`  Uptime            : ${existing.uptimeSeconds}s`);
        console.log(`  Bearer Token      : ${token}`);

        const watched = getWatchedWorkspaces(cfg, process.cwd());
        const musePrompt = buildMuseConnectionPrompt({
          wssUrl: existing.wssUrl || "",
          token,
          publicUrl: existing.publicUrl,
          localUrl: existing.localUrl,
          workspaces: watched,
          cfClientId: cfg.cfAccessClientId,
          cfClientSecret: cfg.cfAccessClientSecret,
          task: promptTask,
        });
        const copied = await copyTextToClipboard(musePrompt);

        console.log("");
        if (copied) {
          console.log("Prompt for Muse (copied to clipboard, ready to send):");
        } else {
          console.log("Prompt for Muse (copy & send to Muse):");
        }
        console.log("-----------------------------------------------------------------------------");
        console.log(musePrompt);
        console.log("-----------------------------------------------------------------------------");
        console.log("\n  To stop it, run: superagent muse tunnel stop\n");
        return;
      }

      console.log("[Cloudflare Tunnel] Starting Superagent WebSocket server and requesting Cloudflare quick tunnel...");
      try {
        if (isMuseWatcherActive(effectivePort)) {
          await stopMuseWatcher(effectivePort);
        }

        const watched = getWatchedWorkspaces(cfg, process.cwd());
        const watcher = await startMuseWatcher({
          workspace: watched[0],
          workspaces: watched,
          transportType: "websocket",
          tunnel: true,
          wsPort: effectivePort,
          onLine: (line) => console.log(line.content),
          onProgress: (msg) => console.log(`[Muse Progress] ${msg}`),
        });

        const meta = getTunnelStatus(effectivePort);
        const effectiveWss = meta.wssUrl || `wss://${meta.publicUrl?.replace(/^https?:\/\//, "")}${pathEndpoint}`;

        console.log("");
        console.log("═════════════════════════════════════════════════════════════════════════════");
        console.log("  Superagent WebSocket Server & Cloudflare Quick Tunnel Online!");
        console.log("═════════════════════════════════════════════════════════════════════════════");
        console.log(`  Public URL        : ${meta.publicUrl}`);
        console.log(`  WSS Endpoint      : ${effectiveWss}`);
        console.log(`  Local Target      : ${meta.localUrl || `http://${host}:${effectivePort}`}`);
        console.log(`  Process PID       : ${meta.pid}`);
        console.log(`  Bearer Token      : ${token}`);
        console.log("═════════════════════════════════════════════════════════════════════════════");

        const musePrompt = buildMuseConnectionPrompt({
          wssUrl: effectiveWss,
          token,
          publicUrl: meta.publicUrl,
          localUrl: meta.localUrl || `http://${host}:${effectivePort}`,
          workspaces: watched,
          cfClientId: cfg.cfAccessClientId,
          cfClientSecret: cfg.cfAccessClientSecret,
          task: promptTask,
        });
        const copied = await copyTextToClipboard(musePrompt);

        console.log("");
        if (copied) {
          console.log("Prompt for Muse (copied to clipboard, ready to send):");
        } else {
          console.log("Prompt for Muse (copy & send to Muse):");
        }
        console.log("-----------------------------------------------------------------------------");
        console.log(musePrompt);
        console.log("-----------------------------------------------------------------------------");

        console.log("\nSuperagent is actively listening in WATCH mode over WebSocket (controlled by Muse).");
        console.log("When Muse connects and sends remote tasks or tool batches, Superagent will execute them and report back.");
        console.log("Press Ctrl+C to stop tunnel and exit watch daemon.\n");

        let isExiting = false;
        const cleanExit = async () => {
          if (isExiting) return;
          isExiting = true;
          console.log("\n[Cloudflare Tunnel] Stopping tunnel and watch daemon...");
          await watcher.stop();
          await stopQuickTunnel(effectivePort);
          process.exit(0);
        };

        process.on("SIGINT", cleanExit);
        process.on("SIGTERM", cleanExit);

        // Keep process alive while watcher is active
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (!watcher.isActive()) {
              clearInterval(interval);
              resolve();
            }
          }, 1000);
        });
      } catch (err: any) {
        console.error(`\n[Cloudflare Tunnel Error] ${err?.message}\n`);
        return;
      }
      return;
    }

    if (action === "stop") {
      const { stopMuseWatcher, isMuseWatcherActive } = await import("./museWatcher.js");
      const { stopQuickTunnel, stopAllQuickTunnels, getTunnelStatus } = await import("./cloudflareTunnel.js");

      const isAll = args.includes("all") || args.includes("--all") || args.includes("-a");
      if (isAll) {
        if (isMuseWatcherActive()) {
          await stopMuseWatcher();
        }
        const count = await stopAllQuickTunnels();
        console.log(`[Cloudflare Tunnel] Stopped ${count} active quick tunnel${count === 1 ? "" : "s"}.`);
        return;
      }

      const portArgIdx = args.findIndex((a) => a === "--port" || a === "-p");
      let portOverride: number | undefined;
      if (portArgIdx !== -1 && args[portArgIdx + 1]) {
        const parsed = parseInt(args[portArgIdx + 1], 10);
        if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
      }

      const effectivePort = portOverride || (isHttps ? 7888 : port);

      if (isHttps) {
        const existing = getTunnelStatus(effectivePort);
        if (existing.isRunning) {
          await stopQuickTunnel(effectivePort);
          console.log(`[Cloudflare HTTPS Tunnel] Quick tunnel (port ${effectivePort}) stopped successfully.`);
        } else {
          console.log(`[Cloudflare HTTPS Tunnel] No quick tunnel is currently running on port ${effectivePort}.`);
        }
        return;
      }

      let stoppedAny = false;
      if (isMuseWatcherActive(effectivePort)) {
        await stopMuseWatcher(effectivePort);
        stoppedAny = true;
      }
      const existing = getTunnelStatus(effectivePort);
      if (existing.isRunning) {
        await stopQuickTunnel(effectivePort);
        stoppedAny = true;
      }

      if (!stoppedAny) {
        console.log(`[Cloudflare Tunnel] No quick tunnel is currently running${portOverride ? ` on port ${portOverride}` : ""}.`);
        return;
      }
      console.log(`[Cloudflare Tunnel] Quick tunnel (port ${effectivePort}) and watch daemon stopped successfully.`);
      return;
    }

    if (action === "status") {
      const portArgIdx = args.findIndex((a) => a === "--port" || a === "-p");
      let portOverride: number | undefined;
      if (portArgIdx !== -1 && args[portArgIdx + 1]) {
        const parsed = parseInt(args[portArgIdx + 1], 10);
        if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
      }

      const effectivePort = portOverride || (isHttps ? 7888 : port);
      const existing = getTunnelStatus(effectivePort);

      if (isHttps) {
        const { getServerAuthToken } = await import("../utils/serverSecurity.js");
        const serverToken = getServerAuthToken();
        if (existing.isRunning) {
          console.log(`Cloudflare HTTPS Tunnel Status (port ${effectivePort}): ACTIVE`);
          console.log(`  Public HTTPS URL  : ${existing.publicUrl}`);
          console.log(`  Local Target      : ${existing.localUrl}`);
          console.log(`  Server Port       : ${effectivePort}`);
          console.log(`  Process PID       : ${existing.pid}`);
          console.log(`  Uptime            : ${existing.uptimeSeconds}s`);
          console.log(`  Bearer Token      : ${serverToken}`);
          console.log("");
          console.log(`  Test: curl -H "Authorization: Bearer ${serverToken}" ${existing.publicUrl}/api/status`);
        } else {
          console.log(`Cloudflare HTTPS Tunnel Status (port ${effectivePort}): INACTIVE`);
          console.log(`  Run 'superagent tunnel start --https' to launch.`);
        }
        return;
      }

      if (existing.isRunning) {
        console.log(`Cloudflare Quick Tunnel Status${portOverride ? ` (port ${portOverride})` : ""}: ACTIVE`);
        console.log(`  Public URL        : ${existing.publicUrl}`);
        console.log(`  WSS Endpoint      : ${existing.wssUrl}`);
        console.log(`  Local Target      : ${existing.localUrl}`);
        console.log(`  Process PID       : ${existing.pid}`);
        console.log(`  Uptime            : ${existing.uptimeSeconds}s`);
        console.log(`  Bearer Token      : ${token ? maskSecret(token) : "(none)"}`);
      } else {
        console.log(`Cloudflare Quick Tunnel Status${portOverride ? ` (port ${portOverride})` : ""}: INACTIVE`);
        console.log(`  Run 'superagent muse tunnel start${portOverride ? ` --port ${portOverride}` : ""}' to launch a quick development tunnel.`);
      }
      return;
    }

    const currentStatus = getTunnelStatus();
    if (currentStatus.isRunning) {
      console.log(`[Cloudflare Tunnel] Quick tunnel is currently ACTIVE (PID: ${currentStatus.pid}, URL: ${currentStatus.publicUrl})\n`);
    }

    console.log("═════════════════════════════════════════════════════════════════════════════");
    console.log("  Cloudflare Tunnel Setup & Ephemeral Subcommands for Muse");
    console.log("═════════════════════════════════════════════════════════════════════════════");
    console.log("");
    console.log("Subcommands:");
    console.log("  superagent muse tunnel list            - List all active quick tunnels across all ports");
    console.log("  superagent muse tunnel start           - Start quick ephemeral tunnel (foreground, optional: --port <n>)");
    console.log("  superagent muse tunnel start --https   - Start Cloudflare HTTPS tunnel for Superagent REST/SSE server (port 7888)");
    console.log("  superagent muse tunnel start --detach  - Start quick ephemeral tunnel in background (optional: --port <n>)");
    console.log("  superagent muse tunnel stop            - Stop running ephemeral tunnel (optional: --port <n> or all)");
    console.log("  superagent muse tunnel stop --https    - Stop Cloudflare HTTPS tunnel (port 7888)");
    console.log("  superagent muse tunnel status          - Check current tunnel status (optional: --port <n>)");
    console.log("  superagent muse tunnel status --https  - Check Cloudflare HTTPS tunnel status (port 7888)");
    console.log("  superagent muse tunnel guide           - View full manual Cloudflare setup guide");
    console.log("");
    console.log("1. Prerequisites:");
    console.log("   - Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    console.log("   - Windows: winget install Cloudflare.cloudflared (or choco install cloudflared)");
    console.log("   - macOS  : brew install cloudflared");
    console.log("   - Linux  : sudo apt install cloudflared");
    console.log("");
    console.log("2. Quick Ephemeral Tunnel (Development / Testing):");
    console.log(`   cloudflared tunnel --url http://${host}:${port}`);
    console.log("   - Cloudflare will generate a public hostname: https://*.trycloudflare.com");
    console.log(`   - Connect Muse via WSS: wss://<subdomain>.trycloudflare.com${pathEndpoint}`);
    console.log("");
    console.log("3. Production Named Tunnel (Recommended):");
    console.log("   cloudflared tunnel login");
    console.log("   cloudflared tunnel create superagent-muse");
    console.log("   In ~/.cloudflared/config.yml:");
    console.log("   -------------------------------------------------");
    console.log("   tunnel: <TUNNEL_UUID>");
    console.log("   credentials-file: ~/.cloudflared/<TUNNEL_UUID>.json");
    console.log("   ingress:");
    console.log("     - hostname: muse.yourdomain.com");
    console.log(`       service: ws://${host}:${port}`);
    console.log("     - service: http_status:404");
    console.log("   -------------------------------------------------");
    console.log("   cloudflared tunnel route dns superagent-muse muse.yourdomain.com");
    console.log("   cloudflared tunnel run superagent-muse");
    console.log("");
    console.log("4. Edge Security with Cloudflare Access (Zero Trust):");
    console.log("   - Dashboard -> Zero Trust -> Access -> Applications -> Add application");
    console.log("   - Add Service Token under Access -> Service Auth");
    console.log("   - Set headers in Superagent:");
    console.log("     superagent muse config cfAccessClientId <CF_CLIENT_ID>");
    console.log("     superagent muse config cfAccessClientSecret <CF_CLIENT_SECRET>");
    console.log("");
    console.log("5. Multi-Project & Multi-Tunnel Isolation:");
    console.log("   - Run multiple tunnels on separate ports concurrently:");
    console.log("     Terminal 1 (Project A): cd project-a ; superagent muse tunnel start");
    console.log("     Terminal 2 (Project B): cd project-b ; superagent muse tunnel start --port 9226");
    console.log("   - Or watch multiple projects under a single tunnel:");
    console.log("     superagent muse watch /path/to/project-a /path/to/project-b --tunnel");
    console.log("");
    console.log("6. Muse Authentication Header:");
    console.log(`   Authorization: Bearer ${token}`);
    console.log("");
    console.log("7. Start Watch Daemon with Tunnel:");
    console.log("   superagent muse watch --tunnel");
    console.log("═════════════════════════════════════════════════════════════════════════════");
    return;
  }

  if (subcommand === "config") {
    const key = args[1]?.toLowerCase();
    const val = args.slice(2).join(" ").trim();

    if (!key) {
      const cfg = loadRemoteAgentConfig();
      const watched = getWatchedWorkspaces(cfg);
      console.log("Current Remote Agent Configuration:");
      console.log(`  transport        : ${cfg.transport || "telegram"}`);
      console.log(`  as_runner_model  : ${cfg.asRunner ? "on (enabled)" : "off (disabled)"}`);
      console.log(`  botToken         : ${maskToken(cfg.botToken)}`);
      console.log(`  groupId          : ${cfg.groupId || "(not set)"}`);
      console.log(`  museBotId        : ${cfg.museBotId || "(not set)"}`);
      console.log(`  wsPort           : ${cfg.wsPort || 9225}`);
      console.log(`  wsHost           : ${cfg.wsHost || "127.0.0.1"}`);
      console.log(`  wsToken          : ${maskSecret(cfg.wsToken)}`);
      console.log(`  wsPath           : ${cfg.wsPath || "/muse"}`);
      console.log(`  wsMode           : ${cfg.wsMode || "server"}`);
      console.log(`  wsRemoteUrl      : ${cfg.wsRemoteUrl || "(not set)"}`);
      console.log(`  cfAccessClientId : ${cfg.cfAccessClientId || "(not set)"}`);
      console.log(`  defaultWorkspace : ${cfg.defaultWorkspace || "(not set)"}`);
      console.log(`  watchedWorkspaces (${watched.length}):`);
      watched.forEach((w, i) => console.log(`    ${i + 1}. ${path.basename(w)} (${w})`));
      console.log("");
      console.log("Usage: superagent muse config <key> <value>");
      console.log("Examples:");
      console.log("  superagent muse config transport websocket");
      console.log("  superagent muse config wsToken generate");
      console.log("  superagent muse config wsPort 9225");
      console.log("  superagent muse config workspaces add ./backend");
      return;
    }

    if (key === "workspaces" || key === "workspace" || key === "projects") {
      if (!val || val === "list") {
        const list = getWatchedWorkspaces();
        console.log(`Watched workspaces (${list.length}):`);
        list.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
        return;
      }
      if (val.startsWith("add ")) {
        const p = val.slice(4).trim();
        const updated = addWatchedWorkspace(p);
        console.log(`Added watched workspace: ${p} (Total: ${updated.workspaces?.length || 1})`);
        return;
      }
      if (val.startsWith("remove ")) {
        const p = val.slice(7).trim();
        const updated = removeWatchedWorkspace(p);
        console.log(`Removed watched workspace: ${p} (Remaining: ${updated.workspaces?.length || 0})`);
        return;
      }
      const paths = val.split(/[,\s]+/).filter(Boolean);
      const updated = setWatchedWorkspaces(paths);
      console.log(`Watched workspaces set to (${updated.workspaces?.length || 0}):`);
      (updated.workspaces || []).forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
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
      console.error(`Unknown config key: ${key}. Valid keys: transport, wsToken, wsPort, wsHost, wsPath, wsMode, cfAccessClientId, cfAccessClientSecret, tokenTtl, botToken, groupId, museBotId, defaultWorkspace, workspaces`);
      return;
    }

    if (!val) {
      console.error(`Usage: superagent muse config ${key} <value>`);
      return;
    }

    const patch: Partial<RemoteAgentConfig> = {};
    if (mappedKey === "asRunner" || mappedKey === "autoTokenRefresh") {
      const lower = val.toLowerCase();
      if (["on", "true", "1", "yes", "enable", "enabled"].includes(lower)) {
        (patch as any)[mappedKey] = true;
      } else if (["off", "false", "0", "no", "disable", "disabled"].includes(lower)) {
        (patch as any)[mappedKey] = false;
      } else {
        console.error(`Invalid value for ${key}: "${val}". Use "on" or "off".`);
        return;
      }
    } else if (mappedKey === "transport") {
      const lower = val.toLowerCase();
      if (lower === "websocket" || lower === "ws") {
        patch.transport = "websocket";
      } else if (lower === "telegram" || lower === "tg") {
        patch.transport = "telegram";
      } else {
        console.error(`Invalid transport: "${val}". Supported: "telegram" or "websocket"`);
        return;
      }
    } else if (mappedKey === "wsPort" || mappedKey === "tokenTtlSeconds" || mappedKey === "tokenGracePeriodMs") {
      const p = parseInt(val, 10);
      if (isNaN(p) || p <= 0) {
        console.error(`Invalid integer for ${key}: "${val}".`);
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
        const { rotateWsToken } = await import("./config.js");
        const rotation = rotateWsToken();
        console.log(`Generated and rotated secure Bearer token (with 5-minute handover grace period):\n${rotation.newToken}`);
        return;
      }
      patch.wsToken = val;
    } else if (mappedKey === "wsMode") {
      const lower = val.toLowerCase();
      if (lower === "client" || lower === "server") {
        patch.wsMode = lower;
      } else {
        console.error(`Invalid wsMode: "${val}". Use "server" or "client".`);
        return;
      }
    } else {
      (patch as any)[mappedKey] = val;
    }

    updateRemoteAgentConfig(patch);
    const maskedVal =
      mappedKey === "botToken" || mappedKey === "wsToken" || mappedKey === "cfAccessClientSecret"
        ? maskSecret(String((patch as any)[mappedKey]))
        : mappedKey === "asRunner"
          ? (patch.asRunner ? "on (enabled)" : "off (disabled)")
          : (patch as any)[mappedKey];
    console.log(`Updated remoteAgent config: ${mappedKey} = ${maskedVal}`);
    return;
  }

  if (subcommand === "watch" || subcommand === "unwatch") {
    const action = subcommand === "unwatch" ? "stop" : (args[1]?.toLowerCase() || "start");
    const { startMuseWatcher, stopMuseWatcher, isMuseWatcherActive, getMuseWatcher } = await import("./museWatcher.js");

    if (action === "stop") {
      if (!isMuseWatcherActive()) {
        console.log("[Muse Watch] Watch mode is not currently running.");
        return;
      }
      await stopMuseWatcher();
      console.log("[Muse Watch] Watch mode stopped.");
      return;
    }

    if (action === "status") {
      const stats = getMuseWatcher()?.getStats();
      if (!stats || !stats.isRunning) {
        console.log("[Muse Watch] Watch mode is INACTIVE.");
        return;
      }
      console.log("Muse Watch Mode: ACTIVE (controlled by Muse)");
      console.log(`  Transport         : ${stats.transportDetails || stats.transport || "telegram"}`);
      if (stats.workspaces && stats.workspaces.length > 1) {
        console.log(`  Watched Projects (${stats.workspaces.length}):`);
        stats.workspaces.forEach((w, i) => console.log(`    ${i + 1}. ${path.basename(w)} (${w})`));
      } else {
        console.log(`  Workspace         : ${stats.workspace}`);
      }
      console.log(`  Uptime            : ${stats.uptimeSeconds}s`);
      console.log(`  Batches Executed  : ${stats.batchesExecuted}`);
      console.log(`  Tasks Completed   : ${stats.tasksCompleted}`);
      console.log(`  Active Task       : ${stats.activeTaskId || "none (idle)"}`);
      return;
    }

    if (action === "add") {
      const dirToAdd = args.slice(2).join(" ").trim();
      if (!dirToAdd) {
        console.error("Usage: superagent muse watch add <project_directory>");
        return;
      }
      const resolved = path.resolve(dirToAdd);
      addWatchedWorkspace(resolved);
      getMuseWatcher()?.addWorkspace(resolved);
      console.log(`[Muse Watch] Added project "${path.basename(resolved)}" (${resolved}) to watched projects.`);
      return;
    }

    if (action === "remove") {
      const dirToRem = args.slice(2).join(" ").trim();
      if (!dirToRem) {
        console.error("Usage: superagent muse watch remove <project_directory>");
        return;
      }
      const resolved = path.resolve(dirToRem);
      removeWatchedWorkspace(resolved);
      getMuseWatcher()?.removeWorkspace(resolved);
      console.log(`[Muse Watch] Removed project "${path.basename(resolved)}" (${resolved}) from watched projects.`);
      return;
    }

    // Default: start
    const isWs = args.some((a) => a === "--ws" || a === "--websocket");
    const isTg = args.some((a) => a === "--telegram" || a === "--tg");
    const isTunnel = args.some((a) => a === "--tunnel" || a === "--quick-tunnel");
    const isHttps = args.some((a) => a === "--https" || a === "--http" || a === "--web");
    const portArgIdx = args.findIndex((a) => a === "--port" || a === "-p");
    let portOverride: number | undefined;
    if (portArgIdx !== -1 && args[portArgIdx + 1]) {
      const parsed = parseInt(args[portArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
    }

    const rawDirs = args.slice(1).filter((a, idx, arr) => {
      if (a.toLowerCase() === "start") return false;
      if (
        a === "--ws" ||
        a === "--websocket" ||
        a === "--telegram" ||
        a === "--tg" ||
        a === "--tunnel" ||
        a === "--quick-tunnel" ||
        a === "--https" ||
        a === "--http" ||
        a === "--web"
      )
        return false;
      if (a === "--port" || a === "-p") return false;
      if (idx > 0 && (arr[idx - 1] === "--port" || arr[idx - 1] === "-p")) return false;
      return true;
    });

    const targetDirs = rawDirs
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map((d) => path.resolve(d));

    const cfg = loadRemoteAgentConfig();
    const effectivePort = portOverride || (isHttps ? 7888 : (cfg.wsPort || 9225));
    if (portOverride) {
      cfg.wsPort = portOverride;
    }
    const transportType: RemoteAgentTransport = isHttps
      ? "https"
      : (isWs || isTunnel)
        ? "websocket"
        : isTg
          ? "telegram"
          : (cfg.transport || "telegram");
    const allWatched = targetDirs.length > 0 ? targetDirs : getWatchedWorkspaces(cfg);

    console.log(`[Muse Watch] Starting persistent watch mode (${transportType.toUpperCase()})...`);
    if (allWatched.length > 1) {
      console.log(`[Muse Watch] Watching ${allWatched.length} projects:`);
      allWatched.forEach((w, i) => console.log(`  ${i + 1}. ${path.basename(w)} (${w})`));
    } else {
      console.log(`[Muse Watch] Workspace: ${allWatched[0]}`);
    }
    if (isTunnel || isHttps) {
      console.log("[Muse Watch] Cloudflare quick ephemeral tunnel will be launched automatically.");
    }
    console.log("[Muse Watch] Superagent is now controlled by Muse / Remote clients. Press Ctrl+C to stop.\n");

    try {
      const watcher = await startMuseWatcher({
        workspace: allWatched[0],
        workspaces: allWatched,
        transportType,
        tunnel: isTunnel || isHttps,
        isHttps,
        wsPort: effectivePort,
        onLine: (line) => console.log(line.content),
        onProgress: (msg) => console.log(`[Muse Progress] ${msg}`),
      });

      const handleExit = async () => {
        console.log("\n[Muse Watch] Shutting down watcher...");
        await watcher.stop();
        process.exit(0);
      };

      process.on("SIGINT", handleExit);
      process.on("SIGTERM", handleExit);

      // Keep process alive while watcher is active
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (!watcher.isActive()) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      });
    } catch (err: any) {
      console.error(`[Muse Watch Error] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Treat rest as a task
  const taskPrompt = args.join(" ").trim();
  if (!taskPrompt) {
    console.log("Usage: superagent muse [status|tunnel|config|watch|<task prompt>]");
    return;
  }

  console.log(`[Muse CLI] Running remote task: "${taskPrompt}"`);
  const result = await runRemoteTask({
    task: taskPrompt,
    workspace: process.cwd(),
    onProgress: (msg) => console.log(`[Muse] ${msg}`),
    onChat: (msg) => console.log(`[Muse Note] ${msg}`),
  });

  if (result.success) {
    console.log("\n--- Task Summary ---");
    console.log(formatReadableSummary(result.summary));
  } else {
    console.error(`\nTask Failed: ${result.error || "Unknown error"}`);
    process.exit(1);
  }
}
