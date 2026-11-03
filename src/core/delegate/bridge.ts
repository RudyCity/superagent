import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";

export type DelegateMethod =
  | "delegate.create_chat"
  | "delegate.read_chat"
  | "delegate.send_message"
  | "delegate.stop_generation";

type Pending = {
  socket: WebSocket;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
};

type ClientSession = {
  clientId: string;
  label: string;
  extensionId: string;
  connectedAt: number;
  socket: WebSocket;
};

export type DelegateClientInfo = {
  clientId: string;
  label: string;
  extensionId: string;
  connectedAt: number;
};

const PROTOCOL = "superagent-delegate-v1";
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const MAX_CONNECTED_CLIENTS = 8;
const MAX_OPEN_SOCKETS = 32;
const MAX_RPC_FRAME_BYTES = 2_000_000;

/** Constant-time digest comparison avoids exposing differences in token length. */
function tokenMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const digestExpected = createHash("sha256").update(expected).digest();
  const digestSupplied = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(digestExpected, digestSupplied);
}

export class DelegateBridge {
  private server: WebSocketServer | undefined;
  private starting: Promise<void> | undefined;
  private authenticatedToken = "";
  private clients = new Map<string, ClientSession>();
  private pending = new Map<string, Pending>();
  private waiters = new Set<() => void>();

  /** Optional test override. In deployed hosts the secret comes from process.env. */
  constructor(readonly port = 17341, private readonly tokenOverride?: string) {}

