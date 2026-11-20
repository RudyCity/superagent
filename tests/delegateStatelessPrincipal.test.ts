import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  deriveStatelessDelegatePrincipalSessionId,
  startMcpHttpServer,
  generateMcpBearerToken,
  MCP_HTTP_PATH,
} from "../src/core/mcp/mcpHttpTransport.js";
import {
  getDelegateMcpPrincipalId,
  runWithAuthenticatedDelegatePrincipal,
} from "../src/core/browserTransport/delegatePrincipalPolicy.js";
import {
  generateDelegateForwardedChannelMaterial,
  installDelegateForwardedSigner,
} from "../src/core/browserTransport/delegateForwardedPrincipal.js";
import { registerProject, removeProject } from "../src/core/project/projectRegistry.js";
import { grantProjectAccess, revokeAllProjectAccess } from "../src/core/project/projectAccessPolicy.js";

describe("Delegate MCP stateless and reconnect principal binding", () => {
  const identity = {
    mode: "oauth" as const,
    subject: "chatgpt-client",
    scopes: ["mcp:tools", "mcp:tools:write"],
    credentialHash: "a".repeat(64),
  };

  it("keeps the same Delegate actor across stateless calls using the same verified credential", () => {
    const firstSession = deriveStatelessDelegatePrincipalSessionId(identity);
    const secondSession = deriveStatelessDelegatePrincipalSessionId({ ...identity });
    expect(firstSession).toBe(secondSession);
    expect(firstSession).toMatch(/^stateless-[a-f0-9]{64}$/);

    const firstActor = runWithAuthenticatedDelegatePrincipal({
      sessionId: firstSession, mode: identity.mode, subject: identity.subject,
    }, () => getDelegateMcpPrincipalId());
    const secondActor = runWithAuthenticatedDelegatePrincipal({
      sessionId: secondSession, mode: identity.mode, subject: identity.subject,
    }, () => getDelegateMcpPrincipalId());
    expect(secondActor).toBe(firstActor);
  });

  it("separates different credentials and authentication identities", () => {
    const baseline = deriveStatelessDelegatePrincipalSessionId(identity);
    const sameSubjectNewCredential = deriveStatelessDelegatePrincipalSessionId({
      ...identity, credentialHash: "b".repeat(64),
    });
    const differentSubject = deriveStatelessDelegatePrincipalSessionId({
      ...identity, subject: "another-client",
    });
    const staticBearer = deriveStatelessDelegatePrincipalSessionId({
      ...identity, mode: "static-bearer", subject: "bearer",
    });
    expect(sameSubjectNewCredential).not.toBe(baseline);
    expect(differentSubject).not.toBe(baseline);
    expect(staticBearer).not.toBe(baseline);
  });

  it("retains the exact same forwarded Delegate principalId when a Streamable HTTP client reconnects", async () => {
    try {
      installDelegateForwardedSigner(generateDelegateForwardedChannelMaterial());
    } catch {
      // Signer may already be installed in this test worker.
    }

    const token = generateMcpBearerToken();
    const credentialHash = crypto.createHash("sha256").update(token).digest("hex");
    const testProjectId = "delegate-reconnect-test-" + crypto.randomUUID().slice(0, 8);
    registerProject({
      id: testProjectId,
      name: "Delegate Reconnect Test",
      type: "local",
      root: process.cwd(),
      enabled: true,
    });
    grantProjectAccess(
      { mode: "static-bearer", subject: "bearer", credentialHash },
      testProjectId,
      ["execute"],
    );

    const forwardedPrincipals: string[] = [];
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/delegate/mcp-dispatch")) {
        const parsed = JSON.parse(String(init?.body || "{}"));
        if (typeof parsed?.attestation?.principalId === "string") {
          forwardedPrincipals.push(parsed.attestation.principalId);
        }
        return new Response(JSON.stringify({ success: true, result: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return realFetch(input as any, init);
    });

    const server = await startMcpHttpServer({
      port: 0,
      bearerToken: token,
      allowDangerous: true,
      toolExposure: "gateway",
    });
    const endpoint = `http://127.0.0.1:${server.port}${MCP_HTTP_PATH}`;
    const headers = (sid?: string): Record<string, string> => ({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sid ? { "mcp-session-id": sid } : {}),
    });

    const initializeSession = async (id: number): Promise<string> => {
      const res = await realFetch(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reconnect-test", version: "1.0" } },
        }),
      });
      await res.text();
      return res.headers.get("mcp-session-id")!;
    };

    try {
      const sid1 = await initializeSession(1);
      expect(sid1).toBeTruthy();

      const call1 = await realFetch(endpoint, {
        method: "POST",
        headers: headers(sid1),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "superagent_chrome_cdp_web",
            arguments: {
              command: "claim_target",
              transport: "delegate",
              delegateClientId: "profileReconnect123",
              targetId: "delegate:profileReconnect123:42",
            },
          },
        }),
      });
      expect(call1.status).toBe(200);
      await call1.text();

      const del1 = await realFetch(endpoint, { method: "DELETE", headers: headers(sid1) });
      expect(del1.status).toBe(200);
      await del1.text();

      const sid2 = await initializeSession(3);
      expect(sid2).toBeTruthy();
      expect(sid2).not.toBe(sid1);

      const call2 = await realFetch(endpoint, {
        method: "POST",
        headers: headers(sid2),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "superagent_chrome_cdp_web",
            arguments: {
              command: "release_target",
              transport: "delegate",
              delegateClientId: "profileReconnect123",
              targetId: "delegate:profileReconnect123:42",
              sessionToken: "valid-lease-capability-token-1234",
            },
          },
        }),
      });
      expect(call2.status).toBe(200);
      await call2.text();

      expect(forwardedPrincipals).toHaveLength(2);
      expect(forwardedPrincipals[0]).toMatch(/^mcp-[a-f0-9]{32}$/);
      expect(forwardedPrincipals[1]).toBe(forwardedPrincipals[0]);

      const expectedSession = deriveStatelessDelegatePrincipalSessionId({
        mode: "static-bearer",
        subject: "bearer",
        scopes: [],
        credentialHash,
      });
      const expectedActor = runWithAuthenticatedDelegatePrincipal(
        { sessionId: expectedSession, mode: "static-bearer", subject: "bearer" },
        () => getDelegateMcpPrincipalId()!,
      );
      expect(forwardedPrincipals[0]).toBe(expectedActor);
    } finally {
      fetchSpy.mockRestore();
      await server.close();
      revokeAllProjectAccess(testProjectId);
      removeProject(testProjectId);
    }
  }, 30000);
});
