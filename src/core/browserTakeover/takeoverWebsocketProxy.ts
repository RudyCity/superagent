/**
 * Takeover WebSocket Proxy (Milestone M3)
 *
 * Provides a secure, authenticated WebSocket tunnel connecting an authorized human
 * operator to the local loopback noVNC/VNC transport (127.0.0.1).
 *
 * Hard Security Invariants:
 * 1. Strict authorization on BOTH HTTP upgrade and frame delivery.
 * 2. Origin/CORS validation: rejects untrusted or missing origins on remote requests.
 * 3. Session state gate: connection permitted ONLY when session is in `HUMAN_ACTIVE`.
 * 4. Input revocation: immediately closes client socket and drops frames when
 *    Return to Agent, cancellation, or expiration occurs.
 * 5. Loopback only: connects strictly to 127.0.0.1; external destination addresses are rejected.
 * 6. Single concurrent connection per session: prevents concurrent hijacking or split-brain input.
 */

import http from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { URL } from "node:url";
import { resolveCorsOrigin } from "../utils/serverSecurity.js";
import { getTakeoverSessionManager } from "./takeoverSessionManager.js";
import { loadTakeoverSession } from "./takeoverStateMachine.js";
import { getBrowserProcessManager } from "../browserRuntime/browserProcessManager.js";

export interface TakeoverWsProxyOptions {
  localNoVncHost?: string; // strictly "127.0.0.1"
  localNoVncPort?: number;
}

