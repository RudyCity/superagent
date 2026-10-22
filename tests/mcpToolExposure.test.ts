import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMcpToolExposure,
  getMcpToolExposurePath,
  mcpToolExposureCommand,
  readSavedMcpToolExposure,
} from "../src/core/mcp/mcpToolExposure.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { MCP_GATEWAY_TOOL_NAMES } from "../src/core/mcp/mcpToolGateway.js";
import { mcpCommand } from "../src/core/commands/mcpCommand.js";
import { getDashboardSuggestions } from "../src/utils/dashboardSuggestions.js";

let tempDir: string;
let priorConfigDir: string | undefined;
let priorOverride: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-exposure-use-"));
  priorConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  priorOverride = process.env.SUPERAGENT_MCP_TOOL_EXPOSURE;
  process.env.SUPERAGENT_CONFIG_DIR = tempDir;
  delete process.env.SUPERAGENT_MCP_TOOL_EXPOSURE;
});

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = priorConfigDir;
  if (priorOverride === undefined) delete process.env.SUPERAGENT_MCP_TOOL_EXPOSURE;
  else process.env.SUPERAGENT_MCP_TOOL_EXPOSURE = priorOverride;
  fs.rmSync(tempDir, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe("mcp use gateway/full", () => {
  it("defaults to full, persists mode in config root and accepts status", () => {
    expect(readSavedMcpToolExposure()).toBe("full");
    expect(mcpToolExposureCommand(["gateway"]).success).toBe(true);
    expect(readSavedMcpToolExposure()).toBe("gateway");
    expect(JSON.parse(fs.readFileSync(getMcpToolExposurePath(), "utf8"))).toEqual({ mode: "gateway", version: 1 });
    expect(mcpToolExposureCommand(["status"]).message).toContain("gateway");
    expect(mcpToolExposureCommand(["full"]).success).toBe(true);
    expect(readSavedMcpToolExposure()).toBe("full");
    expect(fs.readdirSync(tempDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("rejects invalid modes without changing saved configuration", () => {
    mcpToolExposureCommand(["gateway"]);
    expect(mcpToolExposureCommand(["unknown"]).success).toBe(false);
    expect(mcpToolExposureCommand(["gateway", "extra"]).success).toBe(false);
    expect(readSavedMcpToolExposure()).toBe("gateway");
  });

  it("preserves env override precedence and warns about a mismatch", () => {
    process.env.SUPERAGENT_MCP_TOOL_EXPOSURE = "full";
    const result = mcpToolExposureCommand(["gateway"]);
    expect(result.success).toBe(true);
    expect(result.message).toContain("environment override");
    expect(getMcpToolExposure()).toEqual({ mode: "full", source: "env" });
    delete process.env.SUPERAGENT_MCP_TOOL_EXPOSURE;
    expect(getMcpToolExposure()).toEqual({ mode: "gateway", source: "saved" });
  });

  it("applies selected saved mode to newly initialized MCP sessions", async () => {
    const listHandler = async (mode: "gateway" | "full") => {
      mcpToolExposureCommand([mode]);
      const server = createSuperagentMcpServer();
      try {
        const handler = (server as any)._requestHandlers.get("tools/list");
        return (await handler({ method: "tools/list", params: {} })).tools.map((tool: any) => tool.name) as string[];
      } finally {
        await server.close();
      }
    };
    const gateway = await listHandler("gateway");
    expect(gateway).toContain(MCP_GATEWAY_TOOL_NAMES.search);
    expect(gateway).not.toContain("superagent_get_workspace");
    const full = await listHandler("full");
    expect(full).toContain("superagent_get_workspace");
  });

  it("runs the interactive /mcp use command and supplies suggestions", async () => {
    const lines: Array<{ type: string; content: string }> = [];
    const ctx = { addLine: (line: { type: string; content: string }) => lines.push(line) };
    await mcpCommand.execute("use gateway", ctx as any);
    expect(lines.at(-1)?.content).toContain("Saved MCP tool exposure: gateway");
    await mcpCommand.execute("use status", ctx as any);
    expect(lines.at(-1)?.content).toContain("gateway");
    await mcpCommand.execute("use invalid", ctx as any);
    expect(lines.at(-1)?.type).toBe("error");
    expect(getDashboardSuggestions("/mcp use", "/mcp use".length)).toContain("/mcp use gateway");
    expect(getDashboardSuggestions("/mcp use", "/mcp use".length)).toContain("/mcp use full");
  });

  it("routes the standalone superagent mcp use command", async () => {
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => messages.push(message));
    vi.spyOn(process, "exit").mockImplementation(((status: number) => { throw new Error("exit:" + status); }) as never);
    const { handleMcpCliCommand } = await import("../src/core/commands/mcpCliHandler.js");
    await expect(handleMcpCliCommand(["use", "gateway"])).rejects.toThrow("exit:0");
    expect(messages.join(" ")).toContain("Saved MCP tool exposure: gateway");
    expect(readSavedMcpToolExposure()).toBe("gateway");
  });
});
