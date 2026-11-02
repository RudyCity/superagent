import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { TakeoverWebsocketProxy } from "../src/core/browserTakeover/takeoverWebsocketProxy.js";
import { getTakeoverSessionManager } from "../src/core/browserTakeover/takeoverSessionManager.js";
import { saveTakeoverSession } from "../src/core/browserTakeover/takeoverStateMachine.js";
import { getBrowserProcessManager } from "../src/core/browserRuntime/browserProcessManager.js";
import type { TakeoverSession } from "../src/core/browserTakeover/types.js";

function waitFor(condition: () => boolean, message: string, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (condition()) { resolve(); return; }
      if (Date.now() - started > timeout) { reject(new Error(message)); return; }
      setTimeout(check, 15);
    };
    check();
  });
}

describe("M4-C human takeover WebSocket reconnect and input revocation", () => {
  let temp: string;
  let proxy: TakeoverWebsocketProxy;
  let api: http.Server;
  let vnc: WebSocketServer;
  let port: number;
  let vncPort: number;
  let token: string;
  let sessionId: string;
  let backendClients: Set<WebSocket>;
  let clientMessages: string[];
  let priorSessionsDir: string | undefined;
  const sockets: WebSocket[] = [];
  const clientFrames = new WeakMap<WebSocket, string[]>();

  async function connect(
    session = sessionId, capability = token, origin?: string
  ): Promise<{ socket: WebSocket; status?: number }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/browser/takeover/ws?sessionId=${session}`,
      ["binary", "operator." + capability], { headers: { Origin: origin ?? `http://127.0.0.1:${port}` } });
    sockets.push(socket);
    const received: string[] = [];
    clientFrames.set(socket, received);
    socket.on("message", data => received.push(Buffer.from(data as Buffer).toString()));
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket upgrade result timed out")), 4000);
      socket.once("open", () => { clearTimeout(timeout); resolve({ socket }); });
      socket.once("unexpected-response", (_req, res) => {
        clearTimeout(timeout);
        res.resume();
        resolve({ socket, status: res.statusCode });
      });
      socket.once("error", err => { clearTimeout(timeout); reject(err); });
    });
  }

  beforeEach(async () => {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-m4c-proxy-"));
    priorSessionsDir = process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR;
    process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR = temp;
    proxy = new TakeoverWebsocketProxy();
    backendClients = new Set<WebSocket>();
    clientMessages = [];
    token = crypto.randomBytes(24).toString("hex");
    sessionId = crypto.randomUUID();

    vnc = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/websockify" });
    await once(vnc, "listening");
    vncPort = (vnc.address() as net.AddressInfo).port;
    vnc.on("connection", ws => {
      backendClients.add(ws);
      ws.on("close", () => backendClients.delete(ws));
      ws.send(Buffer.from("RFB 003.008\n"));
      ws.on("message", data => clientMessages.push(Buffer.from(data as Buffer).toString("utf8")));
    });

    const now = Date.now();
    const session: TakeoverSession = {
      sessionId, port: 9222, targetId: "m4c-controlled-tab",
      profileId: "m4c", generation: "1-123456",
      browserFingerprint: "a".repeat(64),
      displayNumber: 97, state: "HUMAN_ACTIVE",
      requestedBy: "agent", reason: "websocket live integration",
      tokenHash: "unused", operatorTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      invitationRedeemed: true, createdAt: now, updatedAt: now,
      invitationExpiresAt: now + 60000, sessionExpiresAt: now + 120000,
      auditTrail: [],
    };
    await saveTakeoverSession(session, temp);
    getTakeoverSessionManager({ sessionsDir: temp });
    vi.spyOn(getBrowserProcessManager(), "getActiveInstance").mockReturnValue({
      port: 9222, browserFingerprint: session.browserFingerprint,
      virtualDisplay: { displayNumber: 97, noVncPort: vncPort, vncPort: 5999 },
    } as any);

    api = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    api.on("upgrade", (req, socket, head) => {

      void proxy.handleUpgrade(req, socket, head, () => true).catch(() => socket.destroy());
    });
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
    port = (api.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) { try { ws.terminate(); } catch {} }
    for (const ws of backendClients) { try { ws.terminate(); } catch {} }
    await new Promise<void>(resolve => api.close(() => resolve()));
    await new Promise<void>(resolve => vnc.close(() => resolve()));
    await fsp.rm(temp, { recursive: true, force: true });
    if (priorSessionsDir === undefined) delete process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR;
    else process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR = priorSessionsDir;
    vi.restoreAllMocks();
  });

  it("requires a redeemed token and exact localhost Origin before tunnel creation", async () => {
    const wrong = await connect(sessionId, "invalid-secret");
    expect(wrong.status).toBe(401);
    const crossSite = await connect(sessionId, token, "https://evil.example");
    expect(crossSite.status).toBe(403);
    const valid = await connect();
    expect(valid.status).toBeUndefined();
    expect(valid.socket.readyState).toBe(WebSocket.OPEN);
    await waitFor(() => proxy.getActiveCount() === 1 && backendClients.size === 1,
      "valid operator connection not established");
  });

  it("forwards RFB frames, rejects parallel connections and permits a clean reconnect", async () => {
    const first = (await connect()).socket;
    await waitFor(() => proxy.getActiveCount() === 1 && backendClients.size === 1, "RFB backend not opened");
    await waitFor(() => clientFrames.get(first)?.includes("RFB 003.008\n") === true,
      "no RFB greeting");
    const rejected = await connect();
    expect(rejected.status).toBe(409);
    first.send(Buffer.from("human-input-before-reconnect"));
    await waitFor(() => clientMessages.includes("human-input-before-reconnect"), "input never reached VNC");

    first.close();
    await waitFor(() => proxy.getActiveCount() === 0 && backendClients.size === 0,
      "old tunnel not cleaned up");
    const next = (await connect()).socket;
    await waitFor(() => proxy.getActiveCount() === 1 && backendClients.size === 1,
      "reconnected tunnel not established");
    next.send(Buffer.from("human-input-after-reconnect"));
    for (let i = 0; i < 20; i++) next.send(Buffer.from(`ordered-frame-${i}`));
    await waitFor(() => clientMessages.includes("ordered-frame-19"),
      "ordered input frame burst not forwarded");
    const ordered = clientMessages.filter(frame => frame.startsWith("ordered-frame-"));
    expect(ordered).toEqual(Array.from({ length: 20 }, (_, i) => `ordered-frame-${i}`));
    expect(clientMessages).toContain("human-input-after-reconnect");
    // A late duplicate close callback from the OLD socket must never tear
    // down the new session that was already established.
    first.emit("close", 1000, Buffer.alloc(0));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(proxy.getActiveCount()).toBe(1);
    expect(next.readyState).toBe(WebSocket.OPEN);
  });

  it("fails closed when the owned display identity is absent", async () => {
    vi.mocked(getBrowserProcessManager().getActiveInstance).mockReturnValue(undefined);
    expect((await connect()).status).toBe(503);
    expect(proxy.getActiveCount()).toBe(0);
    expect(backendClients.size).toBe(0);
  });

  it("handles a VNC backend outage without silently changing human session ownership", async () => {
    const first = (await connect()).socket;
    await waitFor(() => backendClients.size === 1, "backend not connected");
    for (const backend of backendClients) backend.terminate();
    await waitFor(() => proxy.getActiveCount() === 0 && backendClients.size === 0,
      "backend outage not cleaned up");
    const { loadTakeoverSession } = await import("../src/core/browserTakeover/takeoverStateMachine.js");
    expect((await loadTakeoverSession(sessionId, temp))?.state).toBe("HUMAN_ACTIVE");
    const reconnect = await connect();
    expect(reconnect.status).toBeUndefined();
    await waitFor(() => proxy.getActiveCount() === 1, "reconnect after VNC outage failed");
    first.terminate();
  });

  it("revokes the tunnel immediately on authorized Return and denies subsequent reconnect", async () => {
    const socket = (await connect()).socket;
    await waitFor(() => proxy.getActiveCount() === 1, "session not active");
    const manager = getTakeoverSessionManager();
    const closed = once(socket, "close");
    const returned = await manager.requestReturn({ sessionId, operatorToken: token }, temp);
    expect(returned.state).toBe("VERIFYING");
    await closed;
    await waitFor(() => proxy.getActiveCount() === 0 && backendClients.size === 0, "revocation failed");
    const reconnect = await connect();
    expect(reconnect.status).toBe(401);
    const { loadTakeoverSession } = await import("../src/core/browserTakeover/takeoverStateMachine.js");
    // A Return request only changes the state; release/resume requires verified
    // browser identity and its original target reservation.
    expect((await loadTakeoverSession(sessionId, temp))?.state).toBe("VERIFYING");
  });
});
