import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadModelConfig } from "../config/jsonConfig.js";
import type { HttpMcpServerConfig, McpServerConfig, StdioMcpServerConfig } from "../config/configTypes.js";
import type { Tool } from "../tools/types.js";
import { bumpToolRegistryVersion } from "../tools/toolRegistryVersion.js";
import { McpReconnectController } from "./mcpReconnectController.js";
import { mcpToolMetrics } from "./mcpToolMetrics.js";
import { killProcessTree } from "../tools/helpers.js";
import {
  getRemoteMcpOAuthCallbackPort,
  getRemoteMcpOAuthServerKey,
  openSystemBrowser,
  PersistentMcpOAuthProvider,
  startMcpOAuthCallbackReceiver,
  type McpOAuthCallbackReceiver,
} from "./remoteMcpOAuthProvider.js";

export const MCP_CONNECT_TIMEOUT_MS = 15000;
export const MCP_LIST_TOOLS_TIMEOUT_MS = 10000;
export const MCP_TOOL_CALL_TIMEOUT_MS = 60000;
export const MCP_CLEANUP_TIMEOUT_MS = 3000;

export function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, ms);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport;

export interface ConnectedMcpServer {

  name: string;
  client: Client;
  transport?: McpClientTransport;
  tools: string[];
  status: "connected" | "connecting" | "error" | "disconnected";
  error?: string;
  /** Cleanup for per-server resources such as the OAuth loopback callback listener. */
  cleanup?: () => Promise<void>;
}

export const connectedServers = new Map<string, ConnectedMcpServer>();
export function getMcpConnectionDiagnostics(name: string): {
  attempts: number; nextDelayMs: number | null; status: string; toolCount: number;
} {
  const serverName = name.trim().toLowerCase();
  const record = connectedServers.get(serverName);
  const retry = reconnectController.state(serverName);
  return { ...retry, status: record?.status || "unconfigured", toolCount: record?.tools.length || 0 };
}

let loadedMcpTools: Tool[] = [];
const registeredMcpToolNames = new Set<string>();
const remoteToolOwners = new WeakMap<Tool, ConnectedMcpServer>();
const reconnectController = new McpReconnectController();
const reconnectingServers = new Map<string, Promise<ConnectedMcpServer | undefined>>();
let shuttingDown = false;
let lifecycleEpoch = 0;
let registryQueue: Promise<unknown> = Promise.resolve();
function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  const pending = registryQueue.then(operation, operation);
  registryQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function isHttpMcpServerConfig(config: McpServerConfig): config is HttpMcpServerConfig {
  return config.transport === "http" || config.transport === "streamable-http";
}

function configuredServerEntries(input: unknown): Array<[string, McpServerConfig]> {
  if (Array.isArray(input)) {
    return input.flatMap((value, index) => {
      if (!value || typeof value !== "object") return [];
      const config = value as McpServerConfig;
      const name = (("name" in config && config.name) || ("id" in config && config.id) || "mcp-" + (index + 1)).trim();
      return [[name, config]];
    });
  }
  if (!input || typeof input !== "object") return [];
  return Object.entries(input as Record<string, McpServerConfig>);
}

function safeMcpError(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  return source
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(access_token|refresh_token|client_secret|code_verifier|authorization_code|bootstrap_code)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/([?&](?:state|code|access_token|refresh_token|client_secret|code_verifier)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 1200);
}

function isOAuthEnabled(config: HttpMcpServerConfig): boolean {
  if (config.oauth === true) return true;
  return typeof config.oauth === "object" && config.oauth !== null && config.oauth.enabled !== false;
}

function buildHttpHeaders(config: HttpMcpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [header, variableName] of Object.entries(config.headersFromEnv || {})) {
    const value = process.env[variableName];
    if (!value) {
      throw new Error("MCP HTTP header " + header + " requires environment variable " + variableName + ", but it is unset.");
    }
    headers[header] = value;
  }
  return headers;
}

