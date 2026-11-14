import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleServerRoute } from "../../src/serverRoutes.js";
import { ensureServerAuthToken } from "../../src/core/utils/serverSecurity.js";
import { remotePrivateHostOperator } from "../../src/core/desktopUi/remotePrivateOperator.js";

describe("local host-only Desktop Live private operator endpoints", () => {
  let server: http.Server;
  let port: number;
  let bearer: string;
  beforeAll(async () => {
    bearer = ensureServerAuthToken();
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const ctx: any = {
        activeSessions: new Map(), lastActiveWorkspace: "", sseClients: new Set(),
        sseClientContexts: new Map(), browserInstances: new Map(),
        pendingPermissions: new Map(), pendingQuestions: new Map(),
        pendingBrowserControls: new Map(), broadcastEvent: () => undefined,
        sendJSON: (reply: http.ServerResponse, status: number, value: unknown) => {
          reply.writeHead(status, { "Content-Type": "application/json" });
          reply.end(JSON.stringify(value));
        },
        readBody: async (request: http.IncomingMessage) => {
          let value = "";
          for await (const chunk of request) value += chunk.toString();
          return value;
        },
      };
      try {
        const handled = await handleServerRoute(req, res, url.pathname, url, ctx);
        if (!handled) { res.statusCode = 404; res.end("{}"); }
      } catch { res.statusCode = 500; res.end("{}"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function request(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, method, path,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      }, res => {
        let json = "";
        res.on("data", part => { json += part.toString(); });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: JSON.parse(json || "{}") });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  const authorized = () => ({ Authorization: `Bearer ${bearer}` });

  it("reports real NOT_CONFIGURED host readiness without a viewer secret or listener", async () => {
    const response = await request("GET", "/api/desktop/live/remote/status", authorized());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true, state: "NOT_CONFIGURED", viewAvailable: false,
      inputAvailable: false, approvalAvailable: false,
      viewerCertificateSha256: null, activeViewer: false,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/viewerKey|hostToken|Bearer |https:\/\/.*@/);
  });

  it("rejects bearer-free, URL credential, origin, reverse proxy and Cloudflare ingress", async () => {
    expect((await request("GET", "/api/desktop/live/remote/status")).status).toBe(403);
    expect((await request("GET", "/api/desktop/live/remote/status?token=whatever", authorized())).status)
      .toBe(403);
    for (const headers of [
      { Host: "external.example.com" }, { Origin: "http://127.0.0.1" },
      { "X-Forwarded-For": "10.0.0.2" }, { Forwarded: "for=10.0.0.2" },
      { Forwarded: "" }, { Origin: "" },
      { "Cf-Connecting-Ip": "10.0.0.2" }, { "Cf-Worker": "public" },
      { "Proxy-Authorization": "Basic abc" },
    ]) {
      expect((await request("GET", "/api/desktop/live/remote/status",
        { ...authorized(), ...headers })).status).toBe(403);
    }
  });

  it("only permits status GET and a strict empty-body local host revoke POST", async () => {
    expect((await request("POST", "/api/desktop/live/remote/status", authorized(), "{}")).status).toBe(405);
    expect((await request("GET", "/api/desktop/live/remote/stop", authorized())).status).toBe(405);
    expect((await request("POST", "/api/desktop/live/remote/stop",
      authorized(), JSON.stringify({ token: "b".repeat(64) }))).status).toBe(409);
    const result = await request("POST", "/api/desktop/live/remote/stop", authorized(), "{}");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true, state: "NOT_CONFIGURED", viewAvailable: false, inputAvailable: false,
    });
  });

  it("host takeover revokes any registered in-process runtime with no token payload", async () => {
    const humanTakeover = vi.fn();
    remotePrivateHostOperator.registerStopHook({ humanTakeover });
    const result = await request("POST", "/api/desktop/live/remote/stop", authorized(), "{}");
    expect(result.status).toBe(200);
    expect(humanTakeover).toHaveBeenCalledOnce();
    await request("POST", "/api/desktop/live/remote/stop", authorized(), "{}");
    expect(humanTakeover).toHaveBeenCalledOnce();
  });

  it("never adds a remote frame, input or approve route to the local preview API", async () => {
    for (const path of ["/api/desktop/live/remote/frame", "/api/desktop/live/remote/input",
      "/api/desktop/live/remote/approve", "/api/desktop/live/remote/start"]) {
      expect((await request("POST", path, authorized(), "{}")).status).toBe(404);
    }
  });
});
