import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { setBrowserControlHandler, browserControlHandler } from "./browserMacroTools.js";
import { getRootConfigDir, ensureGlobalConfigDir } from "../config/paths.js";

const DEFAULT_REMOTE_WS_PORT = 9223;
const DEFAULT_TOKEN_HTTP_PORT = 9224;
const BRIDGE_TOKEN_FILE = "bridge.token";
const BRIDGE_TOKEN_BYTES = 32; // 256 bits
// Handshake message types — the extension sends one of these as the very
// first frame after the WS upgrade completes. Using a post-connect
// handshake (rather than the subprotocol header) avoids leaking the
// token into the negotiated `ws.protocol` field, and works in browsers
// where `new WebSocket(url)` cannot set custom headers.
const HANDSHAKE_TIMEOUT_MS = 5000;
const HANDSHAKE_TYPE = "bridge_handshake_v1";

// Per-launch random token shared with the installed Chrome extension.
// Generated lazily on first bridge init; persisted chmod 600 to the
// global config dir so the extension can read it. Rotated on each
// `ensureRemoteChromeBridge()` call (i.e. each CLI launch).
let currentBridgeToken: string | null = null;
let currentBridgeTokenPath: string | null = null;

function getBridgeTokenPath(): string {
  if (currentBridgeTokenPath) return currentBridgeTokenPath;
  const dir = getRootConfigDir();
  ensureGlobalConfigDir();
  currentBridgeTokenPath = path.join(dir, BRIDGE_TOKEN_FILE);
  return currentBridgeTokenPath;
}

/**
 * Generate (or reuse) a per-launch random token that the extension must
 * present in the `X-Bridge-Token` header when connecting. The token is
 * persisted to a chmod-600 file under the global config dir so the
 * installed extension can read it via `chrome.storage.local` or by
 * fetching the file path.
 */
function loadOrCreateBridgeToken(): string {
  if (currentBridgeToken) return currentBridgeToken;
  const tokenPath = getBridgeTokenPath();
  // Always rotate on each launch — overwrite any existing file. This
  // limits the window in which a stolen token from a prior run remains
  // valid and avoids leaked tokens surviving restarts.
  const fresh = crypto.randomBytes(BRIDGE_TOKEN_BYTES).toString("base64url");
  try {
    fs.writeFileSync(tokenPath, fresh, { mode: 0o600 });
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  } catch (err) {
    // If we cannot write the file, log and continue with the in-memory
    // token (the extension will receive it via stdout on startup, or
    // can be configured with the in-process value via superagent --server).
    logBridgeEvent(
      "Token Persistence Failed",
      `Could not write bridge token to ${tokenPath}: ${(err as Error).message}. ` +
        "Token will only live in memory; restart the CLI after the extension connects."
    );
  }
  currentBridgeToken = fresh;
  return fresh;
}

export function getBridgeToken(): string {
  return currentBridgeToken ?? loadOrCreateBridgeToken();
}

export function getBridgeTokenPathForExtension(): string {
  return getBridgeTokenPath();
}

// Tiny loopback-only HTTP server that hands the per-launch token to the
// Chrome extension. The extension's background service worker cannot
// read arbitrary files or set custom WebSocket headers, so the CLI
// publishes the token on a private localhost endpoint. The endpoint
// is bound to 127.0.0.1 (not 0.0.0.0) and shuts itself down after
// the first successful response. It is single-use, per launch.
let tokenHttpServer: http.Server | null = null;

