/**
 * Persist the external MCP server's tool exposure mode independently of model
 * provider settings, which may be edited concurrently by other SuperAgent sessions.
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export type McpToolExposure = "full" | "gateway";
const FILE_NAME = "mcp-tool-exposure.json";

export function getMcpToolExposurePath(): string {
  return path.join(getRootConfigDir(), FILE_NAME);
}

export function readSavedMcpToolExposure(): McpToolExposure {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(getMcpToolExposurePath(), "utf8"));
    return typeof value === "object" && value !== null &&
      (value as Record<string, unknown>).mode === "gateway" ? "gateway" : "full";
  } catch {
    return "full";
  }
}

export function getMcpToolExposure(): { mode: McpToolExposure; source: "env" | "saved" } {
  const override = process.env.SUPERAGENT_MCP_TOOL_EXPOSURE?.trim().toLowerCase();
  if (override === "gateway" || override === "full") return { mode: override, source: "env" };
  return { mode: readSavedMcpToolExposure(), source: "saved" };
}

/**
 * Write a single small unprivileged setting. Does not restart or terminate
 * existing server/tunnel processes; new sessions pick up the saved value.
 */
export function saveMcpToolExposure(mode: McpToolExposure): void {
  if (mode !== "full" && mode !== "gateway") throw new Error("MCP tool mode must be full or gateway.");
  const target = getMcpToolExposurePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify({ mode, version: 1 }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

export function mcpToolExposureCommand(args: string[]): { success: boolean; message: string } {
  if (args.length === 0 || (args.length === 1 && args[0]?.toLowerCase() === "status")) {
    const active = getMcpToolExposure();
    return {
      success: true,
      message: `MCP tool exposure: ${active.mode} (${active.source}). Saved default: ${readSavedMcpToolExposure()}.\nUse 'mcp use gateway' or 'mcp use full' to switch for newly started MCP sessions.`,
    };
  }
  const mode = args[0]?.trim().toLowerCase();
  if (args.length !== 1 || (mode !== "full" && mode !== "gateway")) {
    return { success: false, message: "Usage: mcp use <gateway|full>\n       mcp use [status]" };
  }
  try {
    saveMcpToolExposure(mode);
    const effective = getMcpToolExposure();
    const note = effective.source === "env" && effective.mode !== mode
      ? ` An environment override currently selects '${effective.mode}'; unset SUPERAGENT_MCP_TOOL_EXPOSURE to use the saved default.` : "";
    return {
      success: true,
      message: `Saved MCP tool exposure: ${mode}. Restart/reconnect the MCP server or tunnel to apply it to new sessions; existing sessions are unchanged.${note}`,
    };
  } catch (error) {
    return { success: false, message: "Unable to save MCP tool exposure: " + (error instanceof Error ? error.message : String(error)) };
  }
}
