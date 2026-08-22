/**
 * serverAuth.test.ts
 *
 * Security regression tests for server-mode hardening:
 *   - Per-process auth token enforcement on /api/* routes
 *   - Origin-restricted CORS (localhost-only echo, no wildcard reflection)
 *   - Workspace root validation (isPathInside / isPathInsideOrEqual)
 *   - API key masking round-trip protection on provider config endpoints
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import {
  ensureServerAuthToken,
  resolveCorsOrigin,
  isPathInside,
  isPathInsideOrEqual,
} from "../src/core/utils/serverSecurity.js";
import { maskApiKey, isMaskedApiKey } from "../src/core/config/providers.js";

// Isolated config dir — must be set before any config module loads
const tmpConfigDir = path.join(os.tmpdir(), `sa-server-auth-${Date.now()}`);
process.env.SUPERAGENT_CONFIG_DIR = tmpConfigDir;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

function request(
  port: number,
  urlPath: string,
  options: http.RequestOptions & { headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET", ...options },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body: any = data;
          try { body = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let port: number;
let serverHandle: any;

beforeAll(async () => {
  port = await getFreePort();
  const { runServer } = await import("../src/server.js");
  serverHandle = await runServer(port, true /* silent */);
  expect(serverHandle).not.toBeNull();
}, 20000);

afterAll(async () => {
  try {
    if (serverHandle) await new Promise<void>((r) => serverHandle.close(() => r()));
  } catch {}
  try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
});

// ─── Pure helper: token generation ────────────────────────────────────────────
describe("ensureServerAuthToken", () => {
  it("returns a stable 48-char hex token", () => {
    const t1 = ensureServerAuthToken();
    const t2 = ensureServerAuthToken();
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{48}$/);
  });
});

