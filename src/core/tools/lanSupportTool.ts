import type { Tool } from "./types.js";
import { isFullYoloMode, isSystemDestructiveCommand } from "../permissions.js";
import {
  closeLanSession, discoverLanDevices, execLanCommand, listLanDevices,
  openLanSession, pairLanDevice, revokeLanDevice,
} from "../lanRemote/controller.js";

export const lanSupportTool: Tool = {
  name: "lan_support",
  description: "Discover, pair, and support Windows laptops or Android phones on the same private physical LAN. Pair and session require target approval and Full YOLO. Windows: bounded non-admin PowerShell. Android: read-only diagnostics (android.memory, android.network_details, android.sensors, etc.) plus owner-approved actions (android.action.open_wifi_settings, android.action.open_bluetooth_settings, android.action.volume_up/down). EVERY Android action needs a separate on-phone approval; Settings opens locally on the phone and disconnects sharing. No root, ADB, general Android shell or unattended access. Actions: discover, list, pair, open, exec, close, revoke.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["discover", "list", "pair", "open", "exec", "close", "revoke"] },
      segment: { type: "string", description: "Required local network segment name (3-32 safe ASCII chars) for discovery; not a security credential." },
      host: { type: "string", description: "Target's verified private physical LAN IPv4." },
      port: { type: "integer", description: "Default 17845." },
      code: { type: "string", description: "Temporary 8-digit code shown on target." },
      fingerprint: { type: "string", description: "Complete SHA-256 fingerprint shown on target; never skip." },
      controller: { type: "string", description: "Name shown to the target laptop during pairing." },
      deviceId: { type: "string", description: "Opaque device handle from pairing." },
      command: { type: "string", description: "Windows PowerShell OR exact Android diagnostic/action identifier. Android actions require explicit per-action target consent; opening Settings disconnects the Android client. Never send secrets." },
    },
    required: ["action"],
  },
  execute: async (args, _cwd, signal) => {
    if (signal?.aborted) return "LAN operation cancelled.";
    const action = String(args.action || "");
    if (action === "discover") {
      try { return JSON.stringify(await discoverLanDevices(String(args.segment || "")), null, 2); }
      catch (error) { return "Network segment discovery rejected: " + (error instanceof Error ? error.message : "Invalid segment"); }
    }
    if (action === "list") return JSON.stringify(listLanDevices(), null, 2);
    if (!isFullYoloMode() && !["close", "revoke"].includes(action)) {
      return "Remote LAN support mutation denied: enable Full YOLO locally and obtain target approval.";
    };
    if (signal?.aborted) return "LAN operation cancelled.";
    try {
      if (action === "pair") return JSON.stringify(await pairLanDevice({
        host: String(args.host || ""), port: typeof args.port === "number" ? args.port : undefined,
        code: String(args.code || ""), fingerprint: String(args.fingerprint || ""),
        controller: String(args.controller || "SuperAgent"),
      }), null, 2);
      const id = String(args.deviceId || "");
      if (action === "open") return JSON.stringify(await openLanSession(id), null, 2);
      if (action === "exec") {
        const command = String(args.command || "");
        if (isSystemDestructiveCommand(command)) return "Denied: potentially destructive remote system command.";
        return JSON.stringify(await execLanCommand(id, command), null, 2);
      }
      if (action === "close") { await closeLanSession(id); return "Remote LAN session closed."; }
      if (action === "revoke") { await revokeLanDevice(id); return "LAN pairing revoked on remote laptop."; }
      return "Unknown LAN action.";
    } catch (error) {
      return "LAN operation rejected: " + (error instanceof Error ? error.message : "Unknown error.");
    }
  },
};
