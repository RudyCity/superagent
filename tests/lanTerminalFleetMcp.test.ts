import { describe, expect, it } from "vitest";
import {
  LAN_MCP_TOOL_CLASSIFICATIONS, LAN_MCP_TOOL_DEFS, dispatchLanMcpTool,
} from "../src/core/mcp/tools/lanMcpTools.js";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const jA = "aaaa1111-1111-4111-8111-111111111111";
const jB = "bbbb2222-2222-4222-8222-222222222222";

describe("Terminal fleet MCP and Core API contracts", () => {
  const defs = new Map(LAN_MCP_TOOL_DEFS.map(tool => [tool.name, tool]));
  it("exposes all six parallel tools and modern device aliases as dangerous", () => {
    for (const action of ["open", "close", "start", "read", "input", "stop"]) {
      for (const prefix of ["superagent_lan_terminal_fleet_", "superagent_device_terminal_fleet_"]) {
        const name = prefix + action;
        expect(defs.has(name), name).toBe(true);
        expect(LAN_MCP_TOOL_CLASSIFICATIONS[name], name).toBe("dangerous");
        const schema = defs.get(name)?.inputSchema;
        expect(schema?.additionalProperties).toBe(false);
        expect(schema?.required).toEqual(["targets"]);
        const targets = schema?.properties?.targets as Record<string, unknown>;
        expect(targets.type).toBe("array");
        expect(targets.minItems).toBe(2);
        expect(targets.maxItems).toBe(8);
        expect((targets.items as Record<string, unknown>).additionalProperties).toBe(false);
      }
    }
  });

  it("permits only expected Core action names and top-level target arrays", () => {
    const targets = [{ deviceId: a, command: "Get-Date" }, { deviceId: b, command: "Get-Date" }];
    expect(parseTrayLanAction({ action: "terminal_fleet_open",
      targets: [{ deviceId: a }, { deviceId: b }],
    }).action).toBe("terminal_fleet_open");
    expect(parseTrayLanAction({ action: "terminal_fleet_close",
      targets: [{ deviceId: a }, { deviceId: b }],
    }).action).toBe("terminal_fleet_close");
    expect(parseTrayLanAction({ action: "terminal_fleet_start", targets }).action)
      .toBe("terminal_fleet_start");
    expect(parseTrayLanAction({
      action: "terminal_fleet_read",
      targets: [{ deviceId: a, jobId: jA, cursor: 0 }, { deviceId: b, jobId: jB, cursor: 1 }],
    }).action).toBe("terminal_fleet_read");
    expect(parseTrayLanAction({
      action: "terminal_fleet_input",
      targets: [{ deviceId: a, jobId: jA, text: "A" }, { deviceId: b, jobId: jB, text: "B" }],
    }).action).toBe("terminal_fleet_input");
    expect(parseTrayLanAction({
      action: "terminal_fleet_stop",
      targets: [{ deviceId: a, jobId: jA }, { deviceId: b, jobId: jB }],
    }).action).toBe("terminal_fleet_stop");
    expect(() => parseTrayLanAction({
      action: "terminal_fleet_start", targets, sessionToken: "secret",
    })).toThrow(/Unexpected/);
    expect(() => parseTrayLanAction({ action: "terminal_fleet_start", targets: [] }))
      .toThrow(/2–8/);
    expect(() => parseTrayLanAction({ action: "terminal_fleet_start", targets: "invalid" }))
      .toThrow(/2–8/);
  });

  it("advertises exact cross-platform fleet support without granting new terminal privileges", async () => {
    const reply = await dispatchLanMcpTool("superagent_device_capabilities", {});
    expect(reply?.isError).not.toBe(true);
    const data = JSON.parse((reply?.content[0] as { text: string }).text);
    expect(data.terminalFleet).toMatchObject({
      parallel: true, maxDevices: 8, distinctSessionPerDevice: true,
      parallelSessionApproval: true, emergencyDeviceSessionClose: true,
      windowsPipedJobs: true, androidOwnerApprovedSingleCommand: true,
      parallelSessionApproval: true, emergencyDeviceSessionClose: true,
      automaticPairing: false,
    });
    expect(data.windows.conpty).toBe(true);
    expect(data.windows.conptyRequiresBun).toBe(true);
    expect(data.android.ownerApprovedSandboxShell.remoteInputDisabled).toBe(true);
  });
});
