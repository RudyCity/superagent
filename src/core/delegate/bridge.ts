import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { writeDelegateConnectionAudit, flushDelegateConnectionAudit, safeAuditText, type DelegateAuditEvent, type DelegateAuditRecord, type DelegateAuditSink } from "./connectionAudit.js";

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
  connectionId: string;
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
const PAIR_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_CODE_TTL_MS = 10 * 60_000;
const MAX_BAD_PAIR_ATTEMPTS = 5;
const PAIR_ATTEMPT_WINDOW_MS = 60_000;
function createPairingCode(): string {
  const values = randomBytes(8);
  return Array.from(values, byte => PAIR_CODE_CHARS[byte & 31]).join("");
}
function normalizePairingCode(input: unknown): string {
  return typeof input === "string" ? input.toUpperCase().replace(/[\s-]/g, "") : "";
}

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
  private pairingCode = "";
  private pairingIssuedAt = 0;
  private pairingTimeout: ReturnType<typeof setTimeout> | undefined;
  private badPairAttempts: number[] = [];
  private pairedClients = new Map<string, { extensionId: string; token: string }>();
  private clients = new Map<string, ClientSession>();
  private pending = new Map<string, Pending>();
  private waiters = new Set<() => void>();

  /** Optional test override. In deployed hosts the secret comes from process.env. */
  constructor(
    readonly port = 17341,
    private readonly tokenOverride?: string,
    private readonly auditSink: DelegateAuditSink = writeDelegateConnectionAudit,
    private readonly pairingNotice: (line: string) => void = line => console.info(line),
  ) {}

  private audit(event: DelegateAuditEvent, details: Partial<DelegateAuditRecord> = {}): void {
    const record: DelegateAuditRecord = {
      timestamp: new Date().toISOString(),
      event,
      pid: process.pid,
      listenerPort: this.port,
      endpoint: `ws://127.0.0.1:${this.port}`,
      activeProfiles: this.listConnections().length,
      openSockets: this.server?.clients.size ?? 0,
      pendingRequests: this.pending.size,
      ...details,
    };
    try { this.auditSink(record); } catch { /* audit cannot interrupt RPC */ }
  }


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
    // No manual token-file creation is required. The default is a random
    // per-process secret and a short-lived console pairing code. Previously
    // paired profiles must re-pair after a host restart in this mode.
    if (!token && this.tokenOverride === undefined &&
        !process.env.VITEST && process.env.NODE_ENV !== "test") {
      return randomBytes(32).toString("hex");
    }
    return token;
  }

  private issuePairingCode(): void {
    if (!this.authenticatedToken) {
      try {
        this.authenticatedToken = this.getAuthToken();
      } catch {}
    }
    if (this.pairingTimeout) clearTimeout(this.pairingTimeout);
    this.pairingCode = createPairingCode();
    this.pairingIssuedAt = Date.now();
    const displayed = this.pairingCode.slice(0, 4) + "-" + this.pairingCode.slice(4);
    // Print ONLY the short, expiring code to the local terminal, never
    // into connectionAudit JSONL / network / persistent credentials.
    this.pairingNotice("[Delegate][PAIR] Kode: " + displayed +
      " | berlaku 10 menit, sekali pakai | masukkan di popup Delegate");
    this.pairingTimeout = setTimeout(() => {
      if (this.server) this.issuePairingCode();
    }, PAIR_CODE_TTL_MS);
    this.pairingTimeout.unref?.();
  }

  private validatePairCode(submitted: unknown): boolean {
    const input = normalizePairingCode(submitted);
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(input)) return false;
    const now = Date.now();
    this.badPairAttempts = this.badPairAttempts.filter(t => now - t < PAIR_ATTEMPT_WINDOW_MS);
    if (this.badPairAttempts.length >= MAX_BAD_PAIR_ATTEMPTS) return false;
    if (!this.pairingCode || now - this.pairingIssuedAt >= PAIR_CODE_TTL_MS) return false;
    if (tokenMatches(this.pairingCode, input)) return true;
    this.badPairAttempts.push(now);
    return false;
  }

  listConnections(): DelegateClientInfo[] {
    return [...this.clients.values()]
      .filter(c => c.socket.readyState === WebSocket.OPEN)
      .map(({ clientId, label, extensionId, connectedAt }) => ({
        clientId, label, extensionId, connectedAt,
      }))
      .sort((a, b) => a.connectedAt - b.connectedAt || a.clientId.localeCompare(b.clientId));
  }
  isRunning(): boolean {
    return Boolean(this.server);
  }

  getPairingCode(): { code: string; expiresAt: number; ttlRemainingMs: number } | null {
    if (!this.pairingCode || !this.pairingIssuedAt) return null;
    const now = Date.now();
    const expiresAt = this.pairingIssuedAt + PAIR_CODE_TTL_MS;
    if (now >= expiresAt) return null;
    return {
      code: this.pairingCode.slice(0, 4) + "-" + this.pairingCode.slice(4),
      expiresAt,
      ttlRemainingMs: Math.max(0, expiresAt - now),
    };
  }

  renewPairingCode(): { code: string; expiresAt: number; ttlRemainingMs: number } | null {
    if (!this.authenticatedToken) {
      this.authenticatedToken = this.getAuthToken();
    }
    this.issuePairingCode();
    return this.getPairingCode();
  }

  disconnectClient(clientId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    try {
      client.socket.close(1000, "MANUALLY_DISCONNECTED");
    } catch {}
    this.clients.delete(clientId);
    this.pairedClients.delete(clientId);
    this.broadcastConnections();
    return true;
  }

  getStatus() {
    const pair = this.getPairingCode();
    return {
      running: this.isRunning(),
      port: this.port,
      endpoint: "ws://127.0.0.1:" + this.port,
      activeProfiles: this.listConnections(),
      openSockets: this.server?.clients.size ?? 0,
      pairingCode: pair ? pair.code : null,
      pairingExpiresAt: pair ? pair.expiresAt : null,
      pairingTtlMs: pair ? pair.ttlRemainingMs : null,
      authMode: this.authenticatedToken ? "pairing_required" : "development_unpaired",
    };
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
        verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
          const origin = info.origin || "";
          const validOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
          const allowed = validOrigin && (!expectedId || origin === `chrome-extension://${expectedId}`);
          if (!allowed) {
            this.audit("origin_rejected", {
              remoteAddress: safeAuditText(info.req?.socket.remoteAddress, 64),
              remotePort: info.req?.socket.remotePort,
              extensionId: validOrigin ? origin.slice("chrome-extension://".length) : undefined,
              reasonCode: validOrigin ? "EXTENSION_ID_MISMATCH" : "INVALID_EXTENSION_ORIGIN",
              authMode: this.authenticatedToken ? "pairing_required" : "development_unpaired",
              authVerified: false,
            });
          }
          return allowed;
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
        this.audit("listener_started", {
          authMode: this.authenticatedToken ? "pairing_required" : "development_unpaired",
        });
        this.issuePairingCode();
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
    const connectionId = randomUUID();
    const openedAt = Date.now();
    const base = {
      connectionId,
      extensionId,
      remoteAddress: safeAuditText(req.socket.remoteAddress, 64),
      remotePort: req.socket.remotePort,
      authMode: this.authenticatedToken ? "pairing_required" as const : "development_unpaired" as const,
    };
    const log = (event: DelegateAuditEvent, extra: Partial<DelegateAuditRecord> = {}) =>
      this.audit(event, { ...base, ...extra });
    let active: ClientSession | undefined;
    let rejectedReason: string | undefined;
    const reject = (reasonCode: string) => {
      if (rejectedReason) return;
      rejectedReason = reasonCode;
      log("handshake_rejected", {
        authVerified: false,
        reasonCode,
        handshakeDurationMs: Date.now() - openedAt,
      });
      socket.close(1008, reasonCode);
    };
    log("socket_open", { authVerified: false });
    if ((this.server?.clients.size || 0) > MAX_OPEN_SOCKETS) {
      socket.once("close", code => log("disconnected", {
        closeCode: code, reasonCode: "DELEGATE_SOCKET_LIMIT",
        connectedDurationMs: 0,
      }));
      reject("DELEGATE_SOCKET_LIMIT");
      return;
    }
    const helloTimer = setTimeout(() => reject("DELEGATE_HELLO_TIMEOUT"), 3000);

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
          reject("DELEGATE_INVALID_PROTOCOL");
          return;
        }
        const token = this.authenticatedToken;
        const declaredId = typeof msg.clientId === "string" ? msg.clientId : "";
        const clientId = CLIENT_ID_PATTERN.test(declaredId)
          ? declaredId : `legacy-${randomUUID()}`;
        const profileToken = this.pairedClients.get(clientId);
        const validCredential = !token ||
          tokenMatches(token, msg.authToken) ||
          (profileToken?.extensionId === extensionId &&
            tokenMatches(profileToken.token, msg.authToken));
        const wantPair = !validCredential && typeof msg.pairingCode === "string";
        if (!validCredential && !wantPair) {
          reject("DELEGATE_AUTH_FAILED");
          return;
        }
        if (wantPair && !this.validatePairCode(msg.pairingCode)) {
          reject(this.badPairAttempts.length >= MAX_BAD_PAIR_ATTEMPTS
            ? "DELEGATE_PAIR_RATE_LIMIT" : "DELEGATE_PAIR_CODE_INVALID");
          return;
        }
        const label = safeAuditText(msg.label, 48) || "Chrome Delegate";
        const extensionVersion = safeAuditText(msg.extensionVersion, 32);
        const browserUserAgent = safeAuditText(msg.browserUserAgent, 180);

        const existing = this.clients.get(clientId);
        if (existing && existing.socket.readyState === WebSocket.OPEN) {
          // Never allow takeover or forced disconnect of a live profile,
          // even if the two extensions share the same origin and token.
          reject("DELEGATE_DUPLICATE_CLIENT_ID");
          return;
        }
        if (!existing && this.listConnections().length >= MAX_CONNECTED_CLIENTS) {
          reject("DELEGATE_CLIENT_LIMIT");
          return;
        }

        const issuedClientToken = wantPair ? randomBytes(32).toString("hex") : undefined;
        if (issuedClientToken) {
          this.pairedClients.set(clientId, { extensionId, token: issuedClientToken });
        }
        active = { clientId, label, extensionId, connectedAt: Date.now(), connectionId, socket };
        this.clients.set(clientId, active);
        clearTimeout(helloTimer);
        socket.send(JSON.stringify({
          type: "hello_ack", protocol: PROTOCOL,
          clientId, clients: this.listConnections(),
          ...(issuedClientToken ? { authToken: issuedClientToken } : {}),
        }));
        if (issuedClientToken) {
          log("pairing_accepted", { clientId, profileLabel: label, authVerified: true });
        }
        log("connected", {
          clientId, profileLabel: label, extensionVersion, browserUserAgent,
          authVerified: validCredential && token.length > 0 || !!issuedClientToken,
          handshakeDurationMs: Date.now() - openedAt,
        });
        if (issuedClientToken) {
          // Put next-profile code directly BELOW the successful connection
          // in the server terminal, rather than before it.
          this.issuePairingCode();
        }
        this.broadcastConnections();
        for (const notify of this.waiters) notify();
        this.waiters.clear();
        return;
      }

      if (msg.type === "client_info") {
        if (typeof msg.label === "string") {
          const next = safeAuditText(msg.label, 48) || "Chrome Delegate";
          if (next !== active.label) {
            active.label = next;
            log("client_updated", { clientId: active.clientId, profileLabel: next, authVerified: this.authenticatedToken.length > 0 });
            this.broadcastConnections();
          }
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

    socket.on("close", code => {
      clearTimeout(helloTimer);
      this.rejectPendingForSocket(socket,
        "DELEGATE_EXTENSION_DISCONNECTED: Request not retried");
      if (active && this.clients.get(active.clientId)?.socket === socket) {
        this.clients.delete(active.clientId);
        this.broadcastConnections();
      }
      log("disconnected", {
        clientId: active?.clientId,
        profileLabel: active?.label,
        authVerified: !!active && this.authenticatedToken.length > 0,
        closeCode: code,
        reasonCode: rejectedReason || (active ? (code === 1000 ? "CLIENT_NORMAL_CLOSE" : "CONNECTION_CLOSED") : "UNAUTHENTICATED_CLOSE"),
        connectedDurationMs: active ? Date.now() - active.connectedAt : undefined,
        handshakeDurationMs: active ? active.connectedAt - openedAt : undefined,
      });
    });
    socket.on("error", error => {
      log("socket_error", {
        clientId: active?.clientId,
        transportErrorCode: safeAuditText((error as NodeJS.ErrnoException).code, 64) || "SOCKET_ERROR",
      });
    }); // close handles pending operations
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
    this.pairingCode = "";
    this.pairedClients.clear();
    if (this.pairingTimeout) clearTimeout(this.pairingTimeout);
    this.pairingTimeout = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    this.audit("listener_closed");
    this.authenticatedToken = "";
    await flushDelegateConnectionAudit();
  }
}

export const delegateBridge = new DelegateBridge();
