import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

export type DelegateMethod =
  | "delegate.create_chat"
  | "delegate.read_chat"
  | "delegate.send_message"
  | "delegate.stop_generation";

type Pending = {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
};

export class DelegateBridge {
  private server: WebSocketServer | undefined;
  private client: WebSocket | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Map<string, Pending>();
  private waiters = new Set<() => void>();

  constructor(readonly port = 17341) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const expectedId = process.env.SUPERAGENT_DELEGATE_EXTENSION_ID?.trim();
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
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
        wss.on("connection", (ws) => this.onConnection(ws));
        resolve();
      });
    });
    return this.starting;
  }

  private onConnection(ws: WebSocket): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      ws.close(1008, "Delegate extension already connected");
      return;
    }
    let authenticated = false;
    const helloTimer = setTimeout(() => ws.close(1008, "HELLO timeout"), 3000);
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object") return;
      } catch {
        return;
      }
      if (!authenticated) {
        if (this.client?.readyState === WebSocket.OPEN && this.client !== ws) {
          ws.close(1008, "Another delegate extension is already connected");
          return;
        }
        if (msg.type !== "hello" || msg.protocol !== "superagent-delegate-v1") {
          ws.close(1008, "Invalid delegate protocol");
          return;
        }
        authenticated = true;
        clearTimeout(helloTimer);
        this.client = ws;
        ws.send(JSON.stringify({ type: "hello_ack", protocol: "superagent-delegate-v1" }));
        for (const wake of this.waiters) wake();
        this.waiters.clear();
        return;
      }
      if (msg.type !== "response" || typeof msg.id !== "string") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return; // late reply: never replay/retry a timed-out send
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.detachAbort();
      if (msg.ok === true) pending.resolve(JSON.stringify(msg.result ?? null));
      else {
        const error = msg.error && typeof msg.error === "object" ? msg.error as Record<string, unknown> : {};
        pending.reject(new Error(`${String(error.code || "DELEGATE_REMOTE_ERROR")}: ${String(error.message || "Extension request failed")}`));
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.client === ws) {
        this.client = undefined;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.detachAbort();
          p.reject(new Error("DELEGATE_EXTENSION_DISCONNECTED: Request not retried"));
          this.pending.delete(id);
        }
      }
    });
    ws.on("error", () => {}); // close event handles outstanding RPCs
  }

  private async connected(signal?: AbortSignal): Promise<WebSocket> {
    await this.start();
    if (this.client?.readyState === WebSocket.OPEN) return this.client;
    // First operation can start the listener. Give the already-installed
    // extension a short opportunity to reconnect, then fail fast.
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
    const readyClient = this.client as WebSocket | undefined;
    if (!readyClient || readyClient.readyState !== WebSocket.OPEN) {
      throw new Error("DELEGATE_EXTENSION_NOT_CONNECTED: Load chrome-extension-delegate unpacked and keep its service worker enabled");
    }
    return readyClient;
  }

  async request(method: DelegateMethod, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
    const ws = await this.connected(signal);
    if (signal?.aborted) throw new Error("DELEGATE_ABORTED");
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
        // Abort never invokes delegate.stop_generation.
        reject(new Error("DELEGATE_ABORTED: Request not retried; inspect chat before any new send"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("DELEGATE_TIMEOUT: Request may have reached ChatGPT; it was not resent. Read chat before taking further action."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve, reject, timer,
        detachAbort: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Exactly one WebSocket transmission per invocation.
        ws.send(JSON.stringify({ type: "request", id, method, params }), (err) => {
          if (err) { cleanup(); reject(new Error(`DELEGATE_TRANSPORT_FAILED: ${err.message}; request not retried`)); }
        });
      } catch (err) {
        cleanup();
        reject(new Error(`DELEGATE_TRANSPORT_FAILED: ${String(err)}; request not retried`));
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
    this.client?.close();
    this.client = undefined;
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const delegateBridge = new DelegateBridge();