function mapRemoteTools(serverName: string, client: Client, tools: Array<{name: string; description?: string; inputSchema?: unknown}>): Tool[] {
  return tools.map((tool) => {
    const mapped: Tool = {
    name: serverName + "_" + tool.name,
    description: tool.description || "MCP Tool from server " + serverName + ": " + tool.name,
    parameters: (tool.inputSchema || {}) as Record<string, unknown>,
    execute: async (args: Record<string, unknown>) => {
      const startedAt = Date.now();
      if (!loadedMcpTools.includes(mapped) || connectedServers.get(serverName)?.status !== "connected") {
        mcpToolMetrics.record(mapped.name, Date.now() - startedAt, true);
        return "Error: MCP tool is no longer available. Rediscover tools.";
      }
      try {
        const response = await withTimeout(
          client.callTool({
            name: tool.name,
            arguments: args,
          }),
          MCP_TOOL_CALL_TIMEOUT_MS,
          `MCP tool "${tool.name}" on server "${serverName}" timed out after ${MCP_TOOL_CALL_TIMEOUT_MS / 1000}s`
        );
        mcpToolMetrics.record(mapped.name, Date.now() - startedAt, Boolean(response.isError));
        const rendered = Array.isArray(response.content)
          ? response.content.map((item: any) => {
              if (item.type === "text") return item.text;
              if (item.type === "image") return "[Image Content (" + (item.mimeType || "image/png") + "); binary data unavailable in text-only tool adapter]";
              return JSON.stringify(item);
            }).join("\n")
          : "";
        // Preserve structured results alongside text.
        const structured = response.structuredContent === undefined
          ? "" : JSON.stringify(response.structuredContent);
        const result = [rendered, structured].filter(Boolean).join("\n");
        return response.isError ? "MCP tool error: " + result : result || JSON.stringify(response);
      } catch (err: any) {
        mcpToolMetrics.record(mapped.name, Date.now() - startedAt, true);
        return `Error executing MCP tool "${tool.name}": ${safeMcpError(err)}`;
      }
    },
    };
    return mapped;
  });
}

async function listAllRemoteTools(client: Client): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await withTimeout(client.listTools(cursor ? { cursor } : undefined),
      MCP_LIST_TOOLS_TIMEOUT_MS, "MCP listTools timed out");
    for (const tool of result.tools || []) {
      if (names.has(tool.name)) continue;
      names.add(tool.name);
      tools.push(tool);
    }
    if (!result.nextCursor) return tools;
    if (cursors.has(result.nextCursor)) throw new Error("MCP tools/list cursor cycle");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("MCP tools/list exceeded 50 pages");
}

async function registerLoadedMcpToolsUnlocked(): Promise<void> {
  const pending = loadedMcpTools.filter((tool) => !registeredMcpToolNames.has(tool.name));
  if (pending.length === 0) return;

  const {
    allTools,
    superagentToolset,
    chromeExtensionToolset,
  } = await import("../tools/index.js");

  let added = false;
  for (const tool of pending) {
    // Do not duplicate a name if an earlier partially-completed init registered it.
    const name = tool.name;
    const addIfMissing = (list: any[]) => {
      if (!list.some((existing) => (typeof existing === "string" ? existing : existing?.name) === name)) {
        list.push(tool);
      }
    };
    // Never shadow a built-in tool or another server's registered tool.
    if (allTools.some((existing) => existing.name === name && existing !== tool)) {
      registeredMcpToolNames.add(name);
      continue;
    }
    addIfMissing(allTools);
    addIfMissing(superagentToolset);
    addIfMissing(chromeExtensionToolset);
    registeredMcpToolNames.add(name);
    added = true;
  }
  if (added) bumpToolRegistryVersion();
}

async function registerLoadedMcpTools(): Promise<void> {
  return withRegistryLock(registerLoadedMcpToolsUnlocked);
}

/** Retire only tools owned by this transport, never an unrelated or built-in tool. */
async function retireRemoteToolsUnlocked(record: ConnectedMcpServer): Promise<void> {
  const stale = new Set(loadedMcpTools.filter((tool) => remoteToolOwners.get(tool) === record));
  if (!stale.size) { record.tools = []; return; }
  const { allTools, superagentToolset, chromeExtensionToolset } = await import("../tools/index.js");
  let removed = false;
  for (const list of [allTools, superagentToolset, chromeExtensionToolset]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (stale.has(list[i])) { list.splice(i, 1); removed = true; }
    }
  }
  loadedMcpTools = loadedMcpTools.filter((tool) => !stale.has(tool));
  for (const tool of stale) registeredMcpToolNames.delete(tool.name);
  record.tools = [];
  if (removed) bumpToolRegistryVersion();
}