  private getAuthToken(): string {
    const file = process.env.SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE?.trim();
    let fromFile = "";
    if (this.tokenOverride === undefined && !process.env.SUPERAGENT_DELEGATE_AUTH_TOKEN && file) {
      try {
        const info = statSync(file);
        if (!info.isFile()) throw new Error("Not a regular file");
        if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
          throw new Error("Token file must be mode 0600 on POSIX");
        }
        fromFile = readFileSync(file, "utf8");
      } catch {
        throw new Error("DELEGATE_AUTH_TOKEN_FILE_UNREADABLE: Provide a private readable token file");
      }
    }
    const token = (
      this.tokenOverride !== undefined
        ? this.tokenOverride
        : process.env.SUPERAGENT_DELEGATE_AUTH_TOKEN || fromFile
    ).trim();
    if (token && (token.length < 32 || token.length > 512)) {
      throw new Error("DELEGATE_AUTH_CONFIGURATION_INVALID: Configure a 32–512 character random token");
    }
    if (!token && process.env.NODE_ENV === "production") {
      throw new Error("DELEGATE_AUTH_REQUIRED: Configure SUPERAGENT_DELEGATE_AUTH_TOKEN or SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE before production startup");
    }
    return token;
  }

  listConnections(): DelegateClientInfo[] {
    return [...this.clients.values()]
      .filter(c => c.socket.readyState === WebSocket.OPEN)
      .map(({ clientId, label, extensionId, connectedAt }) => ({
        clientId, label, extensionId, connectedAt,
      }))
      .sort((a, b) => a.connectedAt - b.connectedAt || a.clientId.localeCompare(b.clientId));
  }

  private broadcastConnections(): void {
    const clients = this.listConnections();
    const message = JSON.stringify({ type: "clients_update", protocol: PROTOCOL, clients });
    for (const entry of this.clients.values()) {
      if (entry.socket.readyState !== WebSocket.OPEN) continue;
      try { entry.socket.send(message); } catch {}
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    // Snapshot the configured key at startup. A missing/rotated token file
    // must not throw inside a websocket 'message' callback and crash the host.
    this.authenticatedToken = this.getAuthToken();
    this.starting = new Promise<void>((resolve, reject) => {
      const expectedId = process.env.SUPERAGENT_DELEGATE_EXTENSION_ID?.trim();
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
        maxPayload: MAX_RPC_FRAME_BYTES,
        verifyClient: (info: { origin?: string }) => {
          const origin = info.origin || "";
          if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
          return !expectedId || origin === `chrome-extension://${expectedId}`;
        },
      });
      const onError = (error: Error) => {
        this.starting = undefined;
        reject(new Error(`DELEGATE_BRIDGE_BIND_FAILED: ${error.message}`));
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        this.server = wss;
        wss.on("connection", (socket, req) => this.onConnection(socket, req));
        resolve();
      });
    });
    return this.starting;
  }

  private rejectPendingForSocket(socket: WebSocket, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.detachAbort();
      pending.reject(new Error(reason));
    }
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const origin = String(req.headers.origin || "");
    const extensionId = origin.replace(/^chrome-extension:\/\//, "");
    if ((this.server?.clients.size || 0) > MAX_OPEN_SOCKETS) {
      socket.close(1008, "DELEGATE_SOCKET_LIMIT");
      return;
    }
    let active: ClientSession | undefined;
    const helloTimer = setTimeout(() => socket.close(1008, "HELLO timeout"), 3000);

    socket.on("message", raw => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      } catch {
        return;
      }

      if (!active) {
        if (msg.type !== "hello" || msg.protocol !== PROTOCOL) {
          socket.close(1008, "Invalid delegate protocol");
          return;
        }
        const token = this.authenticatedToken;
        if (token && !tokenMatches(token, msg.authToken)) {
          socket.close(1008, "DELEGATE_AUTH_FAILED");
          return;
        }
        const declaredId = typeof msg.clientId === "string" ? msg.clientId : "";
        const clientId = CLIENT_ID_PATTERN.test(declaredId)
          ? declaredId : `legacy-${randomUUID()}`;
        const label = typeof msg.label === "string"
          ? msg.label.trim().slice(0, 48) || "Chrome Delegate"
          : "Chrome Delegate";

        const existing = this.clients.get(clientId);
        if (existing && existing.socket.readyState === WebSocket.OPEN) {
          // Never allow takeover or forced disconnect of a live profile,
          // even if the two extensions share the same origin and token.
          socket.close(1008, "DELEGATE_DUPLICATE_CLIENT_ID");
          return;
        }
        if (!existing && this.listConnections().length >= MAX_CONNECTED_CLIENTS) {
          socket.close(1008, "DELEGATE_CLIENT_LIMIT");
          return;
        }

        active = { clientId, label, extensionId, connectedAt: Date.now(), socket };
        this.clients.set(clientId, active);
        clearTimeout(helloTimer);
        socket.send(JSON.stringify({
          type: "hello_ack", protocol: PROTOCOL,
          clientId, clients: this.listConnections(),
        }));
        this.broadcastConnections();
        for (const notify of this.waiters) notify();
        this.waiters.clear();
        return;
      }

      if (msg.type === "client_info") {
        if (typeof msg.label === "string") {
          active.label = msg.label.trim().slice(0, 48) || "Chrome Delegate";
          this.broadcastConnections();
        }
        return;
      }

      if (msg.type !== "response" || typeof msg.id !== "string") return;
      const pending = this.pending.get(msg.id);
      if (!pending || pending.socket !== socket) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.detachAbort();
      if (msg.ok === true) {
        pending.resolve(JSON.stringify(msg.result ?? null));
      } else {
        const detail = msg.error && typeof msg.error === "object"
          ? msg.error as Record<string, unknown> : {};
        pending.reject(new Error(
          `${String(detail.code || "DELEGATE_REMOTE_ERROR")}: ${String(detail.message || "Extension request failed")}`,
        ));
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.rejectPendingForSocket(socket,
        "DELEGATE_EXTENSION_DISCONNECTED: Request not retried");
      if (active && this.clients.get(active.clientId)?.socket === socket) {
        this.clients.delete(active.clientId);
        this.broadcastConnections();
      }
    });
    socket.on("error", () => {}); // close handles pending operations
  }

  private async connected(clientId?: string, signal?: AbortSignal): Promise<ClientSession> {
    await this.start();
    const pick = (): ClientSession | undefined => {
      const clients = [...this.clients.values()].filter(c => c.socket.readyState === WebSocket.OPEN);
      if (clientId) {
        const match = clients.find(c => c.clientId === clientId);
        if (match) return match;
        if (clients.length) {
          throw new Error(`DELEGATE_TARGET_NOT_CONNECTED: Client ${clientId} is offline. Use delegate.read_chat({connections:true}) to list available clients.`);
        }
        return undefined;
      }
      if (clients.length > 1) {
        throw new Error("DELEGATE_MULTIPLE_CLIENTS: More than one Chrome Delegate is online. Choose clientId explicitly using delegate.read_chat({connections:true}). No action was dispatched.");
      }
      return clients[0];
    };

    const immediate = pick();
    if (immediate) return immediate;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("DELEGATE_ABORTED"));
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        reject(new Error("DELEGATE_ABORTED"));
      };
      const timer = setTimeout(finish, 2000);
      this.waiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
    const selected = pick();
    if (!selected) {
      throw new Error(clientId
        ? `DELEGATE_TARGET_NOT_CONNECTED: Client ${clientId} is offline. No action was dispatched.`
        : "DELEGATE_EXTENSION_NOT_CONNECTED: No enabled Chrome Delegate extension connected");
    }
    return selected;
  }

  async request(
    method: DelegateMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 20_000,
    targetClientId?: string,
  ): Promise<string> {
    const client = await this.connected(targetClientId, signal);
    if (signal?.aborted) throw new Error("DELEGATE_ABORTED");
    const ws = client.socket;
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.detachAbort();
      };
      const abort = () => {
        cleanup();
        reject(new Error("DELEGATE_ABORTED: Not retried; inspect chat before sending again"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(
          "DELEGATE_TIMEOUT: Outcome may be uncertain; not retried. Read chat before any new send.",
        ));
      }, timeoutMs);
      this.pending.set(id, {
        socket: ws, resolve, reject, timer,
        detachAbort: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Route once to the explicitly selected Chrome client; never broadcast.
        ws.send(JSON.stringify({ type: "request", id, method, params }), err => {
          if (err) {
            cleanup();
            reject(new Error(`DELEGATE_TRANSPORT_FAILED: ${err.message}; not retried`));
          }
        });
      } catch (error) {
        cleanup();
        reject(new Error(`DELEGATE_TRANSPORT_FAILED: ${String(error)}; not retried`));
      }
    });
  }

  async close(): Promise<void> {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.detachAbort();
      p.reject(new Error("DELEGATE_BRIDGE_CLOSED"));
      this.pending.delete(id);
    }
    for (const c of this.clients.values()) c.socket.close();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    this.authenticatedToken = "";
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export const delegateBridge = new DelegateBridge();
