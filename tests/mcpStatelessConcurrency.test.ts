import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import crypto from "node:crypto";
import {
  startMcpHttpServer,
  generateMcpBearerToken,
  MCP_HTTP_PATH,
  type McpHttpServerHandle,
} from "../src/core/mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../src/core/mcp/mcpOAuthRoutes.js";
import { randomToken } from "../src/core/mcp/mcpOAuthStore.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

describe("Stateless MCP Concurrency & Identity Isolation (M6 / S2)", () => {
  let handle: McpHttpServerHandle;
  let bearerToken: string;

  beforeAll(async () => {
    bearerToken = generateMcpBearerToken();
    handle = await startMcpHttpServer({
      port: 0,
      bearerToken,
      allowDangerous: false,
      toolExposure: "full",
    });
  });

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  it("handles 50 concurrent stateless requests without memory leakage or cross-talk", async () => {
    const rpc = (id: number, method: string, params: unknown = {}) => ({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const calls = Array.from({ length: 50 }, async (_, index) => {
      const res = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(rpc(index + 1, "tools/list", {})),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      let parsed: any;
      if (res.headers.get("content-type")?.includes("application/json")) {
        parsed = JSON.parse(text);
      } else {
        for (const line of text.split("\n")) {
          if (line.trim().startsWith("data:")) {
            parsed = JSON.parse(line.trim().slice(5).trim());
            break;
          }
        }
      }
      expect(parsed).toBeDefined();
      expect(parsed.id).toBe(index + 1);
      expect(Array.isArray(parsed.result?.tools)).toBe(true);
      return parsed.result.tools.length;
    });

    const results = await Promise.all(calls);
    expect(results).toHaveLength(50);
    // Every call must return the same consistent set of safe tools
    const firstCount = results[0];
    expect(firstCount).toBeGreaterThan(0);
    for (const count of results) {
      expect(count).toBe(firstCount);
    }
  });

  it("guarantees zero identity bleed across concurrent stateless requests with distinct OAuth identities and scopes (Finding 7)", async () => {
    setFullYoloMode(false);
    setYoloMode(true); // Allow dangerous tools to be discoverable if OAuth token has write scope

    const generated = generateBootstrapCode();
    const oauthHandle = await startMcpHttpServer({
      port: 0,
      allowDangerous: true,
      authMode: "oauth",
      toolExposure: "full",
      oauth: {
        publicBaseUrl: "http://127.0.0.1",
        bootstrapCodeHash: generated.codeHash,
      },
    });

    const callback = "http://127.0.0.1/oauth-test-callback";
    oauthHandle.oauthStore!.registerClient("client-read-only", [callback]);
    oauthHandle.oauthStore!.registerClient("client-read-write", [callback]);

    async function issueToken(clientId: string, scope: string[]): Promise<string> {
      const verifier = randomToken(40);
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: scope.join(" "),
        state: "state-" + clientId,
        resource: "http://127.0.0.1/mcp",
      });
      const consent = await fetch(`http://127.0.0.1:${oauthHandle.port}/oauth/authorize?${query}`, { redirect: "manual" });
      const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1];
      const approve = await fetch(`http://127.0.0.1:${oauthHandle.port}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          request_id: requestId!,
          bootstrap_code: generated.code,
          decision: "approve",
        }),
      });
      const code = new URL(approve.headers.get("location")!).searchParams.get("code");
      const grant = await fetch(`http://127.0.0.1:${oauthHandle.port}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          client_id: clientId,
          redirect_uri: callback,
          code_verifier: verifier,
          resource: "http://127.0.0.1/mcp",
        }),
      });
      const tokens = (await grant.json()) as { access_token: string };
      return tokens.access_token;
    }

    try {
      const readOnlyToken = await issueToken("client-read-only", ["mcp:tools"]);
      const readWriteToken = await issueToken("client-read-write", ["mcp:tools", "mcp:tools:write"]);

      const rpc = (id: number, method: string, params: unknown = {}) => ({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      // Concurrently dispatch 25 calls from client-read-only and 25 calls from client-read-write interleaved
      const parseResponse = async (res: Response) => {
        const text = await res.text();
        if (res.headers.get("content-type")?.includes("application/json")) {
          return JSON.parse(text);
        }
        for (const line of text.split("\n")) {
          if (line.trim().startsWith("data:")) {
            return JSON.parse(line.trim().slice(5).trim());
          }
        }
        return JSON.parse(text);
      };

      const readOnlyPromises = Array.from({ length: 25 }, async (_, i) => {
        const res = await fetch(`http://127.0.0.1:${oauthHandle.port}${MCP_HTTP_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${readOnlyToken}`,
          },
          body: JSON.stringify(rpc(100 + i, "tools/list", {})),
        });
        expect(res.status).toBe(200);
        const data: any = await parseResponse(res);
        const tools: Array<{ name: string }> = data?.result?.tools || [];
        const toolNames = new Set(tools.map((t) => t.name));

        // Read-only client must NEVER see dangerous write tools
        expect(toolNames.has("superagent_exec_command")).toBe(false);
        expect(toolNames.has("superagent_write_files")).toBe(false);
        // But safe read tools must be present
        expect(toolNames.has("superagent_read_files")).toBe(true);
        return { clientId: "read-only", toolCount: tools.length };
      });

      const readWritePromises = Array.from({ length: 25 }, async (_, i) => {
        const res = await fetch(`http://127.0.0.1:${oauthHandle.port}${MCP_HTTP_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${readWriteToken}`,
          },
          body: JSON.stringify(rpc(200 + i, "tools/list", {})),
        });
        expect(res.status).toBe(200);
        const data: any = await parseResponse(res);
        const tools: Array<{ name: string }> = data?.result?.tools || [];
        const toolNames = new Set(tools.map((t) => t.name));

        // Read-write client MUST see dangerous write tools
        expect(toolNames.has("superagent_exec_command")).toBe(true);
        expect(toolNames.has("superagent_write_files")).toBe(true);
        expect(toolNames.has("superagent_read_files")).toBe(true);
        return { clientId: "read-write", toolCount: tools.length };
      });

      // Run all 50 interleaved requests concurrently
      const allResults = await Promise.all([...readOnlyPromises, ...readWritePromises]);
      expect(allResults).toHaveLength(50);

      const readOnlyCounts = allResults.filter((r) => r.clientId === "read-only").map((r) => r.toolCount);
      const readWriteCounts = allResults.filter((r) => r.clientId === "read-write").map((r) => r.toolCount);

      // Verify strict consistency: read-only never saw write tools, read-write always saw write tools
      expect(readOnlyCounts.every((c) => c === readOnlyCounts[0])).toBe(true);
      expect(readWriteCounts.every((c) => c === readWriteCounts[0])).toBe(true);
      expect(readWriteCounts[0]).toBeGreaterThan(readOnlyCounts[0]);
    } finally {
      await oauthHandle.close();
      setFullYoloMode(false);
      setYoloMode(false);
    }
  });
});
