import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import crypto from "crypto";
import { RemoteAgentEnvelope, validateEnvelope } from "./protocol.js";
import { RemoteAgentConfig, maskSecret, rotateWsToken, updateRemoteAgentConfig } from "./config.js";
import {
  RemoteTransport,
  RemoteEnvelopeMeta,
  EnvelopeHandler,
} from "./transport.js";
import {
  validateCloudflareAccess,
  extractBearerToken,
  validateBearerToken,
  ReplayValidator,
} from "./museWsAuth.js";
import { logE2E } from "../utils/unifiedLogger.js";

const DEFAULT_WS_PORT = 9225;
const DEFAULT_WS_HOST = "127.0.0.1";
const DEFAULT_WS_PATH = "/muse";
const HANDSHAKE_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

interface ExtWebSocket extends WebSocket {
  isAlive?: boolean;
  isAuthenticated?: boolean;
  connectionId?: string;
}

/**
 * MuseWsServerTransport:
 * Local WebSocket server listening behind Cloudflare Tunnel on 127.0.0.1.
 * Validates Cloudflare Access Service Tokens and Bearer auth tokens.
 */
export class MuseWsServerTransport implements RemoteTransport {
  public readonly type = "websocket" as const;
  public onConnectionChange?: (connected: boolean, connectionId?: string) => void;
  private config: RemoteAgentConfig;
  private wss: WebSocketServer | null = null;
  private activeSocket: ExtWebSocket | null = null;
  private onEnvelopeHandler: EnvelopeHandler | null = null;
  private replayValidator = new ReplayValidator();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isStarted = false;

  constructor(config: RemoteAgentConfig, private customConfigPath?: string) {
    this.config = { ...config };
  }

  public async start(onEnvelope: EnvelopeHandler, abortSignal?: AbortSignal): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;
    this.onEnvelopeHandler = onEnvelope;

    const host = this.config.wsHost || DEFAULT_WS_HOST;
    const port = this.config.wsPort || DEFAULT_WS_PORT;
    const path = this.config.wsPath || DEFAULT_WS_PATH;

    logE2E("REMOTE-AGENT", `Starting Muse WebSocket server on ${host}:${port}${path}...`);