// ─── Pure helpers: CORS origin policy ────────────────────────────────────────
describe("resolveCorsOrigin", () => {
  it("echoes localhost origins", () => {
    expect(resolveCorsOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(resolveCorsOrigin("http://127.0.0.1")).toBe("http://127.0.0.1");
    expect(resolveCorsOrigin("https://localhost:9222")).toBe("https://localhost:9222");
  });

  it("rejects non-localhost origins", () => {
    expect(resolveCorsOrigin("https://evil.example.com")).toBeUndefined();
    expect(resolveCorsOrigin("ftp://localhost")).toBeUndefined();
    expect(resolveCorsOrigin(undefined)).toBeUndefined();
  });
});

// ─── Integration: token enforcement on the HTTP API ──────────────────────────
describe("HTTP API auth enforcement", () => {
  it("responds 401 Unauthorized without a token", async () => {
    const r = await request(port, "/api/status");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("Unauthorized");
  });

  it("responds 200 through a registered route with a valid Bearer token", async () => {
    const r = await request(port, "/api/status", {
      headers: { Authorization: `Bearer ${ensureServerAuthToken()}` },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("online");
  });

  it("accepts the token via x-auth-token header", async () => {
    const r = await request(port, "/api/status", {
      headers: { "x-auth-token": ensureServerAuthToken() },
    });
    expect(r.status).toBe(200);
  });

  it("accepts the token via ?token= query parameter", async () => {
    const r = await request(port, `/api/status?token=${ensureServerAuthToken()}`);
    expect(r.status).toBe(200);
  });

  it("responds 401 for a wrong token", async () => {
    const r = await request(port, "/api/status", {
      headers: { Authorization: "Bearer deadbeef".repeat(6) },
    });
    expect(r.status).toBe(401);
  });
});

// ─── Integration: CORS behavior over the wire ────────────────────────────────
describe("CORS origin restrictions", () => {
  it("echoes a localhost Origin exactly", async () => {
    const r = await request(port, "/api/status", {
      headers: {
        Origin: "http://localhost:5173",
        Authorization: `Bearer ${ensureServerAuthToken()}`,
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("omits Access-Control-Allow-Origin for non-localhost origins", async () => {
    const r = await request(port, "/api/status", {
      headers: {
        Origin: "https://evil.example.com",
        Authorization: `Bearer ${ensureServerAuthToken()}`,
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preflight echoes localhost Origin and allows x-auth-token header", async () => {
    const r = await request(port, "/api/status", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(r.headers["access-control-allow-headers"])).toContain("x-auth-token");
  });

  it("preflight without Origin sends no ACAO header", async () => {
    const r = await request(port, "/api/status", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ─── Pure helpers: workspace containment ─────────────────────────────────────
describe("isPathInside / isPathInsideOrEqual", () => {
  const base = path.resolve(os.tmpdir(), "sa-guard-base");

  it("accepts paths strictly inside the base", () => {
    expect(isPathInside(base, path.join(base, "sub", "file.txt"))).toBe(true);
    expect(isPathInsideOrEqual(base, path.join(base, "src", "a.ts"))).toBe(true);
  });

  it("rejects paths outside the base", () => {
    const outside = path.resolve(os.tmpdir(), "somewhere-else");
    expect(isPathInside(base, outside)).toBe(false);
    expect(isPathInside(base, path.resolve(base, "..", "escape.txt"))).toBe(false);
  });

  it("rejects sibling directories that merely share a string prefix", () => {
    const sibling = `${base}-evil`;
    expect(isPathInside(base, path.join(sibling, "file.txt"))).toBe(false);
    expect(isPathInsideOrEqual(base, sibling)).toBe(false);
  });

  it("treats target === base as inside-only for the OrEqual variant", () => {
    expect(isPathInside(base, base)).toBe(false);
    expect(isPathInsideOrEqual(base, base)).toBe(true);
  });
});

// ─── Integration: unregistered client-supplied workspace is rejected ─────────
describe("workspace root validation", () => {
  it("responds 403 Forbidden workspace for an unregistered x-workspace-path", async () => {
    const r = await request(port, "/api/status", {
      headers: {
        "x-auth-token": ensureServerAuthToken(),
        "x-workspace-path": path.join(os.tmpdir(), `never-registered-${Date.now()}`),
      },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Forbidden workspace");
  });

  it("allows the server cwd as a valid workspace root", async () => {
    const r = await request(port, "/api/status", {
      headers: {
        "x-auth-token": ensureServerAuthToken(),
        "x-workspace-path": process.cwd(),
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.workspace).toBe(path.resolve(process.cwd()));
  });
});

// ─── Pure + integration: API key masking round-trip protection ────────────────
describe("API key masking", () => {
  it("masks keys and detects masked sentinels", () => {
    expect(maskApiKey("sk-abcdef123456wxyz")).toBe("sk-abc...wxyz");
    expect(isMaskedApiKey("sk-abc...wxyz")).toBe(true);
    expect(isMaskedApiKey("sk-abcdef123456wxyz")).toBe(false);
    expect(isMaskedApiKey("short")).toBe(false);
    expect(maskApiKey("short")).toBe("*".repeat(5));
  });

  it("preserves the stored real key when a masked key is echoed back", async () => {
    const token = ensureServerAuthToken();
    const addRes = await request(port, "/api/config/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": token },
      body: JSON.stringify({
        provider: { id: "sec-test-provider", name: "SecTest", type: "openai", apiKey: "sk-real-key-9876543210" },
      }),
    });
    expect(addRes.status).toBe(200);

    const cfg = await request(port, "/api/config", { headers: { "x-auth-token": token } });
    const masked = (cfg.body.providers || []).find((p: any) => p.id === "sec-test-provider");
    expect(masked.apiKey).toBe("sk-rea...3210");
    expect(JSON.stringify(cfg.body.providers)).not.toContain("sk-real-key-9876543210");

    // Round-trip edit echoing the masked sentinel back must NOT overwrite the real key
    const updateRes = await request(port, "/api/config/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": token },
      body: JSON.stringify({
        provider: { id: "sec-test-provider", name: "SecTest Renamed", type: "openai", apiKey: "sk-rea...3210" },
      }),
    });
    expect(updateRes.status).toBe(200);

    const { loadModelConfig } = await import("../src/core/config.js");
    const stored = (loadModelConfig().providers || []).find((p: any) => p.id === "sec-test-provider");
    expect(stored?.apiKey).toBe("sk-real-key-9876543210");
    expect(stored?.name).toBe("SecTest Renamed");
  });
});