function retireRemoteTools(record: ConnectedMcpServer): Promise<void> {
  return withRegistryLock(() => retireRemoteToolsUnlocked(record));
}

function rememberDiscoveredTools(record: ConnectedMcpServer, tools: Array<{name: string; description?: string; inputSchema?: unknown}>): void {
  const mappedTools = mapRemoteTools(record.name, record.client, tools);
  const currentNames = new Set(record.tools);
  for (const tool of mappedTools) {
    if (!currentNames.has(tool.name)) {
      record.tools.push(tool.name);
      currentNames.add(tool.name);
      remoteToolOwners.set(tool, record);
      loadedMcpTools.push(tool);
    }
  }
}

/** Hot-refresh one server under the shared registry lock (without restarting others). */
export async function refreshMcpServerTools(name: string): Promise<boolean> {
  const record = connectedServers.get(name.toLowerCase());
  if (!record || record.status !== "connected") return false;
  const definitions = await listAllRemoteTools(record.client);
  return withRegistryLock(async () => {
    if (shuttingDown || connectedServers.get(record.name) !== record || record.status !== "connected") return false;
    const next = mapRemoteTools(record.name, record.client, definitions);
    const previous = loadedMcpTools.filter((tool) => remoteToolOwners.get(tool) === record);
    const signature = (tools: Tool[]) => JSON.stringify(tools.map(
      ({ name, description, parameters }) => [name, description, parameters]));
    if (signature(previous) === signature(next)) return false;
    await retireRemoteToolsUnlocked(record);
    rememberDiscoveredTools(record, definitions);
    await registerLoadedMcpToolsUnlocked();
    return true;
  });
}

function installMcpToolChangeHandler(record: ConnectedMcpServer): void {
  let queue = Promise.resolve();
  record.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    queue = queue.then(async () => {
      if (connectedServers.get(record.name) === record && record.status === "connected") {
        await refreshMcpServerTools(record.name);
      }
    }).catch((error) => {
      record.error = "MCP tool refresh failed: " + safeMcpError(error);
    });
    return queue;
  });
}

/** Drop disconnected tools immediately from subsequent model iterations. */
function markMcpDisconnected(record: ConnectedMcpServer, reason: string): void {
  if (shuttingDown || connectedServers.get(record.name) !== record) return;
  record.status = "disconnected";
  record.error = reason;
  void retireRemoteTools(record).then(() => {
    if (connectedServers.get(record.name) === record) scheduleMcpReconnect(record.name);
  }).catch(() => undefined);
}

function scheduleMcpReconnect(name: string): void {
  if (shuttingDown) return;
  const config = configuredServerEntries(loadModelConfig().mcpServers)
    .find(([candidate]) => candidate.toLowerCase() === name)?.[1];
  // OAuth requires explicit opt-in: never repeatedly open login browsers in the background.
  if (!config || config.disabled || config.autoReconnect === false ||
      (isHttpMcpServerConfig(config) && isOAuthEnabled(config) && config.autoReconnect !== true)) return;
  reconnectController.schedule(name, async () => {
    if (shuttingDown) return true;
    if (connectedServers.get(name)?.status === "connected") return true;
    const next = await reconnectMcpServer(name);
    return next?.status === "connected";
  });
}

/** Reconnect only the named MCP client; avoid a global restart or competing attempts. */
export async function reconnectMcpServer(rawName: string): Promise<ConnectedMcpServer | undefined> {
  const name = rawName.trim().toLowerCase();
  const inflight = reconnectingServers.get(name);
  if (inflight) return inflight;
  const operation = (async () => {
    const epoch = lifecycleEpoch;
    if (shuttingDown) return undefined;
    const config = configuredServerEntries(loadModelConfig().mcpServers)
      .find(([candidate]) => candidate.toLowerCase() === name)?.[1];
    if (!config || config.disabled) return undefined;
    const previous = connectedServers.get(name);
    if (previous) {
      connectedServers.delete(name);
      await retireRemoteTools(previous);
      try { await previous.cleanup?.(); } catch {}
      try { await previous.transport?.close(); } catch {}
    }
    if (shuttingDown || lifecycleEpoch !== epoch) return undefined;
    const client = new Client({ name: "superagent-client", version: "1.0.0" }, { capabilities: {} });
    if (isHttpMcpServerConfig(config)) await connectHttpServer(name, config, client);
    else await connectStdioServer(name, config as StdioMcpServerConfig, client);
    if (shuttingDown || lifecycleEpoch !== epoch) {
      const stale = connectedServers.get(name);
      if (stale?.client === client) {
        connectedServers.delete(name);
        await retireRemoteTools(stale);
        try { await stale.transport?.close(); } catch {}
      }
      return undefined;
    }
    await registerLoadedMcpTools();
    const next = connectedServers.get(name);
    if (next?.status === "connected") reconnectController.reset(name);
    return next;
  })();
  reconnectingServers.set(name, operation);
  try { return await operation; }
  finally { if (reconnectingServers.get(name) === operation) reconnectingServers.delete(name); }
}

