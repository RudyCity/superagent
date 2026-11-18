import { describe, expect, it } from "vitest";
import { describeBoundedDesktopPermission, MCP_PERMISSION_DECISION_CODES } from "../src/core/mcp/mcpPermissionDecision.js";

describe("bounded MCP permission trace never grants an action", () => {
  const allowed = { oauthAllowed:true, connectionDecision:"granted" as const,
    filePolicyActive:true, hostBlock:null };
  it("does not execute and marks native/target/project as unchecked", () => {
    const result = describeBoundedDesktopPermission(allowed);
    expect(result.decisionCode).toBe("ALLOWED_TO_ATTEMPT");
    expect(result.performedExecution).toBe(false);
    expect(result.layers).toMatchObject({nativeConsent:"not_checked",
      targetIdentity:"not_checked",projectCapability:"not_checked",hostFilePolicy:"granted"});
    expect(MCP_PERMISSION_DECISION_CODES).toContain(result.decisionCode);
  });
  it("host denial outranks a missing Execute grant; repair advice never repeats a grant", () => {
    const result = describeBoundedDesktopPermission({
      ...allowed, connectionDecision:"approval_required",
      hostBlock:"Desktop UI content not certified for host permanent file access" });
    expect(result.decisionCode).toBe("HOST_FILE_POLICY_UNCERTIFIED");
    expect(result.remediation).toMatch(/cannot override/);
    expect(result.remediation).not.toMatch(/Open Security Approval/);
  });
  it("separates argument validation from grant and corrupt-store failures", () => {
    expect(describeBoundedDesktopPermission({...allowed,
      hostBlock:"Desktop UI metadata command has unsupported arguments"})
      .decisionCode).toBe("SCHEMA_INVALID");
    expect(describeBoundedDesktopPermission({...allowed,
      connectionDecision:"unavailable"}).decisionCode).toBe("POLICY_STORE_UNAVAILABLE");
    expect(describeBoundedDesktopPermission({...allowed,
      oauthAllowed:false}).decisionCode).toBe("OAUTH_SCOPE_MISSING");
  });
  it("never reflects host text or private values into a public diagnostic", () => {
    const secret = "PATH_AND_TOKEN_DO_NOT_ECHO";
    const result = describeBoundedDesktopPermission({...allowed,
      hostBlock:"Not certified: "+secret});
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
