import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer } from "../src/core/mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../src/core/mcp/mcpOAuthRoutes.js";
import {
  getRemoteMcpOAuthCallbackPort,
  getRemoteMcpOAuthServerKey,
  PersistentMcpOAuthProvider,
  startMcpOAuthCallbackReceiver,
} from "../src/core/mcp/remoteMcpOAuthProvider.js";

let tempDir = "";

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function useTempConfigDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-remote-mcp-oauth-"));
  vi.stubEnv("SUPERAGENT_CONFIG_DIR", tempDir);
  return tempDir;
}

async function getAvailablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      probe.removeListener("error", reject);
      resolve();
    });
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("Could not allocate a loopback test port.");
  return port;
}

describe("remote MCP OAuth credential provider", () => {
  it("uses stable server keys and callback ports", () => {
    const first = getRemoteMcpOAuthServerKey("Google", "https://example.com/mcp");
    const second = getRemoteMcpOAuthServerKey("google", "https://example.com/mcp");
    expect(first).toBe(second);
    expect(getRemoteMcpOAuthCallbackPort(first)).toBe(getRemoteMcpOAuthCallbackPort(second));
    expect(getRemoteMcpOAuthCallbackPort(first)).toBeGreaterThanOrEqual(41000);
    expect(getRemoteMcpOAuthCallbackPort(first)).toBeLessThan(55000);
  });

  it("persists OAuth client information and tokens only in encrypted form", () => {
    const configDir = useTempConfigDir();
    const provider = new PersistentMcpOAuthProvider(
      "test-server-key",
      "http://127.0.0.1:43125/oauth/callback",
      "Test MCP client",
      async () => undefined,
    );
    provider.saveClientInformation({
      client_id: "test-client-id",
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://127.0.0.1:43125/oauth/callback"],
    } as any);
    provider.saveTokens({
      access_token: "unique-access-token-value",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "unique-refresh-token-value",
    });

    const filePath = path.join(configDir, "mcp-oauth-credentials.enc");
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw.startsWith("enc:v1:")).toBe(true);
    expect(raw).not.toContain("unique-access-token-value");
    expect(raw).not.toContain("unique-refresh-token-value");
    expect(raw).not.toContain("test-client-id");

    const reloaded = new PersistentMcpOAuthProvider(
      "test-server-key",
      "http://127.0.0.1:43125/oauth/callback",
      "Test MCP client",
      async () => undefined,
    );
    expect(reloaded.tokens()?.access_token).toBe("unique-access-token-value");
    expect(reloaded.clientInformation()?.client_id).toBe("test-client-id");
  });
});

describe("remote MCP OAuth callback receiver", () => {
  it("validates OAuth state and returns the authorization code without logging it", async () => {
    const receiver = await startMcpOAuthCallbackReceiver({
      port: 0,
      getExpectedState: () => "known-test-state",
    });
    try {
      const pendingCode = receiver.waitForAuthorizationCode();
      const response = await fetch(
        receiver.redirectUrl + "?code=one-time-test-code&state=known-test-state",
      );
      expect(response.status).toBe(200);
      expect(await pendingCode).toBe("one-time-test-code");
      expect(await response.text()).toContain("Authorization completed");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await receiver.close();
    }
  });

  it("rejects a callback with a mismatched state", async () => {
    const receiver = await startMcpOAuthCallbackReceiver({
      port: 0,
      getExpectedState: () => "expected-state",
    });
    try {
      const pendingCode = receiver.waitForAuthorizationCode();
      const response = await fetch(receiver.redirectUrl + "?code=ignored&state=wrong-state");
      expect(response.status).toBe(400);
      await expect(pendingCode).rejects.toThrow("state validation failed");
    } finally {
      await receiver.close();
    }
  });
});

describe("remote MCP OAuth client integration", () => {
  it("discovers, authorizes, exchanges the code, reconnects, and lists MCP tools", async () => {
    useTempConfigDir();
    const serverPort = await getAvailablePort();
    const publicBaseUrl = "http://127.0.0.1:" + serverPort;
    const bootstrap = generateBootstrapCode();
    const server = await startMcpHttpServer({
      port: serverPort,
      allowDangerous: false,
      authMode: "oauth",
      oauth: { publicBaseUrl, bootstrapCodeHash: bootstrap.codeHash },
    });

    let provider: PersistentMcpOAuthProvider | undefined;
    const callbackReceiver = await startMcpOAuthCallbackReceiver({
      port: 0,
      getExpectedState: () => provider?.currentState,
    });
    provider = new PersistentMcpOAuthProvider(
      "oauth-client-integration",
      callbackReceiver.redirectUrl,
      "SuperAgent OAuth integration test",
      async (authorizationUrl) => {
        // Simulate the browser consent page without launching an actual browser.
        const authorizePage = await fetch(authorizationUrl);
        expect(authorizePage.status).toBe(200);
        const html = await authorizePage.text();
        const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
        if (!requestId) throw new Error("OAuth server did not render a consent request.");

        const approval = await fetch(publicBaseUrl + "/oauth/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            request_id: requestId,
            bootstrap_code: bootstrap.code,
            decision: "approve",
          }).toString(),
          redirect: "manual",
        });
        expect(approval.status).toBe(302);
        const redirect = approval.headers.get("location");
        if (!redirect) throw new Error("OAuth approval did not return a redirect.");

        // The loopback receiver validates state and captures the one-time code.
        const callback = await fetch(redirect);
        expect(callback.status).toBe(200);
      },
    );

    let client = new Client(
      { name: "remote-oauth-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    let transport = new StreamableHTTPClientTransport(new URL(publicBaseUrl + "/mcp"), {
      authProvider: provider,
    });

    try {
      let authRequired: unknown;
      try {
        await client.connect(transport);
      } catch (error) {
        authRequired = error;
      }
      expect(authRequired).toBeTruthy();
      expect(provider.hasPendingAuthorization).toBe(true);

      const code = await callbackReceiver.waitForAuthorizationCode();
      await transport.finishAuth(code);
      // The SDK transport is single-start. Recreate client + transport after
      // token exchange instead of connecting the already-started instance again.
      await client.close().catch(() => undefined);
      client = new Client(
        { name: "remote-oauth-test-client", version: "1.0.0" },
        { capabilities: {} },
      );
      transport = new StreamableHTTPClientTransport(new URL(publicBaseUrl + "/mcp"), { authProvider: provider });
      await client.connect(transport);
      const result = await client.listTools();

      expect(result.tools.map((tool) => tool.name)).toContain("superagent_server_health");
      expect(provider.tokens()?.access_token).toBeTruthy();
      expect(provider.tokens()?.refresh_token).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
      await callbackReceiver.close().catch(() => undefined);
      await server.close();
    }
  }, 30000);
});