/**
 * Initializes configured MCP servers. Existing stdio configurations stay valid;
 * HTTP servers use Streamable HTTP and optionally the SDK's OAuth 2.1 flow.
 */
export async function initMcpServers(): Promise<void> {
  await closeMcpServers();
  shuttingDown = false;

  const config = loadModelConfig();
  const serverEntries = configuredServerEntries(config.mcpServers);
  if (serverEntries.length === 0) return;

  const initPromises = serverEntries.map(async ([rawName, srvConfig]) => {
    const serverName = rawName.trim().toLowerCase();
    if (!serverName || srvConfig.disabled) return;

    const client = new Client(
      { name: "superagent-client", version: "1.0.0" },
      { capabilities: {} },
    );

    if (isHttpMcpServerConfig(srvConfig)) {
      await connectHttpServer(serverName, srvConfig, client);
      return;
    }
    await connectStdioServer(serverName, srvConfig as StdioMcpServerConfig, client);
  });

  await Promise.all(initPromises);
  await registerLoadedMcpTools();
}

async function connectStdioServer(
  serverName: string,
  srvConfig: StdioMcpServerConfig,
  client: Client,
): Promise<void> {
  if (!srvConfig.command) {
    const record: ConnectedMcpServer = {
      name: serverName,
      client,
      tools: [],
      status: "error",
      error: "Invalid stdio MCP configuration: command is required.",
    };
    connectedServers.set(serverName, record);
    return;
  }

  const mergedEnv = {
    ...process.env,
    ...(srvConfig.env || {}),
  } as Record<string, string>;

  const transport = new StdioClientTransport({
    command: srvConfig.command,
    args: srvConfig.args || [],
    env: mergedEnv,
    stderr: "pipe",
  });

  const connectionRecord: ConnectedMcpServer = {
    name: serverName,
    client,
    transport,
    tools: [],
    status: "connecting",
  };
  connectedServers.set(serverName, connectionRecord);

  transport.onclose = () => {
    markMcpDisconnected(connectionRecord, "MCP server process exited.");
  };
  transport.onerror = (error: Error) => {
    markMcpDisconnected(connectionRecord, safeMcpError(error));
  };

  let stderrBuffer = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
  });

  try {
    installMcpToolChangeHandler(connectionRecord);
    await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, `MCP stdio connection timed out for server "${serverName}"`);
    const toolsResult = { tools: await listAllRemoteTools(client) };
    rememberDiscoveredTools(connectionRecord, toolsResult.tools || []);
    connectionRecord.status = "connected";
    connectionRecord.error = undefined;
  } catch (error) {
    connectionRecord.status = "error";
    connectionRecord.error = safeMcpError(error);
    if (stderrBuffer.trim()) {
      connectionRecord.error += "\nServer stderr: " + safeMcpError(stderrBuffer.trim());
    }
    try {
      if ((transport as any).pid) {
        killProcessTree((transport as any).pid);
      }
      await withTimeout(Promise.resolve(transport.close()), MCP_CLEANUP_TIMEOUT_MS, "close timeout").catch(() => {});
    } catch {}
    process.stderr.write("[MCP] Failed to connect to server \"" + serverName + "\": " + connectionRecord.error + "\n");
  }
}

