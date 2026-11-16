import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleServerRoute } from "../../src/serverRoutes.js";

describe("Desktop Live LAN Stream Routes (/api/desktop/live/lan-preview & lan-frame)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const ctx: any = {
        activeSessions: new Map(),
        lastActiveWorkspace: "",
        sseClients: new Set(),
        sseClientContexts: new Map(),
        browserInstances: new Map(),
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        pendingBrowserControls: new Map(),
        broadcastEvent: () => undefined,
        sendJSON: (response: http.ServerResponse, status: number, data: unknown) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(data));
        },
        readBody: async (request: http.IncomingMessage) => {
          let body = "";
          for await (const chunk of request) body += chunk.toString();
          return body;
        },
      };
      try {
        const handled = await handleServerRoute(req, res, url.pathname, url, ctx);
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      } catch {
        res.statusCode = 500;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function request(method: string, path: string, headers: Record<string, string> = {}, reqBody?: string) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const finalHeaders: Record<string, string> = { Host: `127.0.0.1:${port}`, ...headers };
      if (reqBody && !finalHeaders["Content-Length"]) {
        finalHeaders["Content-Length"] = String(Buffer.byteLength(reqBody));
      }
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: finalHeaders,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk.toString()));
          res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
        },
      );
      req.on("error", reject);
      if (reqBody) req.write(reqBody);
      req.end();
    });
  }

  const dummyToken = "a".repeat(64);

  it("rejects public/forwarded proxy headers", async () => {
    const res = await request("GET", `/api/desktop/live/lan-preview?token=${dummyToken}`, {
      "X-Forwarded-For": "203.0.113.7",
    });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("LAN_STREAM_PRIVATE_NETWORK_REQUIRED");
  });

  it("rejects requests missing token or with malformed token", async () => {
    const resNoToken = await request("GET", "/api/desktop/live/lan-preview");
    expect(resNoToken.status).toBe(400);

    const resBadToken = await request("GET", "/api/desktop/live/lan-preview?token=invalid_token");
    expect(resBadToken.status).toBe(400);
  });

  it("serves HTML stream viewer on valid token from loopback", async () => {
    const res = await request("GET", `/api/desktop/live/lan-preview?token=${dummyToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("LAN LIVE STREAM");
    expect(res.body).toContain("SuperAgent Desktop Live · LAN Stream");
    expect(res.body).toContain("/api/desktop/live/lan-frame");
  });

  it("rejects POST method on lan-preview route", async () => {
    const res = await request("POST", `/api/desktop/live/lan-preview?token=${dummyToken}`);
    expect(res.status).toBe(405);
  });

  it("lan-frame rejects forged/inactive tokens cleanly", async () => {
    const res = await request("GET", `/api/desktop/live/lan-frame?token=${dummyToken}`);
    expect([400, 409]).toContain(res.status);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it("lan-takeover rejects invalid or inactive tokens cleanly", async () => {
    const resNoToken = await request("POST", "/api/desktop/live/lan-takeover");
    expect(resNoToken.status).toBe(400);

    const resInactive = await request("POST", `/api/desktop/live/lan-takeover?token=${dummyToken}`);
    expect(resInactive.status).toBe(409);
    const body = JSON.parse(resInactive.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("SESSION_NOT_ACTIVE");
  });

  it("lan-input rejects invalid payload, unsupported action or inactive session", async () => {
    const resNoMethod = await request("GET", `/api/desktop/live/lan-input?token=${dummyToken}`);
    expect(resNoMethod.status).toBe(405);

    const resBadJson = await request("POST", "/api/desktop/live/lan-input", { "Content-Type": "application/json" }, "{invalid-json");
    expect(resBadJson.status).toBe(400);

    const resNoToken = await request("POST", "/api/desktop/live/lan-input", { "Content-Type": "application/json" }, JSON.stringify({ action: "click" }));
    expect(resNoToken.status).toBe(400);

    const resInactive = await request("POST", "/api/desktop/live/lan-input", { "Content-Type": "application/json" }, JSON.stringify({ token: dummyToken, action: "click" }));
    expect(resInactive.status).toBe(409);
    const body = JSON.parse(resInactive.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("SESSION_NOT_ACTIVE");
  });
});
