import { describe, expect, it } from "vitest";
import {
  LAN_MCP_TOOL_CLASSIFICATIONS,
  LAN_MCP_TOOL_DEFS,
  dispatchLanMcpTool,
} from "../src/core/mcp/tools/lanMcpTools.js";

describe("LAN Device MCP first-class surface", () => {
  const byName = new Map(LAN_MCP_TOOL_DEFS.map((definition) => [definition.name, definition]));

  it("exposes a complete CDP-like device workflow without raw exec_command", () => {
    for (const name of [
      "superagent_lan_discover",
      "superagent_lan_list_devices",
      "superagent_lan_capabilities",
      "superagent_device_tunnel_list",
      "superagent_device_tunnel_pair_request",
      "superagent_device_tunnel_revoke",
      "superagent_lan_pair_request",
      "superagent_lan_pair_cancel",
      "superagent_lan_pair",
      "superagent_lan_session_open",
      "superagent_lan_device_exec",
      "superagent_lan_android_diagnostic",
      "superagent_lan_android_ui_schema",
      "superagent_lan_android_ui_click",
      "superagent_lan_android_screen",
      "superagent_lan_android_input",
      "superagent_lan_file_offer",
      "superagent_lan_file_put",
      "superagent_lan_file_get",
      "superagent_lan_file_finish",
      "superagent_lan_file_abort",
      "superagent_lan_session_close",
      "superagent_lan_revoke_device",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.has("superagent_lan_terminal_exec")).toBe(true);
    for (const name of [
      "superagent_device_list",
      "superagent_device_capabilities",
      "superagent_device_pair_status",
      "superagent_device_pair_cancel",
      "superagent_device_session_open",
      "superagent_device_exec",
      "superagent_device_android_diagnostic",
      "superagent_device_android_ui_schema",
      "superagent_device_android_ui_click",
      "superagent_device_android_screen",
      "superagent_device_android_input",
      "superagent_device_file_offer",
      "superagent_device_file_put",
      "superagent_device_file_get",
      "superagent_device_file_finish",
      "superagent_device_file_abort",
      "superagent_device_session_close",
      "superagent_device_revoke",
    ]) expect(byName.has(name), name).toBe(true);
  });

  it("closes every MCP input schema and supports routed target discovery", () => {
    for (const definition of LAN_MCP_TOOL_DEFS) {
      expect(definition.inputSchema.additionalProperties, definition.name).toBe(false);
    }
    const discover: any = byName.get("superagent_lan_discover");
    expect(discover.inputSchema.required).toEqual(["segment"]);
    expect(discover.inputSchema.properties.targetIp).toBeTruthy();
    expect(discover.inputSchema.properties.waitMs.maximum).toBe(5000);

    const tunnelPairRequest: any = byName.get("superagent_device_tunnel_pair_request");
    expect(tunnelPairRequest.inputSchema.required).toEqual(["tunnelId", "fingerprint"]);
    expect(tunnelPairRequest.inputSchema.properties).not.toHaveProperty("code");
    const pairRequest: any = byName.get("superagent_lan_pair_request");
    expect(pairRequest.inputSchema.required).toEqual(["host", "fingerprint"]);
    expect(pairRequest.inputSchema.properties).not.toHaveProperty("code");
    expect(pairRequest.inputSchema.properties.segment).toBeTruthy();
    const pair: any = byName.get("superagent_lan_pair");
    expect(pair.inputSchema.properties.fingerprint.pattern).toContain("64");
  });

  it("keeps observation safe and remote content/control dangerous", () => {
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_discover).toBe("safe");
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_list_devices).toBe("safe");
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_capabilities).toBe("safe");
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_pair_status).toBe("safe");
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_device_tunnel_list).toBe("safe");
    for (const name of [
      "superagent_device_tunnel_pair_request",
      "superagent_lan_pair_request",
      "superagent_lan_pair_cancel",
      "superagent_lan_pair",
      "superagent_lan_session_open",
      "superagent_lan_device_exec",
      "superagent_lan_android_diagnostic",
      "superagent_lan_android_ui_schema",
      "superagent_lan_android_screen",
      "superagent_lan_android_input",
      "superagent_lan_file_offer",
    ]) {
      expect(LAN_MCP_TOOL_CLASSIFICATIONS[name], name).toBe("dangerous");
    }
  });

  it("reports capabilities without contacting the remote target", async () => {
    const response = await dispatchLanMcpTool("superagent_lan_capabilities", {});
    expect(response?.isError).not.toBe(true);
    const payload = JSON.parse((response?.content[0] as any).text);
    expect(payload.transports).toEqual({ lan: true, reverseHttpsTunnel: true });
    expect(payload.workflow).toEqual([
      "discover_or_tunnel_list", "pair_request", "local_pair_complete", "pair_status",
      "session_open", "inspect_or_interact", "session_close_or_revoke",
    ]);
    expect(payload.android.uiSchema).toBe(true);
    expect(payload.android.screenFrame).toBe(true);
    expect(payload.files.maxBytes).toBe(4 * 1024 * 1024);
    const aliasResponse = await dispatchLanMcpTool("superagent_device_capabilities", {});
    expect(aliasResponse?.isError).not.toBe(true);
    const aliasPayload = JSON.parse((aliasResponse?.content[0] as any).text);
    expect(aliasPayload.transports).toEqual({ lan: true, reverseHttpsTunnel: true });
  });
});
