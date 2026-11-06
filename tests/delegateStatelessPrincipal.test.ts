import { describe, expect, it } from "vitest";
import { deriveStatelessDelegatePrincipalSessionId } from "../src/core/mcp/mcpHttpTransport.js";
import {
  getDelegateMcpPrincipalId,
  runWithAuthenticatedDelegatePrincipal,
} from "../src/core/browserTransport/delegatePrincipalPolicy.js";

describe("Delegate MCP stateless principal binding", () => {
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
});
