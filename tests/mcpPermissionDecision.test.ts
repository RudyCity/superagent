import { describe, expect, it } from "vitest";
import {
  describeBoundedBrowserObservePermission,
  describeBoundedDesktopPermission,
  describeBoundedServiceManagePermission,
  describeBoundedServicePermission,
  MCP_PERMISSION_DECISION_CODES,
} from "../src/core/mcp/mcpPermissionDecision.js";

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
  it("preflights read-only service status without granting MCP Execute or leaking paths", () => {
    const allowed=describeBoundedServicePermission({action:"owner_status",service:"tray"},true);
    expect(allowed.decisionCode).toBe("ALLOWED_TO_ATTEMPT");
    expect(allowed.layers).toMatchObject({connectionExecute:"not_checked",
      hostFilePolicy:"granted",nativeConsent:"not_checked"});
    expect(allowed.performedExecution).toBe(false);
    for (const args of [
      {action:"restart",service:"tray",confirm:true},
      {action:"status",expectedExecutablePath:"PRIVATE_PATH"},
      {action:"owner_status",port:1},
      {action:"owner_status",service:"not-a-service"},
      {action:"owner_status",limit:1.3},
    ]) {
      const denied=describeBoundedServicePermission(args,true);
      expect(denied.decisionCode).toBe("SCHEMA_INVALID");
      expect(JSON.stringify(denied)).not.toContain("PRIVATE_PATH");
    }
  });
  it("never reflects host text or private values into a public diagnostic", () => {
    const secret = "PATH_AND_TOKEN_DO_NOT_ECHO";
    const result = describeBoundedDesktopPermission({...allowed,
      hostBlock:"Not certified: "+secret});
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("provides structured machine-readable remediationAction and supports bounded service-manage and browser-observe preflight", () => {
    const missingGrant = describeBoundedDesktopPermission({
      ...allowed, connectionDecision: "approval_required",
    });
    expect(missingGrant.remediationAction).toMatchObject({
      kind: "open_tray_section",
      trayPage: "security",
      trayTab: "connections",
      projectId: "mcp-connection",
      requiredCapability: "execute",
      retryableAfterGrant: true,
    });

    const badFields = describeBoundedDesktopPermission({
      ...allowed,
      hostBlock: "Desktop UI metadata command has unsupported arguments",
      supportedFields: ["command", "action"],
    });
    expect(badFields.decisionCode).toBe("SCHEMA_INVALID");
    expect(badFields.remediationAction).toMatchObject({
      kind: "fix_arguments",
      supportedFields: ["command", "action"],
      retryableWithMcpGrant: false,
    });

    const manageRead = describeBoundedServiceManagePermission({
      args: { action: "owner_status", service: "tray" },
      oauthAllowed: true,
      connectionDecision: "granted",
      filePolicyActive: true,
      hostBlock: null,
    });
    expect(manageRead.decisionCode).toBe("ALLOWED_TO_ATTEMPT");
    expect(manageRead.remediationAction).toMatchObject({ kind: "none", advisoryOnly: true });

    const manageMutate = describeBoundedServiceManagePermission({
      args: { action: "restart", service: "tray", confirm: true },
      oauthAllowed: true,
      connectionDecision: "granted",
      filePolicyActive: true,
      hostBlock: "Tool is not certified for permanent file access restrictions.",
    });
    expect(manageMutate.decisionCode).toBe("HOST_FILE_POLICY_UNCERTIFIED");
    expect(manageMutate.remediationAction).toMatchObject({
      kind: "host_policy_blocked",
      retryableWithMcpGrant: false,
    });

    const browserOk = describeBoundedBrowserObservePermission(
      { command: "list_targets", transport: "delegate", delegateClientId: "client_1234" },
      true,
      true,
    );
    expect(browserOk.decisionCode).toBe("ALLOWED_TO_ATTEMPT");

    const browserBad = describeBoundedBrowserObservePermission(
      { command: "navigate", transport: "delegate", url: "https://example.com" },
      true,
      true,
    );
    expect(browserBad.decisionCode).toBe("SCHEMA_INVALID");
    expect(browserBad.remediationAction).toMatchObject({
      kind: "fix_arguments",
      supportedActions: ["list_targets", "transport_status"],
    });
  });
});
