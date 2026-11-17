import { describe, expect, it } from "vitest";
import { handleServerRoute } from "../src/serverRoutes.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";

describe("MCP project access operator route boundary", () => {
  async function invoke(
    pathname: string,
    options: { peer?: string; host?: string; origin?: string; token?: string; method?: string } = {},
  ) {
    const reply: { status?: number; body?: any } = {};
    const host = options.host ?? "localhost:7888";
    const headers: Record<string, string> = {
      host,
      authorization: "Bearer " + (options.token ?? ensureServerAuthToken()),
    };
    if (options.origin) headers.origin = options.origin;
    const req = {
      method: options.method ?? "POST",
      headers,
      socket: { remoteAddress: options.peer ?? "127.0.0.1" },
    } as any;
    const response = { setHeader() {} } as any;
    const ctx = {
      activeSessions: new Map(),
      sendJSON(_res: unknown, status: number, body: any) {
        reply.status = status;
        reply.body = body;
      },
    } as any;
    const handled = await handleServerRoute(req, response, pathname,
      new URL("http://" + host + pathname), ctx);
    return { handled, ...reply };
  }

  it("denies approval over public/tunnel ingress even with a valid Core token", async () => {
    const result = await invoke("/api/desktop/access/requests/approve", {
      peer: "203.0.113.10", host: "superagent.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("denies legacy direct grant from remote hosts", async () => {
    const result = await invoke("/api/projects/browser/grant", {
      peer: "203.0.113.10", host: "superagent.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("denies a mismatched browser Origin even on loopback", async () => {
    const result = await invoke("/api/desktop/access/direct-grant", {
      origin: "https://untrusted.example.com",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("LOCAL_OPERATOR_AUTH_REQUIRED");
  });

  it("denies a local request without a valid operator token", async () => {
    const result = await invoke("/api/desktop/access/requests/deny", {
      token: "invalid-token",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
  });

  it("permits authenticated local read-only identity inventory", async () => {
    const result = await invoke("/api/desktop/access/identities", {
      method: "GET",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body?.success).toBe(true);
    expect(Array.isArray(result.body?.identities)).toBe(true);
  });
});
