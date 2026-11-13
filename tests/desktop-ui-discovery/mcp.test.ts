import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS,
  DESKTOP_UI_MCP_TOOL_DEFS,
  dispatchDesktopUiMcpTool,
} from "../../src/core/mcp/tools/desktopUiMcpTools.js";
import { desktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";

const window = {
  pid: 701,
  nativeId: "70101",
  title: "Fixture Window",
  application: "FixtureApp",
  active: true,
  bounds: { x: 1, y: 2, width: 300, height: 200 },
};

function parse(result: Awaited<ReturnType<typeof dispatchDesktopUiMcpTool>>) {
  if (!result) throw new Error("missing MCP result");
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

afterEach(() => vi.restoreAllMocks());

describe("desktop discovery MCP surface", () => {
  it("keeps superagent_desktop_ui dangerous and exposes bounded discovery commands in its schema", () => {
    expect(DESKTOP_UI_MCP_TOOL_CLASSIFICATIONS.superagent_desktop_ui).toBe("dangerous");
    const schema = DESKTOP_UI_MCP_TOOL_DEFS[0].inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.command.enum).toEqual(expect.arrayContaining([
      "list_windows", "get_active_window", "find_window", "inspect_window",
    ]));
    expect(schema.properties.limit.maximum).toBe(100);
  });

  it("routes list/find/active discovery through the existing dangerous MCP tool", async () => {
    vi.spyOn(desktopUiSessionManager, "listWindows").mockResolvedValue({ windows: [window], limit: 10, truncated: false });
    vi.spyOn(desktopUiSessionManager, "findWindow").mockResolvedValue({ windows: [window], limit: 10, truncated: false });
    vi.spyOn(desktopUiSessionManager, "getActiveWindow").mockResolvedValue(window);
    const context = { principalId: "principal-a", workspace: "D:/workspace" };

    expect(parse(await dispatchDesktopUiMcpTool("superagent_desktop_ui", { command: "list_windows", limit: 10 }, context)).windows).toEqual([window]);
    expect(parse(await dispatchDesktopUiMcpTool("superagent_desktop_ui", { command: "find_window", query: "fixture", pid: 701, limit: 10 }, context)).windows).toEqual([window]);
    expect(parse(await dispatchDesktopUiMcpTool("superagent_desktop_ui", { command: "get_active_window" }, context)).window).toEqual(window);
  });

  it("binds inspect_window to the authenticated principal and explicit screenshot request", async () => {
    const inspect = vi.spyOn(desktopUiSessionManager, "inspectWindow").mockResolvedValue({
      window,
      schema: { version: 1 } as any,
    });
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "inspect_window", pid: 701, nativeId: "70101", includeScreenshotImage: true, maxImageBytes: 2048 },
      { principalId: "principal-a", workspace: "D:/workspace" },
    );
    expect(result?.isError).not.toBe(true);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      pid: 701,
      nativeId: "70101",
      ownerPrincipal: "principal-a",
      includeScreenshotImage: true,
      maxImageBytes: 2048,
    }));
  });

  it("returns an image/png MCP block for an explicitly requested screenshot", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000049454e44", "hex").toString("base64");
    const snapshot = vi.spyOn(desktopUiSessionManager, "snapshot").mockResolvedValue({
      schema: { version: 1 } as any,
      screenshotImage: png,
    });
    const context = { principalId: "principal-a", workspace: "D:/workspace" };
    const args = { command: "snapshot", sessionToken: "a".repeat(64), includeScreenshotImage: true };

    const result = await dispatchDesktopUiMcpTool("superagent_desktop_ui", args, context);
    expect(result?.isError).not.toBe(true);
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: "a".repeat(64),
      ownerPrincipal: "principal-a",
      includeScreenshotImage: true,
    }));
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect(parse(result).screenshotImage).toBe(png); // Legacy JSON readers still work.
    expect(result?.content[1]).toEqual({ type: "image", data: png, mimeType: "image/png" });
  });

  it("does not emit image blocks when screenshot bytes were omitted or invalid", async () => {
    const snapshot = vi.spyOn(desktopUiSessionManager, "snapshot");
    const context = { principalId: "principal-a", workspace: "D:/workspace" };
    snapshot.mockResolvedValueOnce({ schema: { version: 1 } as any, screenshotImageOmitted: "image exceeds limit" });
    const omitted = await dispatchDesktopUiMcpTool("superagent_desktop_ui",
      { command: "snapshot", sessionToken: "a".repeat(64), includeScreenshotImage: true, maxImageBytes: 10 }, context);
    expect(omitted?.content).toHaveLength(1);
    expect(parse(omitted).screenshotImageOmitted).toContain("limit");

    snapshot.mockResolvedValueOnce({ schema: { version: 1 } as any, screenshotImage: "not valid image!" });
    const invalid = await dispatchDesktopUiMcpTool("superagent_desktop_ui",
      { command: "snapshot", sessionToken: "a".repeat(64), includeScreenshotImage: true }, context);
    expect(invalid?.content).toHaveLength(1);
  });

  it("fails closed for remote workspaces before any discovery or inspection", async () => {
    const list = vi.spyOn(desktopUiSessionManager, "listWindows");
    const inspect = vi.spyOn(desktopUiSessionManager, "inspectWindow");
    for (const workspace of ["ssh://host/project", "chain:desktop-chain"]) {
      const result = await dispatchDesktopUiMcpTool(
        "superagent_desktop_ui",
        { command: "list_windows" },
        { principalId: "principal-a", workspace },
      );
      expect(parse(result)).toMatchObject({ success: false, code: "LOCAL_HOST_REQUIRED" });
    }
    expect(list).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects extra discovery fields and does not treat title as inspect authorization", async () => {
    const inspect = vi.spyOn(desktopUiSessionManager, "inspectWindow");
    const result = await dispatchDesktopUiMcpTool(
      "superagent_desktop_ui",
      { command: "inspect_window", pid: 701, nativeId: "70101", title: "Fixture Window" },
      { principalId: "principal-a", workspace: "D:/workspace" },
    );
    expect(parse(result)).toMatchObject({ success: false, code: "INVALID_ACTION" });
    expect(inspect).not.toHaveBeenCalled();
  });
});
