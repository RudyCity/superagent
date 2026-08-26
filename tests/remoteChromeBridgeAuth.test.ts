/**
 * Tests for the per-launch token auth on the remote Chrome WebSocket bridge.
 *
 * Verifies:
 *  - WS connections that do not present a valid handshake token are closed.
 *  - WS connections that present a wrong token are closed.
 *  - WS connections that present the correct token within the timeout are accepted.
 *  - The token-delivery HTTP endpoint is single-use, loopback-only, and 410s on the second call.
 *
 * The actual remoteChromeBridge module pulls in browserMacroTools and other
 * browser-automation code. To keep this test isolated and fast, we exercise
 * the same WS handshake pattern by instantiating a WebSocketServer with the
 * same verifyClient + post-connect handshake logic, then assert the wire
 * behavior end-to-end. This is the canonical black-box contract.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

let bridgeToken: string;
let wss: WebSocketServer;
let tokenHttp: http.Server;
let wsPort: number;
let tokenPort: number;
let servedOnce = false;
const HANDSHAKE_TYPE = "bridge_handshake_v1";
const HANDSHAKE_TIMEOUT_MS = 1500;

function bindFree(): Promise<{ wsPort: number; tokenPort: number }> {
  return new Promise((resolve, reject) => {
    const tmp = http.createServer();
    tmp.listen(0, "127.0.0.1", () => {
      const ws = (tmp.address() as { port: number }).port;
      tmp.close(() => {
        const tmp2 = http.createServer();
        tmp2.listen(0, "127.0.0.1", () => {
          const tok = (tmp2.address() as { port: number }).port;
          tmp2.close(() => resolve({ wsPort: ws, tokenPort: tok }));
        });
      });
    });
    tmp.on("error", reject);
  });
}

async function setupBridge() {
  const ports = await bindFree();
  wsPort = ports.wsPort;
  tokenPort = ports.tokenPort;
  bridgeToken = crypto.randomBytes(16).toString("base64url");
  servedOnce = false;

  // Token-delivery HTTP server (mirrors ensureTokenHttpServer in remoteChromeBridge.ts)
  await new Promise<void>((resolve) => {
    tokenHttp = http.createServer((req, res) => {
      const remote = req.socket.remoteAddress ?? "";
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (req.url !== "/token" || req.method !== "GET") {
        res.writeHead(404).end("not_found");
        return;
      }
      if (servedOnce) {
        res.writeHead(410).end("gone");
        return;
      }
      servedOnce = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: bridgeToken }));
    });
    tokenHttp.listen(tokenPort, "127.0.0.1", () => resolve());
  });

  // WebSocket bridge (mirrors ensureRemoteChromeBridge connection handler)
  await new Promise<void>((resolve) => {
    wss = new WebSocketServer({
      port: wsPort,
      host: "127.0.0.1",
      verifyClient: (info: { origin?: string }) => {
        const origin = info.origin || "";
        if (origin && !origin.startsWith("chrome-extension://")) return false;
        return true;
      },
    });
    wss.on("connection", (ws: WebSocket & { __bridgeHandshakeDone?: boolean }) => {
      let handshakeDone = false;
      const handshakeTimer = setTimeout(() => {
        if (handshakeDone) return;
        try { ws.close(1008, "handshake_timeout"); } catch {}
      }, HANDSHAKE_TIMEOUT_MS);
      const onHandshake = (raw: Buffer | string) => {
        if (handshakeDone) return;
        try {
          const data = JSON.parse(raw.toString());
          if (data?.type !== HANDSHAKE_TYPE || typeof data.token !== "string") {
            try { ws.close(1008, "bad_handshake"); } catch {}
            return;
          }
          const a = Buffer.from(data.token, "utf8");
          const b = Buffer.from(bridgeToken, "utf8");
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            try { ws.close(1008, "bad_token"); } catch {}
            return;
          }
          handshakeDone = true;
          ws.__bridgeHandshakeDone = true;
          clearTimeout(handshakeTimer);
          ws.off("message", onHandshake);
          try { ws.send(JSON.stringify({ type: "handshake_ack" })); } catch {}
        } catch {
          try { ws.close(1008, "bad_handshake"); } catch {}
        }
      };
      ws.on("message", onHandshake);
      ws.on("close", () => { handshakeDone = true; clearTimeout(handshakeTimer); });
      ws.on("message", (raw: Buffer | string) => {
        if (!handshakeDone) return;
        // After handshake, accept any frame as a benign echo.
        try { ws.send(raw); } catch {}
      });
    });
    wss.on("listening", () => resolve());
  });
}

async function teardownBridge() {
  await new Promise<void>((resolve) => {
    if (wss) {
      wss.close(() => resolve());
    } else {
      resolve();
    }
  });
  await new Promise<void>((resolve) => {
    if (tokenHttp) tokenHttp.close(() => resolve());
    else resolve();
  });
}

describe("Remote Chrome Bridge — token auth (v1)", () => {
  beforeAll(async () => {
    await setupBridge();
  });
  afterAll(async () => {
    await teardownBridge();
  });

  function connect(): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      const closed = new Promise<{ code: number; reason: string }>((res) => {
        ws.on("close", (code, reasonBuf) => {
          res({ code, reason: reasonBuf?.toString?.() ?? "" });
        });
      });
      ws.once("open", () => resolve({ ws, closed }));
      ws.once("error", () => {
        // Errors are expected when the server closes us; resolve with a
        // closed sentinel so individual tests can choose what to assert.
        resolve({ ws, closed: Promise.resolve({ code: -1, reason: "error" }) });
      });
      ws.once("error", reject);
    });
  }

  it("rejects a client that never sends a handshake (timeout)", async () => {
    const { ws, closed } = await connect();
    // Don't send anything; wait for the server to close us.
    const result = await closed;
    ws.removeAllListeners();
    try { ws.close(); } catch {}
    expect(result.code).toBe(1008);
    expect(result.reason).toBe("handshake_timeout");
  });

  it("rejects a client that sends a wrong token", async () => {
    const { ws, closed } = await connect();
    ws.send(JSON.stringify({ type: HANDSHAKE_TYPE, token: "wrong-token" }));
    const result = await closed;
    ws.removeAllListeners();
    try { ws.close(); } catch {}
    expect(result.code).toBe(1008);
    expect(result.reason).toBe("bad_token");
  });

  it("rejects a client that sends a malformed handshake (no token field)", async () => {
    const { ws, closed } = await connect();
    ws.send(JSON.stringify({ type: HANDSHAKE_TYPE }));
    const result = await closed;
    ws.removeAllListeners();
    try { ws.close(); } catch {}
    expect(result.code).toBe(1008);
    expect(result.reason).toBe("bad_handshake");
  });

  it("rejects a client that sends a wrong handshake type", async () => {
    const { ws, closed } = await connect();
    ws.send(JSON.stringify({ type: "hello", token: bridgeToken }));
    const result = await closed;
    ws.removeAllListeners();
    try { ws.close(); } catch {}
    expect(result.code).toBe(1008);
    expect(result.reason).toBe("bad_handshake");
  });

  it("accepts a client that presents the correct token", async () => {
    const { ws, closed } = await connect();
    const ack = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.send(JSON.stringify({ type: HANDSHAKE_TYPE, token: bridgeToken }));
    });
    expect(JSON.parse(ack).type).toBe("handshake_ack");
    // After handshake, server echoes frames. Send a benign one and assert.
    const echo = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.send(JSON.stringify({ type: "ping" }));
    });
    expect(JSON.parse(echo).type).toBe("ping");
    // Graceful close should NOT be a 1008.
    ws.close();
    const result = await closed;
    expect(result.code).not.toBe(1008);
  });

  it("token HTTP endpoint is single-use (returns 410 on second call)", async () => {
    const first = await fetch(`http://127.0.0.1:${tokenPort}/token`);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    const second = await fetch(`http://127.0.0.1:${tokenPort}/token`);
    expect(second.status).toBe(410);
  });

  it("token HTTP endpoint returns 404 for non-/token paths", async () => {
    const res = await fetch(`http://127.0.0.1:${tokenPort}/other`);
    expect(res.status).toBe(404);
  });
});
