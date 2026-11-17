import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleServerRoute } from "../../src/serverRoutes.js";

describe("Desktop Live legacy loopback-only preview endpoints", () => {
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
  const framePath = "/api/desktop/live/lan-frame";
  const viewerPath = "/api/desktop/live/lan-preview";
  function sameOriginHeaders() {
    return { Origin: "http://127.0.0.1:" + port, "Content-Type": "application/json" };
  }

  it("rejects forwarded/public-proxy requests before viewing or controlling", async () => {
    for (const pathname of [viewerPath, framePath, "/api/desktop/live/lan-input",
      "/api/desktop/live/lan-takeover"]) {
      const res = await request("GET", pathname, { "X-Forwarded-For": "203.0.113.7" });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toBe("LAN_STREAM_LOOPBACK_REQUIRED");
    }
  });

  it("rejects DNS-rebinding Host headers on a private transport peer", async () => {
    const res = await request("GET", viewerPath, {Host: "attacker.example.test:9000"});
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe("LAN_STREAM_LOOPBACK_REQUIRED");
  });

  it("serves only a CSP-restricted, capability-free, read-only shell", async () => {
    const res = await request("GET", viewerPath);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("script-src 'nonce-");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.body).toContain("Local · View only");
    expect(res.body).toContain("history.replaceState");
    expect(res.body).toContain('method: "POST"');
    expect(res.body).not.toContain("/api/desktop/live/lan-input");
    expect(res.body).not.toContain("/api/desktop/live/lan-takeover");
    expect(res.body).not.toContain("btn-takeover");
  });

  it("does not interpolate incoming query secrets into HTML", async () => {
    const secret = "0123456789abcdef".repeat(4);
    const res = await request("GET", viewerPath + "?token=" + secret);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(secret);
  });

  it("rejects non-GET shell requests", async () => {
    expect((await request("POST", viewerPath)).status).toBe(405);
  });

  it("rejects legacy GET or URL query-token frame access", async () => {
    const res = await request("GET", framePath + "?token=" + dummyToken);
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it("requires same origin and JSON for frame POST requests", async () => {
    const body = JSON.stringify({token: dummyToken});
    const noOrigin = await request("POST", framePath, { "Content-Type":"application/json" }, body);
    expect(noOrigin.status).toBe(403);
    expect(JSON.parse(noOrigin.body).error).toBe("SAME_ORIGIN_JSON_REQUIRED");
    const wrongOrigin = await request("POST", framePath, {
      Origin:"http://evil.example.test","Content-Type":"application/json",
    },body);
    expect(wrongOrigin.status).toBe(403);
    expect(JSON.parse(wrongOrigin.body).error).toBe("SAME_ORIGIN_JSON_REQUIRED");
    const wrongType = await request("POST",framePath,{
      Origin:"http://127.0.0.1:"+port,"Content-Type":"text/plain",
    },body);
    expect(wrongType.status).toBe(403);
    expect(JSON.parse(wrongType.body).error).toBe("SAME_ORIGIN_JSON_REQUIRED");
  });

  it("rejects forged frame tokens, malformed bodies and unknown fields", async () => {
    for (const body of [
      "not-json", "{}", JSON.stringify({token:"invalid"}),
      JSON.stringify({token:dummyToken,action:"click"}),
      JSON.stringify({token:dummyToken,knownHash:"not-a-hash"}),
      JSON.stringify({token:dummyToken,quality:100}),
    ]) {
      const res = await request("POST",framePath,sameOriginHeaders(),body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe("INVALID_FRAME_REQUEST");
    }
  });

  it("does not expose frames for an inactive valid-looking token", async () => {
    const res = await request("POST",framePath,sameOriginHeaders(),JSON.stringify({token:dummyToken}));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe("FRAME_UNAVAILABLE_OR_REVOKED");
  });

  it("does not accept browser-origin native controller requests", async () => {
    for (const op of ["challenge","approve","status","revoke"]) {
      const path="/api/desktop/lan-controller/"+op;
      const response=await request("POST",path,{
        Origin:"http://untrusted.example.test",
        "Content-Type":"application/json",
      },"{}");
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).error).toBe("ANDROID_CONTROLLER_LOCAL_ONLY");
    }
  });

  it("requires POST for all native controller authorization operations", async () => {
    for (const op of ["challenge","approve","status","revoke"]) {
      const result=await request("GET","/api/desktop/lan-controller/"+op);
      expect(result.status).toBe(405);
      expect(JSON.parse(result.body).error).toBe("METHOD_NOT_ALLOWED");
    }
  });

  it("rejects forged controller bearer on revoke even if the view is reachable", async () => {
    const result=await request("POST","/api/desktop/lan-controller/revoke",
      {"Content-Type":"application/json"},
      JSON.stringify({
        deviceId:"123e4567-e89b-12d3-a456-426614174000",
        controllerToken:dummyToken,
        kind:"mouse",
      }));
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body).success).toBe(false);
  });

  it("rejects native input and takeover for every method even with a preview token", async () => {
    for (const pathname of ["/api/desktop/live/lan-input","/api/desktop/live/lan-takeover"]) {
      for (const method of ["GET","POST"]) {
        const res = await request(method,pathname+"?token="+dummyToken,
          method==="POST"?sameOriginHeaders():{},
          method==="POST"?JSON.stringify({token:dummyToken,action:"click",relX:0.5,relY:0.5}):undefined);
        expect(res.status).toBe(403);
        expect(JSON.parse(res.body).error).toBe("SEPARATE_NATIVE_CONTROLLER_APPROVAL_REQUIRED");
      }
    }
  });
});
