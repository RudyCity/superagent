import type { Tool } from "./types.js";
import { lanTerminalFleet, type LanTerminalFleetAction } from "../lanRemote/terminalFleet.js";
import { isFullYoloMode, isSystemDestructiveCommand } from "../permissions.js";
import {
  closeLanSession, discoverLanDevices, execLanCommand, execAndroidShellCommand, listLanDevices,
  startLanTerminal, readLanTerminal, inputLanTerminal, stopLanTerminal,
  openLanSession, pairLanDevice, revokeLanDevice,
} from "../lanRemote/controller.js";

export const lanSupportTool: Tool = {
  name: "lan_support",
  description: "Discover, pair, and support Windows laptops or Android phones on the same private physical LAN. Pair and session require target approval and Full YOLO. Windows: bounded non-admin PowerShell. Android: read-only diagnostics (android.memory, android.network_details, android.sensors, etc.) plus owner-approved actions (android.action.open_wifi_settings, android.action.open_bluetooth_settings, android.action.volume_up/down). EVERY Android action needs a separate on-phone approval; Settings opens locally on the phone and disconnects sharing. Android sandbox shell is available through android_shell only, requiring physical approval for every command and disabled remote screen/input. No root, ADB or unattended access. Actions include terminal_start/read/input/stop and terminal_fleet_open/close/start/read/input/stop for 2–8 individually approved devices; Android fleet starts are separately approved one-shot sandbox shell commands.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["discover", "list", "pair", "open", "exec", "terminal_start", "terminal_read", "terminal_input", "terminal_stop", "terminal_fleet_open", "terminal_fleet_close", "terminal_fleet_start", "terminal_fleet_read", "terminal_fleet_input", "terminal_fleet_key", "terminal_fleet_resize", "terminal_fleet_stop", "android_shell", "close", "revoke"] },
      segment: { type: "string", description: "Required local network segment name (3-32 safe ASCII chars) for discovery; not a security credential." },
      host: { type: "string", description: "Target's verified private physical LAN IPv4." },
      port: { type: "integer", description: "Default 17845." },
      code: { type: "string", description: "Temporary 8-digit code shown on target." },
      fingerprint: { type: "string", description: "Complete SHA-256 fingerprint shown on target; never skip." },
      controller: { type: "string", description: "Name shown to the target laptop during pairing." },
      deviceId: { type: "string", description: "Opaque device handle from pairing." },
      command: { type: "string", description: "Windows PowerShell OR exact Android diagnostic/action identifier. For Android shell use action android_shell. Never send secrets." },
      jobId: { type: "string", description: "Opaque terminal task ID returned by terminal_start." },
      cursor: { type: "integer", description: "Cursor returned by terminal_read for incremental output." },
      text: { type: "string", description: "Terminal task stdin text, maximum 1024 characters. Each input requires target approval." },
      appendNewline: { type: "boolean", description: "Append a newline to terminal input." },
      targets: { type: "array", description: "2–8 distinct targets. Open/close: {deviceId}. Start: {deviceId,command}. Read: {deviceId,jobId,cursor?}. Input: {deviceId,jobId,text,appendNewline?}. Stop: {deviceId,jobId}. Each has its own approved session.", items: { type: "object" } },
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
    if (!isFullYoloMode() && !["close", "revoke", "terminal_stop", "terminal_fleet_stop", "terminal_fleet_close"].includes(action)) {
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
      if (["terminal_fleet_open", "terminal_fleet_close", "terminal_fleet_start", "terminal_fleet_read", "terminal_fleet_input", "terminal_fleet_key", "terminal_fleet_resize", "terminal_fleet_stop"].includes(action)) {
        const op = action.replace("terminal_fleet_", "") as LanTerminalFleetAction;
        return JSON.stringify(await lanTerminalFleet.execute(op, args.targets), null, 2);
      }
      if (action === "terminal_start") {
        const command = String(args.command || "");
        if (isSystemDestructiveCommand(command)) return "Denied: potentially destructive remote terminal command.";
        return JSON.stringify(await startLanTerminal(id, command), null, 2);
      }
      if (action === "terminal_read") return JSON.stringify(
        await readLanTerminal(id, String(args.jobId || ""), Number(args.cursor ?? 0)), null, 2);
      if (action === "terminal_input") {
        const input = String(args.text || "");
        if (isSystemDestructiveCommand(input)) return "Denied: potentially destructive remote terminal input.";
        return JSON.stringify(await inputLanTerminal(id, String(args.jobId || ""), input,
          args.appendNewline === true), null, 2);
      }
      if (action === "terminal_stop") return JSON.stringify(
        await stopLanTerminal(id, String(args.jobId || "")), null, 2);
      if (action === "android_shell") {
        const command = String(args.command || "");
        if (isSystemDestructiveCommand(command)) return "Denied: potentially destructive remote system command.";
        return JSON.stringify(await execAndroidShellCommand(id, command), null, 2);
      }
      if (action === "close") { await closeLanSession(id); return "Remote LAN session closed."; }
      if (action === "revoke") { await revokeLanDevice(id); return "LAN pairing revoked on remote laptop."; }
      return "Unknown LAN action.";
    } catch (error) {
      return "LAN operation rejected: " + (error instanceof Error ? error.message : "Unknown error.");
    }
  },
};
