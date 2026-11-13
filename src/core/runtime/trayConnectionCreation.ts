/**
 * SuperAgent Tray's explicit connection creation allowlist.
 *
 * Calling this file never evaluates a command line from the WebView.
 * Every start path delegates to an existing SuperAgent owner/lifecycle API.
 * All public results are credential-free and success means the reported
 * operation actually completed (a stored MCP client is only "configured").
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export type NewTrayConnection =
  | { kind: "mcp-client"; name: string; url: string; oauth: boolean }
  | { kind: "mcp-tunnel"; port: number; provider: "cloudflare" | "openai"; tunnelId?: string }
  | { kind: "core-tunnel"; port: number }
  | { kind: "muse-tunnel"; port: number };

function validPort(value: unknown, restricted: readonly number[] = []): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 1024 || value > 65535 || restricted.includes(value)) {
    throw new Error("Port must be an integer from 1024 to 65535 and must not be reserved");
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Connection request must be an object");
  }
  return value as Record<string, unknown>;
}
function exactKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(obj).some(key => !allowed.includes(key))) {
    throw new Error("Unexpected connection setting; arbitrary commands and options are not accepted");
  }
}
export function parseNewTrayConnection(raw: unknown, localCorePort: number): NewTrayConnection {
  const obj = record(raw);
  const kind = obj.kind;
  if (kind === "mcp-client") {
    exactKeys(obj, ["kind", "name", "url", "oauth"]);
    const name = String(obj.name ?? "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name)) {
      throw new Error("MCP name must be 1–48 letters, digits, hyphens or underscores");
    }
    if (typeof obj.url !== "string" || obj.url.length > 2048) {
      throw new Error("MCP URL is missing or too long");
    }
    let url: URL;
    try { url = new URL(obj.url); } catch { throw new Error("MCP URL must be absolute"); }
    const localHost = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && localHost))
      || url.username || url.password || url.hash || !url.hostname
      || url.search || url.pathname.includes("..")) {
      throw new Error("MCP requires HTTPS (HTTP only on loopback), without embedded credentials or query secrets");
    }
    if (typeof obj.oauth !== "boolean") throw new Error("Select OAuth explicitly");
    return { kind, name, url: url.toString(), oauth: obj.oauth };
  }
  if (kind === "mcp-tunnel") {
    exactKeys(obj, ["kind", "port", "provider", "tunnelId"]);
    const port = validPort(obj.port, [7888, 7891, 7892, localCorePort]);
    if (obj.provider !== "cloudflare" && obj.provider !== "openai") {
      throw new Error("Select Cloudflare or OpenAI Secure MCP Tunnel");
    }
    if (obj.provider === "openai") {
      if (typeof obj.tunnelId !== "string" || !/^tunnel_[a-zA-Z0-9_-]{8,100}$/.test(obj.tunnelId)) {
        throw new Error("OpenAI Secure MCP Tunnel requires a valid tunnel_... ID");
      }
      return {kind, port, provider: "openai", tunnelId: obj.tunnelId};
    }
    if (obj.tunnelId !== undefined && obj.tunnelId !== "") {
      throw new Error("Cloudflare MCP tunnel does not accept an OpenAI tunnel ID");
    }
    return {kind, port, provider: "cloudflare"};
  }
  if (kind === "core-tunnel") {
    exactKeys(obj, ["kind", "port"]);
    const port = validPort(obj.port);
    if (port !== localCorePort) {
      throw new Error("HTTPS tunnel can expose only this authenticated selected Core port");
    }
    return {kind, port};
  }
  if (kind === "muse-tunnel") {
    exactKeys(obj, ["kind", "port"]);
    const port = validPort(obj.port, [7888, 7891, 7892, 9227]);
    if (port === localCorePort) throw new Error("Muse port cannot be the selected Core API port");
    return {kind, port};
  }
  throw new Error("Unknown connection type");
}

export interface TrayCreationAdapter {
  registerMcpClient(request: Extract<NewTrayConnection,{kind:"mcp-client"}>): Promise<void>;
  createMcpTunnel(request: Extract<NewTrayConnection,{kind:"mcp-tunnel"}>): Promise<{
    pid: number;
    endpoint: string;
    provider: string;
    setupCopied?: boolean;
    bootstrapCode?: string;
    setupSnippet?: string;
  }>;
  createCoreTunnel(request: Extract<NewTrayConnection,{kind:"core-tunnel"}>): Promise<{
    pid: number;
    endpoint: string;
    setupCopied?: boolean;
    token?: string;
    setupSnippet?: string;
  }>;
  createMuseTunnel(request: Extract<NewTrayConnection,{kind:"muse-tunnel"}>): Promise<{
    pid: number;
    endpoint: string;
    setupCopied?: boolean;
    token?: string;
    setupSnippet?: string;
  }>;
}

const liveAdapter: TrayCreationAdapter = {
  async registerMcpClient({name,url,oauth}) {
    const { mutateModelConfig } = await import("../config/jsonConfig.js");
    mutateModelConfig(config => {
      if (!config.mcpServers) config.mcpServers = {};
      if (Object.keys(config.mcpServers).some(existing => existing.toLowerCase() === name.toLowerCase())) {
        throw new Error("MCP connection name is already configured; existing connection was not overwritten");
      }
      config.mcpServers[name] = {transport:"http",url,oauth};
    });
  },
  async createMcpTunnel(request) {
    const {startManagedMcpTunnelOwner,copyManagedMcpExtensionSetupToClipboard,buildManagedMcpExtensionSetup} =
      await import("./mcpManagedTunnelOwner.js");
    // Explicit safe tool exposure only. Existing owner checks duplicate ports.
    const args = ["--mcp-port", String(request.port), "--provider", request.provider,
      "--mcp-auth", "oauth"];
    if (request.provider === "openai") args.push("--tunnel-id", request.tunnelId!);
    const entry = process.argv[1];
    if (!entry) throw new Error("No SuperAgent CLI entry for managed MCP owner startup");
    const result = await startManagedMcpTunnelOwner(args,entry,process.cwd());
    // The one-time OAuth bootstrap code is copied directly by Core to the
    // user's OS clipboard and also returned for display in the authenticated tray.
    const setupCopied = await copyManagedMcpExtensionSetupToClipboard(result);
    const setupSnippet = buildManagedMcpExtensionSetup(result.info) ?? undefined;
    return {
      pid: result.pid,
      endpoint: result.info.publicUrl,
      provider: result.info.tunnelProvider,
      setupCopied,
      bootstrapCode: result.info.bootstrapCode,
      setupSnippet,
    };
  },
  async createCoreTunnel({port}) {
    const {getTunnelStatus,startQuickTunnel,claimTunnelServiceKind,stopQuickTunnel,buildHttpsConnectionPrompt,copyTextToClipboard} =
      await import("../remoteAgent/cloudflareTunnel.js");
    let endpoint = "";
    let pid = 0;
    const existing = getTunnelStatus(port);
    if (existing.isRunning && existing.serviceKind === "superagent-http" && existing.publicUrl && existing.pid) {
      endpoint = existing.publicUrl;
      pid = existing.pid;
    } else {
      if (existing.isRunning) {
        throw new Error("Tunnel already exists on this Core port; nothing was replaced");
      }
      const created = await startQuickTunnel({
        port,host:"127.0.0.1",path:"",serviceKind:"superagent-http",
      });
      const claimed = claimTunnelServiceKind(port,"superagent-http");
      if (!claimed || claimed.pid !== created.pid || !claimed.publicUrl) {
        await stopQuickTunnel(port,"superagent-http").catch(()=>{});
        throw new Error("New Core HTTP tunnel failed ownership verification");
      }
      endpoint = claimed.publicUrl;
      pid = created.pid;
    }
    const { getServerAuthToken } = await import("../utils/serverSecurity.js");
    const token = getServerAuthToken(port);
    const setupSnippet = buildHttpsConnectionPrompt({
      publicUrl: endpoint,
      localUrl: `http://127.0.0.1:${port}`,
      port,
      token,
    });
    const setupCopied = await copyTextToClipboard(setupSnippet);
    return {
      pid,
      endpoint,
      setupCopied,
      token,
      setupSnippet,
    };
  },
  async createMuseTunnel({port}) {
    const {getTunnelStatus} = await import("../remoteAgent/cloudflareTunnel.js");
    const {getMuseWatcherStrict,getMuseWatcher,startMuseWatcher} =
      await import("../remoteAgent/museWatcherRegistry.js");
    const {getActiveRemoteTaskId} = await import("../remoteAgent/taskRunner.js");
    const {loadRemoteAgentConfig, getWatchedWorkspaces,generateSecureWsToken} =
      await import("../remoteAgent/config.js");
    if (getActiveRemoteTaskId()) {
      throw new Error("Remote task is active. Starting Muse Watch could interrupt it; no tunnel created");
    }
    if (getTunnelStatus(port).isRunning || getMuseWatcherStrict(port)?.isActive()) {
      throw new Error("Muse/WebSocket service or tunnel already exists on this port");
    }
    if (getMuseWatcher()?.isActive()) {
      throw new Error("Another Core-owned Muse Watch is active; refusing global watcher takeover");
    }
    const root = getRootConfigDir();
    const configFile = path.join(root, `tray-muse-${port}.json`);
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const base = loadRemoteAgentConfig();
    const configured = getWatchedWorkspaces(base);
    if (!configured.length || configured.some(p => !path.isAbsolute(p) ||
        !fs.existsSync(p) || !fs.statSync(p).isDirectory())) {
      throw new Error("Configure a valid Muse watched workspace before creating a tunnel");
    }
    // Port-specific credentials: never mutate Telegram or another Muse
    // transport's global configuration while creating a new connection.
    if (fs.existsSync(configFile)) {
      const stat = fs.lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
        throw new Error("Unsafe existing Muse owner configuration; refusing overwrite");
      }
      const found = JSON.parse(fs.readFileSync(configFile,"utf8"));
      if (found.wsPort !== port || found.wsHost !== "127.0.0.1" ||
        found.wsMode !== "server" || found.transport !== "websocket" ||
        typeof found.wsToken !== "string" || found.wsToken.length < 32) {
        throw new Error("Muse owner configuration is incompatible; refusing credential rotation");
      }
    } else {
      const safeConfig = {
        transport:"websocket",wsMode:"server",wsHost:"127.0.0.1",
        wsPort:port,wsPath:"/muse",wsToken:generateSecureWsToken(),
        workspaces:configured,defaultWorkspace:configured[0],asRunner:false,
      };
      fs.writeFileSync(configFile,JSON.stringify(safeConfig),{flag:"wx",mode:0o600});
    }
    const watcher = await startMuseWatcher({
      workspace:configured[0],workspaces:configured,wsPort:port,
      transportType:"websocket",customConfigPath:configFile,tunnel:true,
      autoApproveWorkspace:false,announce:false,skipRemoteTaskAbort:true,
    });
    const tunnel = getTunnelStatus(port);
    if (!watcher.isActive() || !tunnel.isRunning ||
        tunnel.serviceKind !== "muse-websocket" || !tunnel.wssUrl) {
      throw new Error("Muse Watch started but its new Cloudflare WSS tunnel is not verified; inspect owner before retrying");
    }
    const {buildMuseConnectionPrompt,copyTextToClipboard} =
      await import("../remoteAgent/cloudflareTunnel.js");
    const token = JSON.parse(fs.readFileSync(configFile,"utf8")).wsToken as string;
    const prompt = buildMuseConnectionPrompt({
      wssUrl:tunnel.wssUrl, token, publicUrl:tunnel.publicUrl,
      workspaces:configured,
    });
    const setupCopied = await copyTextToClipboard(prompt);
    return {
      pid: tunnel.pid!,
      endpoint: tunnel.wssUrl,
      setupCopied,
      token,
      setupSnippet: prompt,
    };
  },
};

let creating = false;
/** Serialized to avoid two UI requests creating duplicate service owners. */
export async function createTrayConnection(
  request: NewTrayConnection, adapter: TrayCreationAdapter = liveAdapter
): Promise<Record<string,unknown>> {
  if (creating) throw new Error("A connection startup is already in progress; retry after refreshing");
  creating = true;
  try {
    if (request.kind === "mcp-client") {
      await adapter.registerMcpClient(request);
      return {success:true,kind:request.kind,state:"configured",name:request.name,
        message:"MCP client saved. Reload/reconnect MCP servers in your active session to establish the connection."};
    }
    if (request.kind === "mcp-tunnel") {
      const data = await adapter.createMcpTunnel(request);
      return {
        success: true,
        kind: request.kind,
        state: "running",
        port: request.port,
        pid: data.pid,
        endpoint: data.endpoint,
        provider: data.provider,
        bootstrapCode: data.bootstrapCode,
        setupSnippet: data.setupSnippet,
        setupCopied: data.setupCopied === true,
        message: data.setupCopied
          ? "MCP tunnel started; private setup and one-time OAuth approval code copied to the local OS clipboard. Keep it private."
          : "MCP tunnel started. For the one-time OAuth approval code run: superagent mcp tunnel token regenerate --port " + request.port,
      };
    }
    if (request.kind === "core-tunnel") {
      const data=await adapter.createCoreTunnel(request);
      return {
        success: true,
        kind: request.kind,
        state: "running",
        port: request.port,
        pid: data.pid,
        endpoint: data.endpoint,
        token: (data as any).token,
        setupSnippet: data.setupSnippet,
        setupCopied: data.setupCopied === true,
        message: data.setupCopied
          ? "Cloudflare HTTPS tunnel started for this Core. API Bearer token and setup snippet copied to OS clipboard."
          : "Cloudflare HTTPS tunnel started for this Core. API Bearer authentication remains required.",
      };
    }
    const data=await adapter.createMuseTunnel(request);
    return {
      success: true,
      kind: request.kind,
      state: "running",
      port: request.port,
      pid: data.pid,
      endpoint: data.endpoint,
      token: data.token,
      setupSnippet: data.setupSnippet,
      setupCopied: data.setupCopied === true,
      message: data.setupCopied
        ? "Muse WSS tunnel started; its private connection prompt was copied to the local OS clipboard. Treat the bearer token as a password."
        : "Muse WSS tunnel started, but clipboard setup failed. Read the protected local tray-muse-" + request.port + ".json owner configuration to get the private token.",
    };
  } finally {
    creating=false;
  }
}