    return new Promise((resolve, reject) => {
      let isResolved = false;

      try {
        const wss = new WebSocketServer({
          host,
          port,
          path,
          maxPayload: MAX_PAYLOAD_BYTES,
          verifyClient: (info, callback) => {
            // Step 1: Cloudflare Access Service Token verification
            const cfCheck = validateCloudflareAccess(
              info.req.headers,
              this.config.cfAccessClientId,
              this.config.cfAccessClientSecret
            );
            if (!cfCheck.ok) {
              logE2E("REMOTE-AGENT", `WebSocket upgrade rejected by CF Access: ${cfCheck.reason}`);
              callback(false, 403, cfCheck.reason || "Forbidden: Invalid Cloudflare Access credentials");
              return;
            }

            // Step 2: Bearer token verification if token provided in request header or query
            if (this.config.wsToken || this.config.previousWsToken) {
              const token = extractBearerToken(info.req.headers.authorization, info.req.url);
              if (token) {
                const isValid = validateBearerToken(
                  token,
                  this.config.wsToken,
                  this.config.previousWsToken,
                  this.config.tokenRotatedAt,
                  this.config.tokenGracePeriodMs
                );
                if (!isValid) {
                  logE2E("REMOTE-AGENT", "WebSocket upgrade rejected: invalid bearer token");
                  callback(false, 401, "Unauthorized: Invalid bearer token");
                  return;
                }
              }
              // If not in header/query, allow connection but require handshake frame within 5s
            }

            callback(true);
          },
        });

        this.wss = wss;

        wss.on("listening", () => {
          logE2E("REMOTE-AGENT", `Muse WebSocket server listening on ws://${host}:${port}${path}`);
          this.startHeartbeat();
          if (!isResolved) {
            isResolved = true;
            resolve();
          }
        });

        wss.on("error", (err) => {
          logE2E("REMOTE-AGENT", `WebSocket server error: ${err.message}`);
          if (!isResolved) {
            isResolved = true;
            reject(err);
          }
        });

        wss.on("connection", (socket: ExtWebSocket, req: IncomingMessage) => {
          this.handleConnection(socket, req);
        });

        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            this.stop().catch(() => {});
          });
        }
      } catch (err) {
        if (!isResolved) {
          isResolved = true;
          reject(err);
        }
      }
    });
  }

  private handleConnection(socket: ExtWebSocket, req: IncomingMessage): void {
    const connectionId = crypto.randomUUID();
    socket.connectionId = connectionId;
    socket.isAlive = true;

    // Check if token was already verified during HTTP upgrade
    const initialToken = extractBearerToken(req.headers.authorization, req.url);
    const preAuthenticated = Boolean(
      (!this.config.wsToken && !this.config.previousWsToken) ||
      (initialToken &&
        validateBearerToken(
          initialToken,
          this.config.wsToken,
          this.config.previousWsToken,
          this.config.tokenRotatedAt,
          this.config.tokenGracePeriodMs
        ))
    );

    socket.isAuthenticated = preAuthenticated;

    logE2E(
      "REMOTE-AGENT",
      `New WebSocket connection ${connectionId}. Pre-authenticated: ${preAuthenticated}`
    );

    // Singleton check: reject if another authenticated session is already active
    if (preAuthenticated && this.activeSocket && this.activeSocket !== socket && this.activeSocket.readyState === WebSocket.OPEN) {
      logE2E("REMOTE-AGENT", `Closing connection ${connectionId}: another Muse session is already active.`);
      socket.close(4009, "Conflict: another Muse session is already active");
      return;
    }

    if (preAuthenticated) {
      this.activeSocket = socket;
      this.onConnectionChange?.(true, connectionId);
    }

    // Set handshake timeout if not pre-authenticated
    let handshakeTimer: NodeJS.Timeout | null = null;
    if (!socket.isAuthenticated) {
      handshakeTimer = setTimeout(() => {
        if (!socket.isAuthenticated) {
          logE2E("REMOTE-AGENT", `Handshake timeout for connection ${connectionId}. Closing.`);
          socket.close(4001, "Handshake authentication timeout");
        }
      }, HANDSHAKE_TIMEOUT_MS);
    }

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", async (data: Buffer | string) => {
      try {
        const text = typeof data === "string" ? data : data.toString("utf-8");
        const json = JSON.parse(text);

        // Handle handshake auth frame if awaiting auth
        if (!socket.isAuthenticated) {
          if (json?.kind === "auth" && typeof json?.token === "string") {
            const isValid = validateBearerToken(
              json.token,
              this.config.wsToken,
              this.config.previousWsToken,
              this.config.tokenRotatedAt,
              this.config.tokenGracePeriodMs
            );
            if (isValid) {
              if (handshakeTimer) clearTimeout(handshakeTimer);
              socket.isAuthenticated = true;

              // Enforce singleton connection
              if (this.activeSocket && this.activeSocket !== socket && this.activeSocket.readyState === WebSocket.OPEN) {
                logE2E("REMOTE-AGENT", `Closing competing session: ${connectionId}`);
                socket.close(4009, "Conflict: another Muse session is already active");
                return;
              }

              this.activeSocket = socket;
              this.onConnectionChange?.(true, connectionId);
              socket.send(JSON.stringify({ v: 1, kind: "auth_ok", connection_id: connectionId }));
              logE2E("REMOTE-AGENT", `Handshake authenticated for connection ${connectionId}`);
              return;
            } else {
              socket.close(4003, "Invalid authentication token");
              return;
            }
          } else {
            socket.close(4003, "Authentication frame required");
            return;
          }
        }

        // Validate replay attacks and clock drift
        const replayCheck = this.replayValidator.validate(json);
        if (!replayCheck.ok) {
          logE2E("REMOTE-AGENT", `Rejected replayed frame: ${replayCheck.reason}`);
          return;
        }

        // Validate envelope schema
        const validation = validateEnvelope(json);
        if (!validation.valid || !validation.envelope) {
          logE2E("REMOTE-AGENT", `Received invalid envelope: ${validation.error}`);
          return;
        }

        // Handle token refresh handshake
        if (validation.envelope.kind === "token_refresh_request") {
          const rotation = rotateWsToken(this.customConfigPath, this.config.tokenGracePeriodMs);
          const prevToken = rotation.previousToken || this.config.wsToken;
          this.config.wsToken = rotation.newToken;
          this.config.previousWsToken = prevToken;
          this.config.tokenRotatedAt = Date.now();

          const resp = {
            v: 1,
            kind: "token_refresh_response",
            id: `resp_${crypto.randomUUID()}`,
            request_id: validation.envelope.id,
            token: rotation.newToken,
            expires_in: this.config.tokenTtlSeconds || 86400,
            grace_period_seconds: Math.floor((this.config.tokenGracePeriodMs || 300000) / 1000),
            ts: Date.now(),
            nonce: crypto.randomUUID(),
          };
          socket.send(JSON.stringify(resp));
          logE2E(
            "REMOTE-AGENT",
            `Refreshed token on request from ${connectionId}. New token generated with grace period.`
          );
          return;
        }

        if (validation.envelope.kind === "token_ack") {
          logE2E(
            "REMOTE-AGENT",
            `Received token_ack from ${connectionId} for refresh ${validation.envelope.refresh_id}: status=${validation.envelope.status}`
          );
          return;
        }

        if (this.onEnvelopeHandler) {
          await this.onEnvelopeHandler(validation.envelope, {
            transport: "websocket",
            connectionId,
          });
        }
      } catch (err: any) {
        logE2E("REMOTE-AGENT", `Error processing message from ${connectionId}: ${err?.message}`);
      }
    });

    socket.on("close", (code, reason) => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      logE2E(
        "REMOTE-AGENT",
        `WebSocket connection ${connectionId} closed. Code: ${code}, reason: ${reason?.toString()}`
      );
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this.onConnectionChange?.(false, connectionId);
      }
    });

    socket.on("error", (err) => {
      logE2E("REMOTE-AGENT", `WebSocket socket error ${connectionId}: ${err.message}`);
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (this.wss) {
        for (const client of this.wss.clients as Set<ExtWebSocket>) {
          if (client.isAlive === false) {
            logE2E("REMOTE-AGENT", `Client heartbeat timeout. Terminating connection ${client.connectionId}`);
            client.terminate();
            if (this.activeSocket === client) {
              this.activeSocket = null;
            }
            continue;
          }
          client.isAlive = false;
          client.ping();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  public async sendEnvelope(
    envelope: RemoteAgentEnvelope,
    _replyToMeta?: RemoteEnvelopeMeta,
    onProgress?: (message: string) => void
  ): Promise<boolean> {
    if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
      onProgress?.("Failed to send envelope: no active WebSocket connection from Muse.");
      logE2E("REMOTE-AGENT", "sendEnvelope failed: no active WebSocket connection");
      return false;
    }

    try {
      const payload = JSON.stringify(envelope);
      this.activeSocket.send(payload);
      onProgress?.(`${envelope.kind} sent over WebSocket`);
      return true;
    } catch (err: any) {
      logE2E("REMOTE-AGENT", `sendEnvelope failed: ${err?.message}`);
      onProgress?.(`Failed to send ${envelope.kind}: ${err?.message}`);
      return false;
    }
  }

  /**
   * Proactively rotates the Bearer token and pushes a token_refresh envelope
   * to the currently connected Muse assistant over WebSocket.
   */
  public rotateToken(reason: string = "proactive_rotation"): { newToken: string; previousToken?: string } {
    const rotation = rotateWsToken(this.customConfigPath, this.config.tokenGracePeriodMs);
    const prevToken = rotation.previousToken || this.config.wsToken;
    this.config.wsToken = rotation.newToken;
    this.config.previousWsToken = prevToken;
    this.config.tokenRotatedAt = Date.now();

    if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
      const envelope: RemoteAgentEnvelope = {
        v: 1,
        kind: "token_refresh",
        id: `ref_${crypto.randomUUID()}`,
        token: rotation.newToken,
        expires_in: this.config.tokenTtlSeconds || 86400,
        grace_period_seconds: Math.floor((this.config.tokenGracePeriodMs || 300000) / 1000),
        ts: Date.now(),
        nonce: crypto.randomUUID(),
      };
      this.activeSocket.send(JSON.stringify(envelope));
      logE2E("REMOTE-AGENT", `Pushed proactive token_refresh to active Muse connection (${reason}).`);
    }

    return { newToken: rotation.newToken, previousToken: prevToken };
  }

  public isConnected(): boolean {
    return Boolean(this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN && this.activeSocket.isAuthenticated);
  }

  public async stop(): Promise<void> {
    this.isStarted = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.activeSocket) {
      this.activeSocket.close(1000, "Server stopping");
      this.activeSocket = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }
    this.replayValidator.reset();
  }

  public getTransportInfo(): { type: "websocket"; details: string } {
    const host = this.config.wsHost || DEFAULT_WS_HOST;
    const port = this.config.wsPort || DEFAULT_WS_PORT;
    const path = this.config.wsPath || DEFAULT_WS_PATH;
    const tokenInfo = this.config.wsToken ? maskSecret(this.config.wsToken) : "none";
    const cfInfo = this.config.cfAccessClientId ? `CF-Access-Id: ${this.config.cfAccessClientId}` : "CF-Access: disabled";

    return {
      type: "websocket",
      details: `WebSocket Server (ws://${host}:${port}${path}, Token: ${tokenInfo}, ${cfInfo}, Active: ${this.isConnected() ? "Connected" : "Listening"})`,
    };
  }
}