async function connectHttpServer(
  serverName: string,
  srvConfig: HttpMcpServerConfig,
  client: Client,
): Promise<void> {
  let endpoint: URL;
  try {
    endpoint = new URL(srvConfig.url);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new Error("MCP HTTP URL must use http or https.");
    }
  } catch (error) {
    connectedServers.set(serverName, {
      name: serverName,
      client,
      tools: [],
      status: "error",
      error: safeMcpError(error),
    });
    return;
  }

  let headers: Record<string, string>;
  try {
    headers = buildHttpHeaders(srvConfig);
  } catch (error) {
    connectedServers.set(serverName, {
      name: serverName,
      client,
      tools: [],
      status: "error",
      error: safeMcpError(error),
    });
    return;
  }

  const oauthEnabled = isOAuthEnabled(srvConfig);
  // OAuth's transport manages its own Authorization header. Accepting a
  // competing configured bearer header can silently override the access token
  // and make a valid OAuth connection look permanently unauthorized.
  if (oauthEnabled && Object.keys(headers).some((header) => header.toLowerCase() === "authorization")) {
    connectedServers.set(serverName, {
      name: serverName,
      client,
      tools: [],
      status: "error",
      error: "OAuth is enabled for this remote MCP server; remove the Authorization entry from headersFromEnv so the OAuth client can manage its token.",
    });
    return;
  }
  const serverKey = getRemoteMcpOAuthServerKey(serverName, endpoint.toString());
  const callbackPort = oauthEnabled ? getRemoteMcpOAuthCallbackPort(serverKey) : undefined;
  const callbackUrl = callbackPort ? "http://127.0.0.1:" + callbackPort + "/oauth/callback" : undefined;

  let provider: PersistentMcpOAuthProvider | undefined;
  let callbackReceiver: McpOAuthCallbackReceiver | undefined;
  let transport: StreamableHTTPClientTransport;

  if (oauthEnabled && callbackUrl && callbackPort) {
    provider = new PersistentMcpOAuthProvider(
      serverKey,
      callbackUrl,
      (typeof srvConfig.oauth === "object" && srvConfig.oauth?.clientName) || ("SuperAgent: " + serverName),
      async (authorizationUrl) => {
        if (callbackReceiver) {
          await callbackReceiver.close().catch(() => undefined);
          callbackReceiver = undefined;
        }
        callbackReceiver = await startMcpOAuthCallbackReceiver({
          port: callbackPort,
          getExpectedState: () => provider?.currentState,
        });
        await openSystemBrowser(authorizationUrl);
      },
    );
    transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: provider,
      requestInit: { headers },
    });
  } else {
    transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers },
    });
  }

  const connectionRecord: ConnectedMcpServer = {
    name: serverName,
    client,
    transport,
    tools: [],
    status: "connecting",
  };
  connectedServers.set(serverName, connectionRecord);
  transport.onclose = () => {
    markMcpDisconnected(connectionRecord, "Remote MCP connection closed.");
  };
  transport.onerror = (error: Error) => {
    connectionRecord.error = safeMcpError(error);
  };
  connectionRecord.cleanup = async () => {
    if (callbackReceiver) {
      const receiver = callbackReceiver;
      callbackReceiver = undefined;
      await receiver.close().catch(() => undefined);
    }
  };

  try {
    installMcpToolChangeHandler(connectionRecord);
    await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, `MCP HTTP connection timed out for server "${serverName}"`);
    const toolsResult = { tools: await listAllRemoteTools(client) };
    rememberDiscoveredTools(connectionRecord, toolsResult.tools || []);
    connectionRecord.status = "connected";
    connectionRecord.error = undefined;
    if (callbackReceiver && !provider?.hasPendingAuthorization) {
      await callbackReceiver.close().catch(() => undefined);
      callbackReceiver = undefined;
    }
  } catch (error) {
    if (provider?.hasPendingAuthorization && callbackReceiver && (
      error instanceof UnauthorizedError ||
      (error instanceof Error && /unauthori[sz]ed/i.test(error.message))
    )) {
      connectionRecord.status = "connecting";
      connectionRecord.error = "OAuth authorization opened in the browser; waiting for the local callback.";
      // OAuth continues outside initMcpServers so unrelated configured MCP servers can initialize.
      void finishRemoteOAuthAuthorization(serverName, transport, endpoint, headers, provider, connectionRecord, () => callbackReceiver, async () => {
        if (callbackReceiver) {
          const receiver = callbackReceiver;
          callbackReceiver = undefined;
          await receiver.close().catch(() => undefined);
        }
      });
      return;
    }
    connectionRecord.status = "error";
    connectionRecord.error = provider?.hasPendingAuthorization
      ? "OAuth authorization could not be started. Check that the default browser can open and the local callback port is available."
      : safeMcpError(error);
    await connectionRecord.cleanup?.();
    process.stderr.write("[MCP] Failed to connect to remote server \"" + serverName + "\": " + connectionRecord.error + "\n");
  }
}