async function ensureTokenHttpServer(port: number = DEFAULT_TOKEN_HTTP_PORT): Promise<string | null> {
  if (tokenHttpServer) return getBridgeToken();
  const token = loadOrCreateBridgeToken();
  let servedOnce = false;

  await new Promise<void>((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        // Only allow GET /token from loopback (the listening address is
        // already bound to 127.0.0.1, so the OS enforces this, but we
        // double-check the remote address for defense-in-depth).
        const remote = req.socket.remoteAddress ?? "";
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("forbidden");
          return;
        }
        if (req.url !== "/token" || req.method !== "GET") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not_found");
          return;
        }
        if (servedOnce) {
          // Single-use: the token rotates per launch, so we never want
          // to hand it out twice from the same endpoint.
          res.writeHead(410, { "Content-Type": "text/plain" });
          res.end("gone");
          return;
        }
        servedOnce = true;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ token }));
        logBridgeEvent("Token Delivered", `Token handed to extension from ${remote}.`);
        // Self-destruct after a short delay to minimize exposure window.
        setTimeout(() => {
          try { srv.close(); } catch {}
          if (tokenHttpServer === srv) tokenHttpServer = null;
        }, 500);
      } catch (err) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("error");
        } catch {}
        logBridgeEvent("Token Deliver Error", (err as Error).message);
      }
    });
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another process (probably an old CLI session) already owns
        // the port. Skip token delivery — the existing server will
        // not know our token, so the extension will fall back to
        // file-based delivery (see getBridgeTokenPathForExtension).
        logBridgeEvent("Token HTTP EADDRINUSE", `Port ${port} already in use; will rely on file-based delivery.`);
      } else {
        logBridgeEvent("Token HTTP Error", err.message);
      }
      resolve();
    });
    srv.listen(port, "127.0.0.1", () => {
      tokenHttpServer = srv;
      logBridgeEvent("Token HTTP Listening", `127.0.0.1:${port}/token (loopback-only, single-use).`);
      resolve();
    });
  });
  return token;
}

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

  // Eagerly generate the per-launch token + token-delivery HTTP server
  // before opening the WS port. The handshake logic in the connection
  // handler below rejects any client that doesn't present this token.
  // We swallow the token-server error here — file-based delivery still
  // works via getBridgeTokenPathForExtension().
  void ensureTokenHttpServer().catch((err: Error) => {
    logBridgeEvent("Token HTTP Bootstrap", `Failed: ${err.message}`);
  });

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
      // Eagerly generate the per-launch token before opening the port so
      // the verifyClient closure captures a real value.
      loadOrCreateBridgeToken();

      const server = new WebSocketServer({
        port,
        host: "127.0.0.1",
        verifyClient: (info: { origin?: string; req: { headers: http.IncomingHttpHeaders } }) => {
          // Origin gate (legacy defense — kept in addition to the new
          // post-connect handshake below so that browsers that DO send
          // an Origin header are filtered at the HTTP layer).
          const origin = info.origin || "";
          if (origin && !origin.startsWith("chrome-extension://")) {
            logBridgeEvent("WS Reject", `Origin rejected: "${origin}"`);
            return false;
          }
          return true;
        }
      });
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

      server.on("connection", (ws: WebSocket & { __bridgeHandshakeDone?: boolean }) => {
        // ── Post-connect handshake gate ───────────────────────────────
        // The client MUST send `{ type: "bridge_handshake_v1", token }`
        // within HANDSHAKE_TIMEOUT_MS. If it doesn't, or the token
        // doesn't match the in-process token, we close the socket
        // without ever routing a command into browserControlHandler.
        let handshakeDone = false;
        const expected = currentBridgeToken ?? loadOrCreateBridgeToken();
        const handshakeTimer = setTimeout(() => {
          if (handshakeDone) return;
          logBridgeEvent("Handshake Timeout", "Closing socket — no bridge token presented.");
          try { ws.close(1008, "handshake_timeout"); } catch {}
        }, HANDSHAKE_TIMEOUT_MS);

        const onHandshake = (raw: Buffer | string) => {
          if (handshakeDone) return;
          try {
            const data = JSON.parse(raw.toString());
            if (data?.type !== HANDSHAKE_TYPE || typeof data.token !== "string") {
              logBridgeEvent("Bad Handshake", `Wrong shape from client: ${raw.toString().slice(0, 80)}`);
              try { ws.close(1008, "bad_handshake"); } catch {}
              return;
            }
            const a = Buffer.from(data.token, "utf8");
            const b = Buffer.from(expected, "utf8");
            if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
              logBridgeEvent("Bad Handshake", "Token mismatch.");
              try { ws.close(1008, "bad_token"); } catch {}
              return;
            }
            handshakeDone = true;
            ws.__bridgeHandshakeDone = true;
            clearTimeout(handshakeTimer);
            ws.off("message", onHandshake);
            try { ws.send(JSON.stringify({ type: "handshake_ack" })); } catch {}
            // Now register the client as fully connected and install
            // the browser control handler.
            if (!activeClient || activeClient.readyState !== WebSocket.OPEN) {
              activeClient = ws;
            }
            connectedClients.add(ws);
            clientMetadataMap.set(ws, { connectedAt: Date.now(), commandCount: 0 });
            if (!browserControlHandler || browserControlHandler === sendRemoteCommand) {
              setBrowserControlHandler(sendRemoteCommand);
            }
            logBridgeEvent("Client Connected (handshake OK)", `Active clients: ${connectedClients.size}`);
          } catch (err) {
            logBridgeEvent("Bad Handshake", `Parse error: ${(err as Error).message}`);
            try { ws.close(1008, "bad_handshake"); } catch {}
          }
        };
        ws.on("message", onHandshake);

        ws.on("close", () => {
          handshakeDone = true;
          clearTimeout(handshakeTimer);
        });

        ws.on("pong", () => {
          // Client alive
        });

        // Main message handler — only invoked AFTER the handshake frame
        // has been processed (we removed onHandshake above on success).
        ws.on("message", (raw: Buffer | string) => {
          if (!handshakeDone) return; // pre-handshake frames are dropped
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
