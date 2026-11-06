import type { McpToolResult } from "../types.js";
import { isFullYoloMode } from "../../permissions.js";
import {
  closeLanSession, discoverLanDevices, execLanCommand, listLanDevices,
  openLanSession, pairLanDevice, revokeLanDevice,
} from "../../lanRemote/controller.js";

const str = (value: unknown): string => typeof value === "string" ? value : "";
const result = (value: unknown, isError = false): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
export const LAN_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_lan_discover: "safe",
  superagent_lan_list_devices: "safe",
  superagent_lan_pair: "dangerous",
  superagent_lan_session_open: "dangerous",
  superagent_lan_terminal_exec: "dangerous",
  superagent_lan_session_close: "dangerous",
  superagent_lan_revoke_device: "dangerous",
};
const id = { type: "string", description: "Controller-local LAN device handle returned by pairing (never a secret)." };
export const LAN_MCP_TOOL_DEFS = [
  {
    name: "superagent_lan_discover",
    description: "Discover SuperAgent LAN Clients on the same private IPv4 subnet and with the SAME network segment name. Segment filters discovery only; still verify fingerprint and obtain physical pairing/session approvals.",
    inputSchema: { type: "object", properties: {
      segment: { type: "string", description: "Required network segment name configured locally on the target (3-32 safe ASCII characters)." },
    }, required: ["segment"] },
  },
  {
    name: "superagent_lan_list_devices",
    description: "List paired LAN devices held in this SuperAgent process without revealing keys or pairing codes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "superagent_lan_pair",
    description: "Pair with a local Windows LAN Client using its 8-digit code and COMPLETE SHA-256 certificate fingerprint read from the target screen. User must approve pairing physically on the target. Code is never persisted.",
    inputSchema: { type: "object", properties: {
      host: { type: "string", description: "Target's private IPv4 address on the same local network." },
      port: { type: "integer", description: "Target's LAN port, default 17845." },
      code: { type: "string", description: "8-digit code displayed on the target laptop." },
      fingerprint: { type: "string", description: "64-character SHA-256 certificate fingerprint displayed on the target screen." },
      controller: { type: "string", description: "Display name for the controller on the target's approval prompt." },
    }, required: ["host", "code", "fingerprint"] },
  },
  {
    name: "superagent_lan_session_open",
    description: "Ask the physical user at a previously paired laptop to approve a new, time-limited terminal session. The device will remain offline until approved.",
    inputSchema: { type: "object", properties: { deviceId: id }, required: ["deviceId"] },
  },
  {
    name: "superagent_lan_terminal_exec",
    description: "Run a bounded command on a physically consented local LAN session. Windows: non-elevated PowerShell. Android: read-only hardware/network/memory/audio diagnostics and an exact allowlist of owner-approved actions, such as android.action.open_wifi_settings, android.action.open_bluetooth_settings, android.action.open_app_info and android.action.volume_up/down. Each action requires a NEW on-phone approval. Opening Android Settings stops sharing. No arbitrary Android shell, escalation or unattended access.",
    inputSchema: { type: "object", properties: { deviceId: id, command: { type: "string", description: "Windows PowerShell command, read-only Android diagnostic, or exact owner-approved android.action.* identifier. No secrets or arbitrary Android shell." } }, required: ["deviceId", "command"] },
  },
  {
    name: "superagent_lan_session_close",
    description: "Terminate an approved LAN terminal session. The laptop must approve another session before future commands.",
    inputSchema: { type: "object", properties: { deviceId: id }, required: ["deviceId"] },
  },
  {
    name: "superagent_lan_revoke_device",
    description: "Revoke the local paired device and all paired controllers on that remote laptop. Terminal access is stopped.",
    inputSchema: { type: "object", properties: { deviceId: id }, required: ["deviceId"] },
  },
];
export async function dispatchLanMcpTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult | null> {
  if (!(name in LAN_MCP_TOOL_CLASSIFICATIONS)) return null;
  if (LAN_MCP_TOOL_CLASSIFICATIONS[name] === "dangerous" && !isFullYoloMode()
      && !["superagent_lan_session_close", "superagent_lan_revoke_device"].includes(name)) {
    return result({ ok: false, error: "Full YOLO is required for cross-device LAN support, in addition to MCP permissions and physical target approval." }, true);
  }
  try {
    switch (name) {
      case "superagent_lan_discover": return result(await discoverLanDevices(str(args.segment)));
      case "superagent_lan_list_devices": return result(listLanDevices());
      case "superagent_lan_pair": return result(await pairLanDevice({
        host: str(args.host), port: typeof args.port === "number" ? args.port : undefined,
        code: str(args.code), fingerprint: str(args.fingerprint), controller: str(args.controller) || "SuperAgent",
      }));
      case "superagent_lan_session_open": return result(await openLanSession(str(args.deviceId)));
      case "superagent_lan_terminal_exec": return result(await execLanCommand(str(args.deviceId), str(args.command)));
      case "superagent_lan_session_close":
        await closeLanSession(str(args.deviceId)); return result({ ok: true, state: "session_closed" });
      case "superagent_lan_revoke_device":
        await revokeLanDevice(str(args.deviceId)); return result({ ok: true, state: "device_revoked" });
      default: return null;
    }
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : "LAN operation failed." }, true);
  }
}
