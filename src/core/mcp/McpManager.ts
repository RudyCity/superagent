import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadModelConfig } from "../config/jsonConfig.js";
import type { HttpMcpServerConfig, McpServerConfig, StdioMcpServerConfig } from "../config/configTypes.js";
import type { Tool } from "../tools/types.js";
import {
  getRemoteMcpOAuthCallbackPort,
  getRemoteMcpOAuthServerKey,
  openSystemBrowser,
  PersistentMcpOAuthProvider,
  startMcpOAuthCallbackReceiver,
  type McpOAuthCallbackReceiver,
} from "./remoteMcpOAuthProvider.js";

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
let loadedMcpTools: Tool[] = [];
const registeredMcpToolNames = new Set<string>();

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
  return tools.map((tool) => ({
    name: serverName + "_" + tool.name,
    description: tool.description || "MCP Tool from server " + serverName + ": " + tool.name,
    parameters: (tool.inputSchema || {}) as Record<string, unknown>,
    execute: async (args: Record<string, unknown>) => {
      const response = await client.callTool({
        name: tool.name,
        arguments: args,
      });
      if (response && Array.isArray(response.content)) {
        return response.content.map((item: any) => {
          if (item.type === "text") return item.text;
          if (item.type === "image") return "[Image Content (" + (item.mimeType || "image/png") + ")]";
          return JSON.stringify(item);
        }).join("\n");
      }
      return JSON.stringify(response);
    },
  }));
}

async function registerLoadedMcpTools(): Promise<void> {
  const pending = loadedMcpTools.filter((tool) => !registeredMcpToolNames.has(tool.name));
  if (pending.length === 0) return;

  const {
    allTools,
    masterToolset,
    superagentToolset,
    defaultSubagentToolset,
    subagentToolsets,
  } = await import("../tools/index.js");

  for (const tool of pending) {
    // Do not duplicate a name if an earlier partially-completed init registered it.
    const name = tool.name;
    const addIfMissing = (list: any[]) => {
      if (!list.some((existing) => (typeof existing === "string" ? existing : existing?.name) === name)) {
        list.push(tool);
      }
    };
    addIfMissing(allTools);
    addIfMissing(masterToolset);
    addIfMissing(superagentToolset);
    addIfMissing(defaultSubagentToolset);
    for (const key of Object.keys(subagentToolsets)) {
      if (Array.isArray(subagentToolsets[key])) addIfMissing(subagentToolsets[key]);
    }
    registeredMcpToolNames.add(name);
  }
}

function rememberDiscoveredTools(record: ConnectedMcpServer, tools: Array<{name: string; description?: string; inputSchema?: unknown}>): void {
  const mappedTools = mapRemoteTools(record.name, record.client, tools);
  const currentNames = new Set(record.tools);
  for (const tool of mappedTools) {
    if (!currentNames.has(tool.name)) {
      record.tools.push(tool.name);
      currentNames.add(tool.name);
      loadedMcpTools.push(tool);
    }
  }
}

/**
 * Initializes configured MCP servers. Existing stdio configurations stay valid;
 * HTTP servers use Streamable HTTP and optionally the SDK's OAuth 2.1 flow.
 */
export async function initMcpServers(): Promise<void> {
  await closeMcpServers();

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
    connectionRecord.status = "disconnected";
    if (!connectionRecord.error) connectionRecord.error = "MCP server process exited.";
  };
  transport.onerror = (error: Error) => {
    connectionRecord.status = "disconnected";
    connectionRecord.error = safeMcpError(error);
  };

  let stderrBuffer = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
  });

  try {
    await client.connect(transport);
    const toolsResult = await client.listTools();
    rememberDiscoveredTools(connectionRecord, toolsResult.tools || []);
    connectionRecord.status = "connected";
    connectionRecord.error = undefined;
  } catch (error) {
    connectionRecord.status = "error";
    connectionRecord.error = safeMcpError(error);
    if (stderrBuffer.trim()) {
      connectionRecord.error += "\nServer stderr: " + safeMcpError(stderrBuffer.trim());
    }
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
    connectionRecord.status = "disconnected";
    if (!connectionRecord.error) connectionRecord.error = "Remote MCP connection closed.";
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
    await client.connect(transport);
    const toolsResult = await client.listTools();
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
    const authorizationCode = await receiver.waitForAuthorizationCode();
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
    await authorizedClient.connect(authorizedTransport);
    const result = await authorizedClient.listTools();
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
  for (const srv of connectedServers.values()) {
    try {
      await srv.cleanup?.();
    } catch {
      // Best-effort cleanup should not block other MCP disconnects.
    }
    try {
      if (srv.transport instanceof StreamableHTTPClientTransport) {
        await srv.transport.terminateSession().catch(() => undefined);
      }
      await srv.transport?.close();
    } catch {
      // Ignore disconnect errors.
    }
  }
  connectedServers.clear();

  if (loadedMcpTools.length > 0) {
    const {
      allTools,
      masterToolset,
      superagentToolset,
      defaultSubagentToolset,
      subagentToolsets,
    } = await import("../tools/index.js");
    const toRemoveNames = new Set(loadedMcpTools.map((tool) => tool.name));
    const filterArray = (arr: any[]) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        const name = typeof item === "string" ? item : item?.name;
        if (name && toRemoveNames.has(name)) arr.splice(i, 1);
      }
    };
    filterArray(allTools);
    filterArray(masterToolset);
    filterArray(superagentToolset);
    filterArray(defaultSubagentToolset);
    for (const key of Object.keys(subagentToolsets)) {
      if (Array.isArray(subagentToolsets[key])) filterArray(subagentToolsets[key]);
    }
    loadedMcpTools = [];
    registeredMcpToolNames.clear();
  }
}
