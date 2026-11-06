import type { McpToolResult } from "../types.js";
import { isFullYoloMode } from "../../permissions.js";
import { callServerApi } from "./processTools.js";
import {
  ANDROID_APPROVED_ACTIONS, ANDROID_READONLY_DIAGNOSTICS,
} from "../../lanRemote/androidCapabilities.js";

const str = (value: unknown): string => typeof value === "string" ? value : "";
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
const result = (value: unknown, isError = false): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const deviceId = {
  type: "string",
  pattern: "^[a-fA-F0-9-]{36}$",
  description: "Controller-local opaque LAN device handle returned by pairing. It is not a credential.",
};
const transferId = {
  type: "string",
  pattern: "^[a-fA-F0-9-]{36}$",
  description: "Opaque file-transfer handle returned by superagent_lan_file_offer.",
};
const closed = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const LAN_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_lan_discover: "safe",
  superagent_lan_list_devices: "safe",
  superagent_lan_capabilities: "safe",
  superagent_lan_pair_request: "dangerous",
  superagent_lan_pair_status: "safe",
  superagent_lan_pair_cancel: "dangerous",
  superagent_lan_pair: "dangerous",
  superagent_lan_session_open: "dangerous",
  superagent_lan_device_exec: "dangerous",
  superagent_lan_terminal_exec: "dangerous", // compatibility alias
  superagent_lan_android_diagnostic: "dangerous",
  superagent_lan_android_ui_schema: "dangerous",
  superagent_lan_android_ui_click: "dangerous",
  superagent_lan_android_screen: "dangerous",
  superagent_lan_android_input: "dangerous",
  superagent_lan_file_offer: "dangerous",
  superagent_lan_file_put: "dangerous",
  superagent_lan_file_get: "dangerous",
  superagent_lan_file_finish: "dangerous",
  superagent_lan_file_abort: "dangerous",
  superagent_lan_session_close: "dangerous",
  superagent_lan_revoke_device: "dangerous",
};

