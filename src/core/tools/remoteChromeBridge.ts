import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import os from "os";
import { setBrowserControlHandler, browserControlHandler } from "./browserMacroTools.js";

const DEFAULT_REMOTE_WS_PORT = 9223;

export interface ClientMetadata {
  profileId?: string;
  userAgent?: string;
  platform?: string;
  extensionVersion?: string;
  tabsCount?: number;
  activeTab?: { id?: number; title?: string; url?: string } | null;
  connectedAt: number;
  commandCount: number;
}

let wss: WebSocketServer | null = null;
const connectedClients = new Set<WebSocket>();
const clientMetadataMap = new Map<WebSocket, ClientMetadata>();
let activeClient: WebSocket | null = null;
let pingIntervalTimer: NodeJS.Timeout | null = null;

// Rate limiting state: max 30 commands per second
let commandCountWindow = 0;
let lastWindowReset = Date.now();
const MAX_COMMANDS_PER_SEC = 30;

const pendingRequests = new Map<
  string,
  { resolve: (value: string) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }
>();

let messageCounter = 0;

function logBridgeEvent(event: string, details?: string) {
  try {
    const logDir = path.join(os.homedir(), ".superagent-r");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, "bridge.log");
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [BRIDGE] ${event}${details ? ` - ${details}` : ""}\n`;
    fs.appendFileSync(logFile, line, "utf8");
  } catch {}
}

export function getRemoteChromeClientMetadata(): ClientMetadata | null {
  const client = getActiveClient();
  if (!client) return null;
  return clientMetadataMap.get(client) || null;
}

function getActiveClient(): WebSocket | null {
  if (activeClient && activeClient.readyState === WebSocket.OPEN) {
    return activeClient;
  }
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      activeClient = client;
      return client;
    }
  }
  activeClient = null;
  return null;
}

export function isRemoteChromeConnected(): boolean {
  return Boolean(getActiveClient());
}

function rejectAllPendingRequests(reason: string) {
  for (const [id, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  pendingRequests.clear();
}

function startPingHeartbeat() {
  if (pingIntervalTimer) return;
  pingIntervalTimer = setInterval(() => {
    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.ping();
        } catch {
          client.terminate();
          connectedClients.delete(client);
        }
      } else {
        connectedClients.delete(client);
      }
    }
    if (connectedClients.size === 0 && pendingRequests.size > 0) {
      rejectAllPendingRequests("All Remote Chrome connections closed.");
    }
  }, 20000);
}

function stopPingHeartbeat() {
  if (pingIntervalTimer) {
    clearInterval(pingIntervalTimer);
    pingIntervalTimer = null;
  }
}

// Maintain a registry of active WebSocketServer instances per port to prevent EADDRINUSE cycles
const activeServers = new Map<number, WebSocketServer>();
const lastFailureTime = new Map<number, number>();

/**
 * Initializes a serverless WebSocket server on port 9223 for Superagent CLI remote control.
 * Allows CLI tools to communicate directly with Superagent Remote Chrome Extension without running `superagent --server`.
 */
export function ensureRemoteChromeBridge(port: number = DEFAULT_REMOTE_WS_PORT): Promise<boolean> {
  const existingWss = activeServers.get(port);
  if (existingWss) {
    wss = existingWss;
    if (!browserControlHandler) {
      setBrowserControlHandler(sendRemoteCommand);
    }
    return Promise.resolve(true);
  }

  // If we recently failed to start the server (within the last 10 seconds),
  // don't try again immediately to avoid EADDRINUSE spam.
  const lastFail = lastFailureTime.get(port) || 0;
  if (process.env.NODE_ENV !== "test" && Date.now() - lastFail < 10000) {
    return Promise.resolve(false);
  }

  if (wss) {
    try {
      const addr = wss.address();
      if (addr && typeof addr === "object" && addr.port === port) {
        activeServers.set(port, wss);
        if (!browserControlHandler) {
          setBrowserControlHandler(sendRemoteCommand);
        }
        return Promise.resolve(true);
      }
    } catch {}
  }

  return new Promise((resolve) => {
    try {
      const server = new WebSocketServer({ port, host: "0.0.0.0" });
      wss = server;
      activeServers.set(port, server);

      server.on("listening", () => {
        if (!browserControlHandler) {
          setBrowserControlHandler(sendRemoteCommand);
        }
        startPingHeartbeat();
        logBridgeEvent("Server Started", `WebSocket server listening on port ${port}`);
        resolve(true);
      });

      server.on("connection", (ws: WebSocket) => {
        connectedClients.add(ws);
        activeClient = ws;
        clientMetadataMap.set(ws, { connectedAt: Date.now(), commandCount: 0 });
        if (!browserControlHandler || browserControlHandler === sendRemoteCommand) {
          setBrowserControlHandler(sendRemoteCommand);
        }
        logBridgeEvent("Client Connected", `Active clients: ${connectedClients.size}`);

        ws.on("pong", () => {
          // Client alive
        });

        ws.on("message", (raw: Buffer | string) => {
          try {
            const data = JSON.parse(raw.toString());

            // Handle metadata hello packet or tab_state update
            if (data.type === "hello" || data.type === "tab_state") {
              const currentMeta = clientMetadataMap.get(ws) || { connectedAt: Date.now(), commandCount: 0 };
              clientMetadataMap.set(ws, {
                ...currentMeta,
                ...(data.profileId ? { profileId: data.profileId } : {}),
                ...(data.userAgent ? { userAgent: data.userAgent } : {}),
                ...(data.platform ? { platform: data.platform } : {}),
                ...(data.extensionVersion ? { extensionVersion: data.extensionVersion } : {}),
                tabsCount: data.tabsCount !== undefined ? data.tabsCount : currentMeta.tabsCount,
                activeTab: data.activeTab !== undefined ? data.activeTab : currentMeta.activeTab,
              });
              logBridgeEvent(
                data.type === "tab_state" ? "Tab State Update" : "Client Metadata",
                `Profile: ${data.profileId || currentMeta.profileId || "Default"}, Tabs: ${data.tabsCount ?? currentMeta.tabsCount ?? 0}, ActiveTab: ${data.activeTab?.title || "N/A"} (${data.activeTab?.url || "N/A"})`
              );
              return;
            }

            const { id, success, result, error } = data;

            if (id && pendingRequests.has(id)) {
              const pending = pendingRequests.get(id)!;
              clearTimeout(pending.timeout);
              pendingRequests.delete(id);

              if (success) {
                pending.resolve(result || "");
              } else {
                pending.reject(new Error(error || "Remote Chrome Extension returned failure status."));
              }
            }
          } catch {}
        });

        ws.on("close", () => {
          connectedClients.delete(ws);
          clientMetadataMap.delete(ws);
          logBridgeEvent("Client Disconnected", `Remaining clients: ${connectedClients.size}`);
          if (activeClient === ws) {
            activeClient = null;
          }
          if (connectedClients.size === 0 && pendingRequests.size > 0) {
            rejectAllPendingRequests("Remote Chrome Extension disconnected.");
          }
        });

        ws.on("error", (err: any) => {
          connectedClients.delete(ws);
          clientMetadataMap.delete(ws);
          logBridgeEvent("Client Socket Error", err?.message || String(err));
          if (activeClient === ws) {
            activeClient = null;
          }
          if (connectedClients.size === 0 && pendingRequests.size > 0) {
            rejectAllPendingRequests("Remote Chrome Extension socket error.");
          }
        });
      });

      server.on("error", (err: any) => {
        activeServers.delete(port);
        lastFailureTime.set(port, Date.now());
        if (wss === server) {
          wss = null;
        }
        if (!browserControlHandler) {
          setBrowserControlHandler(sendRemoteCommand);
        }
        logBridgeEvent("Server Socket Error", err?.message || String(err));
        resolve(false);
      });
    } catch (err: any) {
      activeServers.delete(port);
      lastFailureTime.set(port, Date.now());
      if (!browserControlHandler) {
        setBrowserControlHandler(sendRemoteCommand);
      }
      resolve(false);
    }
  });
}

// Clean up all active WebSocket servers on process exit to release ports immediately
function setupExitHooks() {
  const cleanup = () => {
    for (const [port, server] of activeServers.entries()) {
      try {
        server.close();
        logBridgeEvent("Exit Hook Cleanup", `Closed WebSocket server on port ${port}`);
      } catch {}
    }
    activeServers.clear();
    wss = null;
    stopPingHeartbeat();
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

// Initialize exit hooks registration
setupExitHooks();


/**
 * Sends a command to the connected Superagent Remote Chrome Extension via WebSocket.
 */
export async function sendRemoteCommand(
  action: string,
  target: string,
  value?: string,
  instanceId?: string
): Promise<string> {
  // Rate limiting check (max 30 requests / sec)
  const now = Date.now();
  if (now - lastWindowReset > 1000) {
    commandCountWindow = 0;
    lastWindowReset = now;
  }
  if (commandCountWindow >= MAX_COMMANDS_PER_SEC) {
    logBridgeEvent("Rate Limit Exceeded", `Action '${action}' blocked (max ${MAX_COMMANDS_PER_SEC} req/sec)`);
    return Promise.reject(
      new Error(`Bridge rate limit exceeded (${MAX_COMMANDS_PER_SEC} requests/sec). Please slow down command calls.`)
    );
  }
  commandCountWindow++;

  let client = getActiveClient();
  if (!client) {
    const startTime = Date.now();
    const maxWait = process.env.VITEST ? 500 : 6000;
    while (!client && Date.now() - startTime < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      client = getActiveClient();
    }
  }

  if (!client) {
    return Promise.reject(
      new Error(
        "Remote Chrome Control Extension (chrome-extension-remote) is not connected. " +
          "Ensure Remote Chrome Extension (chrome-extension-remote) is installed in Chrome and active on port 9223."
      )
    );
  }

  // Update client metadata command counter
  const meta = clientMetadataMap.get(client);
  if (meta) {
    meta.commandCount++;
  }

  const id = `req_${Date.now()}_${++messageCounter}`;
  const commandStartTime = Date.now();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logBridgeEvent("Command Timeout", `Action '${action}' timed out after 15s`);
        reject(new Error(`Timeout waiting for Remote Chrome Extension response to action '${action}'.`));
      }
    }, 15000);

    pendingRequests.set(id, {
      resolve: (res) => {
        const duration = Date.now() - commandStartTime;
        logBridgeEvent("Command Executed", `Action '${action}' succeeded in ${duration}ms`);
        resolve(res);
      },
      reject: (err) => {
        logBridgeEvent("Command Failed", `Action '${action}' failed: ${err?.message || String(err)}`);
        reject(err);
      },
      timeout,
    });

    try {
      client!.send(
        JSON.stringify({
          id,
          action,
          target,
          value,
          instanceId,
        })
      );
    } catch (err) {
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

/**
 * Stop serverless bridge server.
 */
export function stopRemoteChromeBridge(): Promise<void> {
  stopPingHeartbeat();
  return new Promise((resolve) => {
    rejectAllPendingRequests("Remote Chrome Bridge server stopped.");
    for (const ws of connectedClients) {
      try {
        ws.close();
      } catch {}
    }
    connectedClients.clear();
    activeClient = null;

    if (wss) {
      const server = wss;
      wss = null;
      setBrowserControlHandler(null);
      server.close(() => {
        resolve();
      });
      setTimeout(resolve, 50);
    } else {
      setBrowserControlHandler(null);
      resolve();
    }
  });
}