export class TakeoverWebsocketProxy {
  private activeSockets: Map<string, { clientWs: WebSocket; targetSocket?: net.Socket | WebSocket }> = new Map();
  private wss: WebSocketServer;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Handles an HTTP upgrade request for `/api/browser/takeover/ws`.
   */
  public async handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    isAuthorized: (req: http.IncomingMessage, parsedUrl: URL) => boolean,
    targetPortProvider?: (displayNumber?: number) => number
  ): Promise<void> {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
    const sessionId = parsedUrl.searchParams.get("sessionId");

    // 1. Validate Origin / CORS
    const origin = req.headers.origin;
    // Origin must exactly match the local web UI. A wildcard trust-list alone
    // is insufficient for privileged mouse and keyboard input.
    const host = String(req.headers.host || "");
    const socketLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress || "");
    let originMatches = false;
    try {
      const parsedOrigin = new URL(String(origin || ""));
      originMatches = parsedOrigin.host === host &&
        (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:");
    } catch {}
    if (!socketLocal || !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host) ||
        !origin || !resolveCorsOrigin(origin) || !originMatches) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\nOrigin not allowed");
      socket.destroy();
      return;
    }

    // 2. Require redeemed human capability. A generic Core API token alone
    // must NEVER grant input to a human-held browser.
    const requestedProtocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim());
    const operatorProtocol = requestedProtocols.find(s => s.startsWith("operator."));
    const operatorToken = operatorProtocol?.slice("operator.".length) || "";
    const manager = getTakeoverSessionManager();
    if (!sessionId || !(await manager.authorizeOperator(sessionId, operatorToken))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\nAuthentication required");
      socket.destroy();
      return;
    }

    // 3. Validate Session State
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nInvalid or missing sessionId");
      socket.destroy();
      return;
    }

    const session = await loadTakeoverSession(sessionId);
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\nTakeover session not found");
      socket.destroy();
      return;
    }

    // GATED: Only allow connection in HUMAN_ACTIVE state
    if (session.state !== "HUMAN_ACTIVE") {
      socket.write(`HTTP/1.1 403 Forbidden\r\n\r\nTakeover session in state '${session.state}', not 'HUMAN_ACTIVE'`);
      socket.destroy();
      return;
    }

    // Check actual owning Chrome/display, never guess a noVNC port.
    const runtime = getBrowserProcessManager().getActiveInstance(session.port);
    const noVncPort = runtime?.virtualDisplay?.noVncPort;
    if (!runtime || !noVncPort || runtime.virtualDisplay?.displayNumber !== session.displayNumber ||
        runtime.browserFingerprint !== session.browserFingerprint) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\nOwned virtual display unavailable");
      socket.destroy();
      return;
    }
    // Remote access is deliberately unavailable until TLS/OIDC gateway E2E is
    // certified. Even a misconfigured flag cannot open an unprotected path.
    // 4. Concurrency check: Reject if already connected
    if (this.activeSockets.has(sessionId)) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\nActive session connection already exists");
      socket.destroy();
      return;
    }

    // 5. Complete WebSocket Upgrade
    this.wss.handleUpgrade(req, socket, head, (clientWs) => {
      this.setupProxyTunnel(clientWs, sessionId, noVncPort, operatorToken);
    });
  }

  /**
   * Sets up bidirectional piping between client WebSocket and local loopback transport.
   */
  private setupProxyTunnel(
    clientWs: WebSocket,
    sessionId: string,
    targetPort: number,
    operatorToken: string
  ): void {
    // Port is derived from the verified owned runtime, not a client guess.

    // Connect to local loopback websockify server
    const targetWs = new WebSocket(`ws://127.0.0.1:${targetPort}/websockify`, {
      origin: "http://127.0.0.1",
    });

    const sessionEntry = { clientWs, targetSocket: targetWs };
    this.activeSockets.set(sessionId, sessionEntry);

    // Register immediate input revoker with TakeoverSessionManager
    const manager = getTakeoverSessionManager();
    manager.registerInputRevoker(sessionId, () => {
      this.closeSessionTunnel(sessionId, 4001, "Input revoked: Return to Agent initiated");
    });

    // Pipe frames from target to client
    targetWs.on("message", (data: any, isBinary: boolean) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    // Pipe frames from client to target
    clientWs.on("message", async (data: any, isBinary: boolean) => {
      try {
        if (!this.activeSockets.has(sessionId) ||
            !(await manager.authorizeOperator(sessionId, operatorToken))) {
          this.closeSessionTunnel(sessionId, 4003, "Human authorization expired or revoked");
          return;
        }
        if (this.activeSockets.get(sessionId) !== sessionEntry) return;
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(data, { binary: isBinary });
        }
      } catch {
        this.closeSessionTunnel(sessionId, 4003, "Authorization unavailable");
      }
    });

    // Server-side expiry/failure revocation closes inactive sockets, not just
    // on client message events or an explicit Return call.
    const expiryTimer = setInterval(async () => {
      if (!(await manager.authorizeOperator(sessionId, operatorToken))) {
        this.closeSessionTunnel(sessionId, 4003, "Human session expired");
      }
    }, 3000);
    expiryTimer.unref();

    // Error and cleanup handling
    const cleanup = () => {
      clearInterval(expiryTimer);
      this.closeSessionTunnel(sessionId);
    };

    clientWs.on("close", cleanup);
    clientWs.on("error", cleanup);
    targetWs.on("close", cleanup);
    targetWs.on("error", cleanup);
  }

  /**
   * Closes an active proxy tunnel and revokes input immediately.
   */
  public closeSessionTunnel(sessionId: string, code = 1000, reason = "Closed"): void {
    const entry = this.activeSockets.get(sessionId);
    if (!entry) return;

    this.activeSockets.delete(sessionId);
    getTakeoverSessionManager().unregisterInputRevoker(sessionId);

    try {
      if (entry.clientWs.readyState === WebSocket.OPEN || entry.clientWs.readyState === WebSocket.CONNECTING) {
        entry.clientWs.close(code, reason);
      }
    } catch {}

    try {
      if (entry.targetSocket && (entry.targetSocket as WebSocket).readyState !== undefined) {
        (entry.targetSocket as WebSocket).close();
      } else if (entry.targetSocket && typeof (entry.targetSocket as net.Socket).destroy === "function") {
        (entry.targetSocket as net.Socket).destroy();
      }
    } catch {}
  }

  public getActiveCount(): number {
    return this.activeSockets.size;
  }
}

// Global default singleton
let defaultProxy: TakeoverWebsocketProxy | null = null;

export function getTakeoverWebsocketProxy(): TakeoverWebsocketProxy {
  if (!defaultProxy) {
    defaultProxy = new TakeoverWebsocketProxy();
  }
  return defaultProxy;
}