export const LAN_MCP_TOOL_DEFS = [
  {
    name: "superagent_lan_discover",
    description: "Discover SuperAgent LAN Device clients (Windows laptops or Android phones). Broadcast discovery is used by default; targetIp performs one directed probe for routed private intranets such as campus VLANs. The network segment is a discovery filter, not authentication. Pairing still requires full TLS fingerprint verification, a fresh code, and target-owner approval.",
    inputSchema: closed({
      segment: { type: "string", minLength: 3, maxLength: 32, description: "Network segment configured on the target." },
      targetIp: { type: "string", description: "Optional explicit private IPv4 target for routed intranets. No hostname, URL, public IP, or address-range scan." },
      waitMs: { type: "integer", minimum: 250, maximum: 5000, description: "Optional discovery wait window; default 1500 ms." },
    }, ["segment"]),
  },
  {
    name: "superagent_lan_list_devices",
    description: "List paired LAN Device handles and connection state held by this Core process. Never returns pair/session tokens or one-time codes.",
    inputSchema: closed({}),
  },
  {
    name: "superagent_lan_capabilities",
    description: "Describe the first-class LAN Device MCP surface and Android diagnostic/action allowlists without contacting a remote device.",
    inputSchema: closed({ deviceId }),
  },
  {
    name: "superagent_lan_pair_request",
    description: "Create a pending LAN Device pairing request without sending a pairing code through MCP. The target, fingerprint, controller label and optional segment are stored only in Core memory. Complete the request locally in SuperAgent Tray by entering the fresh 8-digit code and confirming the fingerprint, then poll superagent_lan_pair_status with requestId.",
    inputSchema: closed({
      host: { type: "string", description: "Target private IPv4 address." },
      port: { type: "integer", minimum: 1024, maximum: 65534, description: "Target port; default 17845." },
      fingerprint: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "Complete SHA-256 certificate fingerprint displayed by the target." },
      controller: { type: "string", minLength: 1, maxLength: 60, description: "Controller label shown in the target approval prompt." },
      segment: { type: "string", minLength: 3, maxLength: 32, description: "Optional network segment used for target verification." },
    }, ["host", "fingerprint"]),
  },
  {
    name: "superagent_lan_pair_status",
    description: "Read the state of a pending Core-owned pairing request by opaque requestId. This never returns the local 8-digit pairing code or pair/session tokens.",
    inputSchema: closed({ requestId: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" } }, ["requestId"]),
  },
  {
    name: "superagent_lan_pair_cancel",
    description: "Cancel a still-pending Core-owned pairing request. No remote session is opened.",
    inputSchema: closed({ requestId: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" } }, ["requestId"]),
  },
  {
    name: "superagent_lan_pair",
    description: "Pair with a Windows or Android LAN Device using its fresh 8-digit code and complete 64-character SHA-256 TLS certificate fingerprint. Physical approval on the target remains mandatory. Optionally bind pairing to the same network segment used for discovery.",
    inputSchema: closed({
      host: { type: "string", description: "Target private IPv4 address." },
      port: { type: "integer", minimum: 1024, maximum: 65534, description: "Target port; default 17845." },
      code: { type: "string", pattern: "^\\d{8}$", description: "Fresh 8-digit code shown on the target." },
      fingerprint: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "Complete SHA-256 certificate fingerprint displayed by the target." },
      controller: { type: "string", minLength: 1, maxLength: 60, description: "Controller label shown in the target approval prompt." },
      segment: { type: "string", minLength: 3, maxLength: 32, description: "Optional network segment; recommended when pairing a discovered target." },
    }, ["host", "code", "fingerprint"]),
  },
  {
    name: "superagent_lan_session_open",
    description: "Request a separate time-limited support session on a previously paired LAN Device. The target owner must approve the session.",
    inputSchema: closed({ deviceId }, ["deviceId"]),
  },
  {
    name: "superagent_lan_device_exec",
    description: "Execute a bounded command through an approved LAN Device session. Windows supports guarded non-elevated PowerShell. Android accepts only the built-in diagnostic/action allowlists; there is no arbitrary Android shell.",
    inputSchema: closed({
      deviceId,
      command: { type: "string", minLength: 1, maxLength: 2000, description: "Guarded Windows command or exact Android diagnostic/action identifier." },
    }, ["deviceId", "command"]),
  },
  {
    name: "superagent_lan_terminal_exec",
    description: "Compatibility alias for superagent_lan_device_exec.",
    inputSchema: closed({
      deviceId,
      command: { type: "string", minLength: 1, maxLength: 2000 },
    }, ["deviceId", "command"]),
  },
  {
    name: "superagent_lan_android_diagnostic",
    description: "Run one exact read-only Android LAN diagnostic on an approved session. This tool cannot execute arbitrary shell commands.",
    inputSchema: closed({
      deviceId,
      diagnostic: { type: "string", enum: [...ANDROID_READONLY_DIAGNOSTICS] },
    }, ["deviceId", "diagnostic"]),
  },
  {
    name: "superagent_lan_android_ui_schema",
    description: "Read the bounded semantic UI schema from an approved Android LAN session. Use knownRevision to receive unchanged snapshots cheaply. Accessibility and target-side consent remain independently enforced.",
    inputSchema: closed({
      deviceId,
      knownRevision: { type: "integer", minimum: 0, maximum: 1_000_000_000 },
    }, ["deviceId"]),
  },
  {
    name: "superagent_lan_android_ui_click",
    description: "Click one semantic Android UI element by elementId and schema revision. Requires an approved Android session and target-side remote-input permission.",
    inputSchema: closed({
      deviceId,
      revision: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
      elementId: { type: "string", pattern: "^0(?:[.]\\d{1,2}){0,12}$", maxLength: 48 },
    }, ["deviceId", "revision", "elementId"]),
  },
  {
    name: "superagent_lan_android_screen",
    description: "Capture one bounded JPEG frame from an approved Android LAN session. The response contains mime, dimensions, and base64 JPEG data. Screen projection permission is enforced on the phone.",
    inputSchema: closed({ deviceId }, ["deviceId"]),
  },
  {
    name: "superagent_lan_android_input",
    description: "Send one bounded Android input operation over an approved LAN session. Supported kinds: tap, swipe, back, home, recents, text. Coordinates are normalized 0..1; no arbitrary shell or intent is exposed.",
    inputSchema: closed({
      deviceId,
      kind: { type: "string", enum: ["tap", "swipe", "back", "home", "recents", "text"] },
      x: { type: "number", minimum: 0, maximum: 1 },
      y: { type: "number", minimum: 0, maximum: 1 },
      endX: { type: "number", minimum: 0, maximum: 1 },
      endY: { type: "number", minimum: 0, maximum: 1 },
      durationMs: { type: "integer", minimum: 100, maximum: 1500 },
      text: { type: "string", minLength: 1, maxLength: 160 },
    }, ["deviceId", "kind"]),
  },
  {
    name: "superagent_lan_file_offer",
    description: "Start an owner-approved LAN file transfer. upload sends caller-provided metadata for a file up to 4 MiB; download uses a file already selected physically on the target.",
    inputSchema: closed({
      deviceId,
      direction: { type: "string", enum: ["upload", "download"] },
      name: { type: "string", minLength: 1, maxLength: 96 },
      size: { type: "integer", minimum: 1, maximum: 4 * 1024 * 1024 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, ["deviceId", "direction"]),
  },
  {
    name: "superagent_lan_file_put",
    description: "Upload one base64 file chunk for an approved LAN transfer.",
    inputSchema: closed({
      deviceId, transferId,
      seq: { type: "integer", minimum: 0, maximum: 1024 },
      data: { type: "string", minLength: 1, maxLength: 5464, description: "Base64 chunk." },
    }, ["deviceId", "transferId", "seq", "data"]),
  },
  {
    name: "superagent_lan_file_get",
    description: "Download one base64 file chunk for an approved LAN transfer.",
    inputSchema: closed({
      deviceId, transferId,
      seq: { type: "integer", minimum: 0, maximum: 1024 },
    }, ["deviceId", "transferId", "seq"]),
  },
  {
    name: "superagent_lan_file_finish",
    description: "Finalize an approved LAN file transfer after target-side size/hash verification.",
    inputSchema: closed({ deviceId, transferId }, ["deviceId", "transferId"]),
  },
  {
    name: "superagent_lan_file_abort",
    description: "Abort an in-progress LAN file transfer. This decreases privilege/state and remains available when Full YOLO is turned off.",
    inputSchema: closed({ deviceId, transferId }, ["deviceId", "transferId"]),
  },
  {
    name: "superagent_lan_session_close",
    description: "Close the active LAN support session. Pairing remains but a new target approval is required before future session actions.",
    inputSchema: closed({ deviceId }, ["deviceId"]),
  },
  {
    name: "superagent_lan_revoke_device",
    description: "Revoke the paired LAN Device and all remote pairing/session credentials associated with it.",
    inputSchema: closed({ deviceId }, ["deviceId"]),
  },
];

async function coreLan(body: Record<string, unknown>, timeoutMs = 120_000): Promise<McpToolResult> {
  const response = await callServerApi("/api/desktop/lan-support", "POST", body, timeoutMs);
  if (!response.success) {
    return result({ ok: false, error: response.error || "Core LAN Device request failed." }, true);
  }
  return result(response.data);
}

function androidInput(args: Record<string, unknown>): Record<string, unknown> {
  const kind = str(args.kind);
  if (kind === "tap") return { kind, x: Number(args.x), y: Number(args.y) };
  if (kind === "swipe") return {
    kind, x: Number(args.x), y: Number(args.y), endX: Number(args.endX), endY: Number(args.endY),
    durationMs: Number(args.durationMs),
  };
  if (kind === "text") return { kind, text: str(args.text) };
  if (kind === "back" || kind === "home" || kind === "recents") return { kind };
  throw new Error("Unsupported Android input.");
}

export async function dispatchLanMcpTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult | null> {
  if (!(name in LAN_MCP_TOOL_CLASSIFICATIONS)) return null;
  const deescalating = [
    "superagent_lan_session_close", "superagent_lan_revoke_device", "superagent_lan_file_abort",
    "superagent_lan_pair_cancel",
  ].includes(name);
  if (LAN_MCP_TOOL_CLASSIFICATIONS[name] === "dangerous" && !isFullYoloMode() && !deescalating) {
    return result({
      ok: false,
      error: "Full YOLO is required for cross-device LAN support, in addition to MCP permission and physical target approval.",
    }, true);
  }

  try {
    const id = str(args.deviceId);
    switch (name) {
      case "superagent_lan_discover":
        return await coreLan({
          action: "discover", segment: str(args.segment),
          ...(args.targetIp === undefined ? {} : { targetIp: str(args.targetIp) }),
        }, Math.min(8_000, Math.max(2_000, (integer(args.waitMs) ?? 1500) + 2_000)));
      case "superagent_lan_list_devices":
        return await coreLan({ action: "list" }, 8_000);
      case "superagent_lan_capabilities":
        return result({
          owner: "core",
          workflow: ["discover", "pair_request", "local_pair_complete", "pair_status", "session_open", "inspect_or_interact", "session_close_or_revoke"],
          windows: { exec: true, nonElevated: true },
          android: {
            diagnostics: ANDROID_READONLY_DIAGNOSTICS,
            ownerApprovedActions: ANDROID_APPROVED_ACTIONS,
            uiSchema: true, semanticClick: true, screenFrame: true, boundedInput: true,
          },
          files: { upload: true, download: true, maxBytes: 4 * 1024 * 1024, chunkBytes: 4096 },
        });
      case "superagent_lan_pair_request":
        return await coreLan({
          action: "pair_request", host: str(args.host),
          ...(integer(args.port) === undefined ? {} : { port: integer(args.port) }),
          fingerprint: str(args.fingerprint), controller: str(args.controller) || "SuperAgent MCP",
          ...(args.segment === undefined ? {} : { segment: str(args.segment) }),
        }, 10_000);
      case "superagent_lan_pair_status":
        return await coreLan({ action: "pair_status", requestId: str(args.requestId) }, 10_000);
      case "superagent_lan_pair_cancel":
        return await coreLan({ action: "pair_cancel", requestId: str(args.requestId) }, 10_000);
      case "superagent_lan_pair":
        return await coreLan({
          action: "pair", host: str(args.host),
          ...(integer(args.port) === undefined ? {} : { port: integer(args.port) }),
          code: str(args.code), fingerprint: str(args.fingerprint),
          controller: str(args.controller) || "SuperAgent",
          ...(args.segment === undefined ? {} : { segment: str(args.segment) }),
        }, 125_000);
      case "superagent_lan_session_open":
        return await coreLan({ action: "open", deviceId: id }, 125_000);
      case "superagent_lan_device_exec":
      case "superagent_lan_terminal_exec":
        return await coreLan({ action: "exec", deviceId: id, command: str(args.command) }, 125_000);
      case "superagent_lan_android_diagnostic":
        return await coreLan({ action: "exec", deviceId: id, command: str(args.diagnostic) }, 45_000);
      case "superagent_lan_android_ui_schema":
        return await coreLan({ action: "schema", deviceId: id,
          ...(integer(args.knownRevision) === undefined ? {} : { knownRevision: integer(args.knownRevision) }) }, 15_000);
      case "superagent_lan_android_ui_click":
        return await coreLan({ action: "element", deviceId: id, kind: "click",
          revision: Number(args.revision), elementId: str(args.elementId) }, 15_000);
      case "superagent_lan_android_screen":
        return await coreLan({ action: "screen", deviceId: id }, 15_000);
      case "superagent_lan_android_input":
        return await coreLan({ action: "input", deviceId: id, ...androidInput(args) }, 15_000);
      case "superagent_lan_file_offer":
        return await coreLan({ action: "file_offer", deviceId: id,
          direction: args.direction,
          ...(args.direction === "upload" ? { name: str(args.name), size: Number(args.size), sha256: str(args.sha256) } : {}),
        }, 125_000);
      case "superagent_lan_file_put":
        return await coreLan({ action: "file_put", deviceId: id, transferId: str(args.transferId),
          seq: Number(args.seq), data: str(args.data) }, 20_000);
      case "superagent_lan_file_get":
        return await coreLan({ action: "file_get", deviceId: id, transferId: str(args.transferId),
          seq: Number(args.seq) }, 20_000);
      case "superagent_lan_file_finish":
        return await coreLan({ action: "file_finish", deviceId: id, transferId: str(args.transferId) }, 30_000);
      case "superagent_lan_file_abort":
        return await coreLan({ action: "file_abort", deviceId: id, transferId: str(args.transferId) }, 15_000);
      case "superagent_lan_session_close":
        return await coreLan({ action: "close", deviceId: id }, 15_000);
      case "superagent_lan_revoke_device":
        return await coreLan({ action: "revoke", deviceId: id }, 15_000);
      default:
        return null;
    }
  } catch (error) {
    return result({
      ok: false,
      error: error instanceof Error ? error.message : "LAN Device operation failed.",
    }, true);
  }
}