async function finishRemoteOAuthAuthorization(
  serverName: string,
  transport: StreamableHTTPClientTransport,
  endpoint: URL,
  headers: Record<string, string>,
  provider: PersistentMcpOAuthProvider,
  record: ConnectedMcpServer,
  getReceiver: () => McpOAuthCallbackReceiver | undefined,
  closeReceiver: () => Promise<void>,
): Promise<void> {
  const initialClient = record.client;
  try {
    const receiver = getReceiver();
    if (!receiver) throw new Error("OAuth callback listener was not started.");
    const authorizationCode = await withTimeout(
      receiver.waitForAuthorizationCode(),
      300000,
      "OAuth authorization timed out after 5 minutes"
    );
    await transport.finishAuth(authorizationCode);
    // The MCP SDK transport's start() is single-use. The initial connect has
    // already started it before receiving 401, so create a fresh client/transport
    // with the newly persisted token rather than calling connect() twice.
    await initialClient.close().catch(() => undefined);
    const authorizedClient = new Client(
      { name: "superagent-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const authorizedTransport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: provider,
      requestInit: { headers },
    });
    record.client = authorizedClient;
    record.transport = authorizedTransport;
    installMcpToolChangeHandler(record);
    await withTimeout(authorizedClient.connect(authorizedTransport), MCP_CONNECT_TIMEOUT_MS, "Connect timed out");
    const result = { tools: await listAllRemoteTools(authorizedClient) };
    rememberDiscoveredTools(record, result.tools || []);
    record.status = "connected";
    record.error = undefined;
    await registerLoadedMcpTools();
  } catch (error) {
    if (connectedServers.get(serverName) === record) {
      record.status = "error";
      record.error = safeMcpError(error);
      process.stderr.write("[MCP] Remote OAuth authorization failed for \"" + serverName + "\": " + record.error + "\n");
    }
  } finally {
    await closeReceiver();
    if (record.cleanup) {
      record.cleanup = async () => undefined;
    }
  }
}



/**
 * Gracefully disconnects configured MCP servers and removes their tools from
 * every toolset. Credentials remain encrypted for future runs.
 */
export async function closeMcpServers(): Promise<void> {
  shuttingDown = true;
  lifecycleEpoch += 1;
  reconnectController.cancelAll();
  const records = Array.from(connectedServers.values());
  connectedServers.clear();
  for (const srv of records) {
    try {
      if (srv.cleanup) {
        await withTimeout(srv.cleanup(), MCP_CLEANUP_TIMEOUT_MS, "cleanup timeout");
      }
    } catch {
      // Best-effort cleanup should not block other MCP disconnects.
    }
    try {
      if (srv.transport instanceof StreamableHTTPClientTransport) {
        await withTimeout(srv.transport.terminateSession(), MCP_CLEANUP_TIMEOUT_MS, "terminateSession timeout").catch(() => undefined);
      }
      if (srv.transport && "pid" in srv.transport && (srv.transport as any).pid) {
        killProcessTree((srv.transport as any).pid);
      }
      if (srv.transport?.close) {
        await withTimeout(srv.transport.close(), MCP_CLEANUP_TIMEOUT_MS, "close timeout").catch(() => undefined);
      }
    } catch {
      // Ignore disconnect errors.
    }
  }
  await withRegistryLock(async () => {
    if (loadedMcpTools.length === 0) return;
    const { allTools, masterToolset, superagentToolset, chromeExtensionToolset,
      defaultSubagentToolset, subagentToolsets } = await import("../tools/index.js");
    const stale = new Set(loadedMcpTools);
    const filterArray = (list: Tool[]) => {
      for (let i = list.length - 1; i >= 0; i--) {
        // Never remove built-in tools with coincidentally matching remote names.
        if (stale.has(list[i])) list.splice(i, 1);
      }
    };
    for (const list of [allTools, masterToolset, superagentToolset,
      chromeExtensionToolset, defaultSubagentToolset, ...Object.values(subagentToolsets)]) {
      if (Array.isArray(list)) filterArray(list);
    }
    loadedMcpTools = [];
    registeredMcpToolNames.clear();
    bumpToolRegistryVersion();
  });
}
