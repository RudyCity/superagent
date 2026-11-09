import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS,
  DESKTOP_UI_MCP_TOOL_DEFS,
  dispatchDesktopUiMcpTool,
} from "../../src/core/mcp/tools/desktopUiMcpTools.js";
import {
  desktopAppManager,
  desktopUiTool,
  sanitizeDesktopUiLogPayload,
} from "../../src/core/tools/desktopUiTools.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop app management tool integration", () => {
  it("exposes the commands on local and MCP tools while retaining dangerous MCP classification", () => {
    const mcpSchema = DESKTOP_UI_MCP_TOOL_DEFS[0].inputSchema as any;
    const localSchema = desktopUiTool.parameters as any;
    const expected = [
      "list_installed_apps",
      "launch_app",
      "focus_window",
      "close_app",
      "restart_app",
      "plan_package_change",
      "apply_package_change",
      "inspect_security_prompts",
    ];
    expect(mcpSchema.properties.command.enum).toEqual(expect.arrayContaining(expected));
    expect(localSchema.properties.command.enum).toEqual(expect.arrayContaining(expected));
    expect(mcpSchema.properties).not.toHaveProperty("approved");
    expect(localSchema.properties).not.toHaveProperty("approved");
    expect(DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS.superagent_desktop_ui).toBe("dangerous");
  });

  it("binds MCP package planning to the authenticated principal", async () => {
    const plan = vi.spyOn(desktopAppManager, "planPackageChange").mockResolvedValue({
      plan: { action: "install", manager: "winget", packageId: "Git.Git", destructive: false, steps: [], sideEffects: [] },
      operationDigest: "a".repeat(64),
      approvalRequestId: "approval-1",
      invocationId: "invoke-1",
      approvalExpiresAt: Date.now() + 60_000,
      approvalRequired: true,
      approvalMechanism: "separate-host-operator",
    } as any);

    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "plan_package_change", packageAction: "install", packageId: "Git.Git" },
      { principalId: "principal-a", workspace: "D:/workspace" },
    );
    expect(result?.isError).not.toBe(true);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ principalId: "principal-a", packageId: "Git.Git" }));
  });

  it("rejects model-controlled approval fields before apply routing", async () => {
    const apply = vi.spyOn(desktopAppManager, "applyPackageChange");
    const local = JSON.parse(await desktopUiTool.execute({
      command: "apply_package_change",
      approvalRequestId: "approval-1",
      operationDigest: "a".repeat(64),
      invocationId: "invoke-1",
      approved: true,
    }, "."));
    expect(local.success).toBe(false);
    expect(local.error).toMatch(/Unsupported field/);
    expect(apply).not.toHaveBeenCalled();

    const mcp = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      {
        command: "apply_package_change",
        approvalRequestId: "approval-1",
        operationDigest: "a".repeat(64),
        invocationId: "invoke-1",
        approved: true,
      },
      { principalId: "principal-a", workspace: "D:/workspace" },
    );
    expect(mcp?.isError).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("fails closed for SSH/chain before app discovery and redacts app/approval audit metadata", async () => {
    const list = vi.spyOn(desktopAppManager, "listInstalledApps");
    const remote = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "list_installed_apps", limit: 5 },
      { principalId: "principal-a", workspace: "ssh://host/work" },
    );
    expect(remote?.isError).toBe(true);
    expect(JSON.stringify(remote)).toContain("LOCAL_HOST_REQUIRED");
    expect(list).not.toHaveBeenCalled();

    const sanitized = sanitizeDesktopUiLogPayload({
      appId: "Contoso.App_abc!App",
      packageId: "Git.Git",
      version: "2.52.0",
      source: "winget",
      approvalRequestId: "approval-secret",
      invocationId: "invoke-secret",
      operationDigest: "a".repeat(64),
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("Git.Git");
    expect(serialized).not.toContain("approval-secret");
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).toContain("[REDACTED_APP_METADATA]");
    expect(serialized).toContain("[REDACTED_APPROVAL_BINDING]");
  });
});
