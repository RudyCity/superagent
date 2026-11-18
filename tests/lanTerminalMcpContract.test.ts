import { describe, expect, it } from "vitest";
import {
  LAN_MCP_TOOL_CLASSIFICATIONS, LAN_MCP_TOOL_DEFS, dispatchLanMcpTool,
} from "../src/core/mcp/tools/lanMcpTools.js";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

const deviceId = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const jobId = "e8a37bc4-9933-40a4-a09c-38ac1ad65700";

describe("Windows LAN terminal tool exposure and policy", () => {
  const definitions = new Map(LAN_MCP_TOOL_DEFS.map(item => [item.name, item]));
  it("exports agent-facing and compatibility tool names with closed schemas", () => {
    for (const suffix of ["start", "read", "input", "stop"]) {
      for (const prefix of ["superagent_lan_terminal_", "superagent_device_terminal_"]) {
        const name = prefix + suffix;
        expect(definitions.has(name), name).toBe(true);
        expect(definitions.get(name)?.inputSchema.additionalProperties, name).toBe(false);
        expect(LAN_MCP_TOOL_CLASSIFICATIONS[name], name).toBe("dangerous");
      }
    }
    expect(definitions.get("superagent_lan_terminal_start")?.inputSchema.required)
      .toEqual(["deviceId", "command"]);
    expect(definitions.get("superagent_lan_terminal_read")?.inputSchema.required)
      .toEqual(["deviceId", "jobId"]);
    expect(definitions.get("superagent_lan_terminal_input")?.inputSchema.required)
      .toEqual(["deviceId", "jobId", "text"]);
  });

  it("validates exact device and job IDs and refuses unsafe control input", () => {
    expect(parseTrayLanAction({ action: "terminal_start", deviceId, command: "echo ok" }))
      .toEqual({ action: "terminal_start", args: { action: "terminal_start", deviceId, command: "echo ok" } });
    expect(parseTrayLanAction({ action: "terminal_read", deviceId, jobId, cursor: 0 }).action).toBe("terminal_read");
    expect(parseTrayLanAction({ action: "terminal_input", deviceId, jobId, text: "hello", appendNewline: true }).action)
      .toBe("terminal_input");
    expect(parseTrayLanAction({ action: "terminal_stop", deviceId, jobId }).action).toBe("terminal_stop");
    const bad = [
      { action: "terminal_start", deviceId, command: "a".repeat(2001) },
      { action: "terminal_start", deviceId, command: "echo\u001b" },
      { action: "terminal_read", deviceId, jobId, cursor: -1 },
      { action: "terminal_read", deviceId, jobId, cursor: 1.5 },
      { action: "terminal_input", deviceId, jobId, text: "a".repeat(1025) },
      { action: "terminal_input", deviceId, jobId, text: "\u0000" },
      { action: "terminal_input", deviceId, jobId, text: "hello", sessionToken: "forbidden" },
      { action: "terminal_stop", deviceId, jobId: "invalid" },
      { action: "terminal_read", deviceId: "invalid", jobId },
    ];
    for (const request of bad) expect(() => parseTrayLanAction(request)).toThrow();
  });

  it("exposes truthful capabilities and never claims PTY", async () => {
    const reply = await dispatchLanMcpTool("superagent_device_capabilities", {});
    expect(reply?.isError).not.toBe(true);
    const data = JSON.parse((reply?.content[0] as { text: string }).text);
    expect(data.windows.pipedTerminalTasks).toBe(true);
    expect(data.windows.conpty).toBe(false);
    expect(data.windows.maxTaskSeconds).toBe(600);
  });
});