/**
 * MuseWsClientTransport:
 * Outbound WebSocket client connecting to a remote Muse hub over wss:// with Cloudflare Access headers.
 */
export class MuseWsClientTransport implements RemoteTransport {
  public readonly type = "websocket" as const;
  private config: RemoteAgentConfig;
  private socket: WebSocket | null = null;
  private onEnvelopeHandler: EnvelopeHandler | null = null;
  private replayValidator = new ReplayValidator();
  private isStarted = false;
  private shouldReconnect = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: RemoteAgentConfig, private customConfigPath?: string) {
    this.config = { ...config };
  }

  public async start(onEnvelope: EnvelopeHandler, abortSignal?: AbortSignal): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;
    this.shouldReconnect = true;
    this.onEnvelopeHandler = onEnvelope;

    if (!this.config.wsRemoteUrl) {
      throw new Error("WebSocket client mode requires wsRemoteUrl to be configured.");
    }

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        this.stop().catch(() => {});
      });
    }

    return this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.shouldReconnect) return;

    const url = this.config.wsRemoteUrl!;
    logE2E("REMOTE-AGENT", `Connecting to remote Muse WebSocket hub at ${url}...`);

    const headers: Record<string, string> = {};
    if (this.config.wsToken) {
      headers["Authorization"] = `Bearer ${this.config.wsToken}`;
    }
    if (this.config.cfAccessClientId) {
      headers["CF-Access-Client-Id"] = this.config.cfAccessClientId;
    }
    if (this.config.cfAccessClientSecret) {
      headers["CF-Access-Client-Secret"] = this.config.cfAccessClientSecret;
    }

    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers, maxPayload: MAX_PAYLOAD_BYTES });
      this.socket = ws;

      ws.on("open", () => {
        logE2E("REMOTE-AGENT", `Connected to remote Muse WebSocket at ${url}`);
        resolve();
      });

      ws.on("message", async (data: Buffer | string) => {
        try {
          const text = typeof data === "string" ? data : data.toString("utf-8");
          const json = JSON.parse(text);

          const replayCheck = this.replayValidator.validate(json);
          if (!replayCheck.ok) {
            logE2E("REMOTE-AGENT", `Rejected frame: ${replayCheck.reason}`);
            return;
          }

          const validation = validateEnvelope(json);
          if (validation.valid && validation.envelope) {
            // Handle token refresh in client mode
            if (validation.envelope.kind === "token_refresh" || validation.envelope.kind === "token_refresh_response") {
              const freshToken = validation.envelope.token;
              updateRemoteAgentConfig({ wsToken: freshToken }, this.customConfigPath);
              this.config.wsToken = freshToken;
              logE2E("REMOTE-AGENT", `Client transport updated wsToken from ${validation.envelope.kind}`);

              const ack: RemoteAgentEnvelope = {
                v: 1,
                kind: "token_ack",
                id: `ack_${crypto.randomUUID()}`,
                refresh_id: validation.envelope.id,
                status: "ok",
                ts: Date.now(),
                nonce: crypto.randomUUID(),
              };
              ws.send(JSON.stringify(ack));
              return;
            }

            if (this.onEnvelopeHandler) {
              await this.onEnvelopeHandler(validation.envelope, {
                transport: "websocket",
              });
            }
          }
        } catch (err: any) {
          logE2E("REMOTE-AGENT", `Client message handling error: ${err?.message}`);
        }
      });

      ws.on("close", (code, reason) => {
        logE2E("REMOTE-AGENT", `Remote Muse WebSocket disconnected: ${code} - ${reason?.toString()}`);
        this.socket = null;
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(() => {});
          }, 3000);
        }
      });

      ws.on("error", (err) => {
        logE2E("REMOTE-AGENT", `Remote Muse WebSocket error: ${err.message}`);
        resolve(); // Don't crash caller, let reconnect loop retry
      });
    });
  }

  public async requestTokenRefresh(reason: string = "client_refresh_request"): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const req: RemoteAgentEnvelope = {
      v: 1,
      kind: "token_refresh_request",
      id: `req_${crypto.randomUUID()}`,
      reason,
      ts: Date.now(),
      nonce: crypto.randomUUID(),
    };
    this.socket.send(JSON.stringify(req));
    return true;
  }

  public async sendEnvelope(
    envelope: RemoteAgentEnvelope,
    _replyToMeta?: RemoteEnvelopeMeta,
    onProgress?: (message: string) => void
  ): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      onProgress?.("Failed to send: WebSocket client is not connected.");
      return false;
    }
    try {
      this.socket.send(JSON.stringify(envelope));
      onProgress?.(`${envelope.kind} sent`);
      return true;
    } catch (err: any) {
      onProgress?.(`Failed to send ${envelope.kind}: ${err?.message}`);
      return false;
    }
  }

  public isConnected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  public async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.isStarted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close(1000, "Client stopped");
      this.socket = null;
    }
    this.replayValidator.reset();
  }

  public getTransportInfo(): { type: "websocket"; details: string } {
    return {
      type: "websocket",
      details: `WebSocket Client (${this.config.wsRemoteUrl || "unconfigured"}, Connected: ${this.isConnected()})`,
    };
  }
}

/**
 * Factory to create appropriate WebSocket transport based on config.
 */
export function createMuseWsTransport(config: RemoteAgentConfig, customConfigPath?: string): RemoteTransport {
  if (config.wsMode === "client") {
    return new MuseWsClientTransport(config, customConfigPath);
  }
  return new MuseWsServerTransport(config, customConfigPath);
}
