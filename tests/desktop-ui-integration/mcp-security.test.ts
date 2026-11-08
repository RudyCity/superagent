import { afterEach, describe, expect, it, vi } from "vitest";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS,
  dispatchDesktopUiMcpTool,
} from "../../src/core/mcp/tools/desktopUiMcpTools.js";
import {
  MCP_TOOL_CLASSIFICATION,
  getToolSecuritySchemes,
} from "../../src/core/mcp/mcpToolPolicy.js";
import { createSuperagentMcpServer } from "../../src/core/mcp/superagentMcpServer.js";
import {
  desktopUiSessionManager,
  sanitizeDesktopUiLogPayload,
  sanitizeDesktopUiLogText,
} from "../../src/core/tools/desktopUiTools.js";
import { setFullYoloMode, setYoloMode } from "../../src/core/permissions.js";

afterEach(() => {
  vi.restoreAllMocks();
  setFullYoloMode(false);
  setYoloMode(false);
});

describe("desktop UI MCP security integration", () => {
  it("is dangerous, requires OAuth write scope, and is hidden from safe-only owners", async () => {
    expect(DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS.superagent_desktop_ui).toBe("dangerous");
    expect(MCP_TOOL_CLASSIFICATION.superagent_desktop_ui).toBe("dangerous");
    expect(getToolSecuritySchemes("superagent_desktop_ui", "oauth")).toEqual([
      { type: "oauth2", scopes: ["mcp:tools", "mcp:tools:write"] },
    ]);

    const server = createSuperagentMcpServer({
      toolExposure: "full",
      lockSafeTools: true,
      allowedTools: ["superagent_server_health", "superagent_desktop_ui"],
    });
    const list = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const names = (await list({ method: "tools/list", params: {} })).tools.map((tool: any) => tool.name);
    expect(names).toContain("superagent_server_health");
    expect(names).not.toContain("superagent_desktop_ui");
  });

  it("does not let OAuth read scope invoke the dangerous desktop tool", async () => {
    setYoloMode(true);
    const server = createSuperagentMcpServer({
      toolExposure: "full",
      allowDangerous: true,
      authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "reader", scopes: ["mcp:tools"] }),
    });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    await expect(call({
      method: "tools/call",
      params: { name: "superagent_desktop_ui", arguments: { command: "probe" } },
    })).rejects.toThrow(/mcp:tools:write/);
  });

  it("requires a principal and rejects SSH/chain workspace execution before host dispatch", async () => {
    const unauthenticated = await dispatchDesktopUiMcpTool("superagent_desktop_ui", { command: "probe" });
    expect(unauthenticated?.isError).toBe(true);
    expect(JSON.stringify(unauthenticated)).toContain("AUTH_REQUIRED");

    const remote = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "probe" },
      { principalId: "principal-a", workspace: "ssh://host/project" },
    );
    expect(remote?.isError).toBe(true);
    expect(JSON.stringify(remote)).toContain("LOCAL_HOST_REQUIRED");
  });

  it("routes command='action' with action='click' and binds owner principal", async () => {
    const action = vi.spyOn(desktopUiSessionManager, "action").mockResolvedValue({ dispatched: true } as any);
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      {
        command: "action",
        action: "click",
        sessionToken: "a".repeat(64),
        expectedRevision: 1,
        expectedHash: "b".repeat(64),
        elementId: "a1",
      },
      { principalId: "principal-a", workspace: "D:/workspace" },
    );

    expect(result?.isError).not.toBe(true);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      action: "click",
      ownerPrincipal: "principal-a",
      sessionToken: "a".repeat(64),
    }));
  });

  it("rejects raw coordinates including hidden aliases before action routing", async () => {
    const action = vi.spyOn(desktopUiSessionManager, "action");
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      {
        command: "action",
        action: "click",
        sessionToken: "a".repeat(64),
        expectedRevision: 1,
        expectedHash: "b".repeat(64),
        elementId: "a1",
        screenX: 100,
      },
      { principalId: "principal-a", workspace: "D:/workspace" },
    );
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Raw coordinate field");
    expect(action).not.toHaveBeenCalled();
  });

  it("redacts session tokens, typed text and screenshot/image payloads in args and output text", () => {
    const token = "a".repeat(64);
    const payload = sanitizeDesktopUiLogPayload({
      sessionToken: token,
      text: "secret typed text",
      nested: {
        screenshotImage: "iVBORw0KGgoSECRET",
        image_base64: "iVBORw0KGgoMORE",
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("secret typed text");
    expect(serialized).not.toContain("iVBORw0KGgoSECRET");
    expect(serialized).toContain("[REDACTED_TOKEN]");
    expect(serialized).toContain("[REDACTED_TEXT]");
    expect(serialized).toContain("[IMAGE_BYTES]");

    const text = sanitizeDesktopUiLogText(JSON.stringify({
      sessionToken: token,
      text: "secret typed text",
      screenshotImage: "iVBORw0KGgoSECRET",
    }))!;
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret typed text");
    expect(text).not.toContain("iVBORw0KGgoSECRET");
  });

  it("sanitizes desktop args before the server audit hook sees them", async () => {
    setYoloMode(true);
    const observed: any[] = [];
    const server = createSuperagentMcpServer({
      toolExposure: "full",
      allowDangerous: true,
      authMode: "static-bearer",
      getIdentity: () => ({ mode: "static-bearer", subject: "tester", credentialHash: "credential-hash" }),
      onToolCall: (info) => observed.push(info),
    });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const token = "a".repeat(64);
    const result = await call({
      method: "tools/call",
      params: {
        name: "superagent_desktop_ui",
        arguments: {
          command: "action",
          action: "type",
          sessionToken: token,
          expectedRevision: 1,
          expectedHash: "b".repeat(64),
          elementId: "a1",
          text: "DO_NOT_LOG_ME",
          x: 10,
        },
      },
    });
    expect(result.isError).toBe(true);
    const audit = JSON.stringify(observed.at(-1)?.args);
    expect(audit).not.toContain(token);
    expect(audit).not.toContain("DO_NOT_LOG_ME");
    expect(audit).toContain("[REDACTED_TOKEN]");
    expect(audit).toContain("[REDACTED_TEXT]");
  });
});
