/**
 * Authenticated local Tray -> Core bridge for consent-based LAN terminal support.
 * The Core process owns volatile pairing/session credentials; the WebView never
 * receives a session token, pairing secret or TLS private key. No direct LAN
 * access or arbitrary URL is exposed to Tauri/JavaScript.
 */
import { isFullYoloMode, isSystemDestructiveCommand } from "../permissions.js";
import { privateIntranetPeer } from "../lanRemote/transport.js";
import {
  closeLanSession, discoverLanDevices, execLanCommand, listLanDevices,
  openLanSession, pairLanDevice, revokeLanDevice,
  getAndroidScreenFrame, sendAndroidScreenInput, type AndroidScreenInput,
  getAndroidUiSchema, clickAndroidUiElement, offerLanFile, putLanFileChunk,
  getLanFileChunk, finalizeLanFile, abortLanFile,
} from "../lanRemote/controller.js";
import {
  cancelLanPairRequest, completeLanPairRequest, createLanPairRequest, createTunnelPairRequest,
  getLanPairRequest, listLanPairRequests,
} from "../lanRemote/pairRequestBroker.js";
import { createDeviceTunnelInvite, getDeviceTunnelInviteStatus, listDeviceTunnelDevices, revokeDeviceTunnel, revokeDeviceTunnelInvite } from "../deviceTunnel/broker.js";
import { buildDeviceTunnelQrPayload, renderDeviceTunnelQrDataUrl, renderDeviceTunnelQrMatrix } from "../deviceTunnel/qrInvite.js";
import { createAndroidApkDownloadTicket, getAndroidApkDownloadTicketStatus, revokeAndroidApkDownloadTicket } from "../deviceTunnel/apkDownload.js";
import { ensureOwnedCoreHttpTunnel } from "./ownedCoreHttpTunnel.js";

export type TrayLanAction = "discover" | "list" | "pair" | "pair_request" | "pair_status" | "pair_complete" | "pair_cancel" | "tunnel_invite" | "apk_download_qr" | "qr_heartbeat" | "tunnel_list" | "tunnel_pair_request" | "tunnel_revoke" | "open" | "exec" | "close" | "revoke" | "screen" | "input" | "schema" | "element" | "file_offer" | "file_put" | "file_get" | "file_finish" | "file_abort";
type LanArgs = Record<string, unknown>;
const actions = new Set<TrayLanAction>(["discover", "list", "pair", "pair_request", "pair_status", "pair_complete", "pair_cancel", "tunnel_invite", "apk_download_qr", "qr_heartbeat", "tunnel_list", "tunnel_pair_request", "tunnel_revoke", "open", "exec", "close", "revoke", "screen", "input", "schema", "element", "file_offer", "file_put", "file_get", "file_finish", "file_abort"]);

export function parseTrayLanAction(input: unknown): { action: TrayLanAction; args: LanArgs } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid LAN request.");
  const data = input as LanArgs;
  if (typeof data.action !== "string" || !actions.has(data.action as TrayLanAction)) throw Error("Unsupported LAN action.");
  const action = data.action as TrayLanAction;
  const allowed: Record<TrayLanAction, string[]> = {
    discover: ["action", "segment", "targetIp"], list: ["action"],
    pair: ["action", "host", "port", "code", "fingerprint", "controller", "segment"],
    pair_request: ["action", "host", "port", "fingerprint", "controller", "segment"],
    pair_status: ["action", "requestId"],
    pair_complete: ["action", "requestId", "code", "verified"],
    pair_cancel: ["action", "requestId"],
    tunnel_invite: ["action"], apk_download_qr: ["action"], qr_heartbeat: ["action", "kind", "id"], tunnel_list: ["action"],
    tunnel_pair_request: ["action", "tunnelId", "fingerprint", "controller"],
    tunnel_revoke: ["action", "tunnelId"],
    open: ["action", "deviceId"], exec: ["action", "deviceId", "command"],
    close: ["action", "deviceId"], revoke: ["action", "deviceId"],
    file_offer: ["action", "deviceId", "direction", "name", "size", "sha256"],
    file_put: ["action", "deviceId", "transferId", "seq", "data"],
    file_get: ["action", "deviceId", "transferId", "seq"],
    file_finish: ["action", "deviceId", "transferId"],
    file_abort: ["action", "deviceId", "transferId"],
    schema: ["action", "deviceId", "knownRevision"],
    element: ["action", "deviceId", "elementId", "revision", "kind"],
    screen: ["action", "deviceId"],
    input: ["action", "deviceId", "kind", "x", "y", "endX", "endY", "durationMs", "text"],
  };
  const keys = Object.keys(data);
  if (keys.some((key) => !allowed[action].includes(key))) throw Error("Unexpected LAN request field.");
  if (action === "qr_heartbeat") {
    if (data.kind !== "connect" && data.kind !== "apk") throw Error("Invalid QR heartbeat kind.");
    if (typeof data.id !== "string") throw Error("QR heartbeat ID required.");
    if (data.kind === "connect" && !/^[a-f0-9-]{36}$/i.test(data.id)) throw Error("Invalid connect QR heartbeat ID.");
    if (data.kind === "apk" && !/^[a-f0-9]{64}$/.test(data.id)) throw Error("Invalid APK QR heartbeat ID.");
  }
  if (action === "discover") {
    if (typeof data.segment !== "string" || data.segment !== data.segment.trim() ||
        data.segment.length < 3 || data.segment.length > 32 ||
        !/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}$/.test(data.segment))
      throw Error("Network segment name required: 3-32 safe characters.");
    if (data.targetIp !== undefined &&
        (typeof data.targetIp !== "string" || !privateIntranetPeer(data.targetIp)))
      throw Error("Direct target must be a private IPv4 in the physical adapter's /16 intranet.");
  }
  if (action === "pair" || action === "pair_request") {
    if (typeof data.host !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(data.host)) throw Error("Target IPv4 required.");
    if (action === "pair" && (typeof data.code !== "string" || !/^\d{8}$/.test(data.code))) throw Error("Eight-digit code required.");
    if (typeof data.fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(data.fingerprint)) throw Error("Full SHA-256 fingerprint required.");
    if (data.port !== undefined && (!Number.isInteger(data.port) || Number(data.port) < 1024 || Number(data.port) > 65534)) throw Error("Invalid LAN port.");
    if (data.controller !== undefined &&
       (typeof data.controller !== "string" || data.controller.length > 60 || !/^[\w .-]+$/.test(data.controller))) throw Error("Controller label invalid.");
    if (data.segment !== undefined &&
        (typeof data.segment !== "string" || data.segment !== data.segment.trim() ||
        !/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}$/.test(data.segment)))
      throw Error("Invalid network segment for pairing.");
  } else if (action === "tunnel_pair_request") {
    if (typeof data.tunnelId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.tunnelId))
      throw Error("Valid tunnel device ID required.");
    if (typeof data.fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(data.fingerprint))
      throw Error("Full SHA-256 fingerprint required.");
    if (data.controller !== undefined &&
       (typeof data.controller !== "string" || data.controller.length > 60 || !/^[\w .-]+$/.test(data.controller)))
      throw Error("Controller label invalid.");
  } else if (action === "tunnel_revoke") {
    if (typeof data.tunnelId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.tunnelId))
      throw Error("Valid tunnel device ID required.");
  } else if (["pair_status", "pair_cancel", "pair_complete"].includes(action)) {
    if (typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.requestId))
      throw Error("Valid pairing request ID required.");
    if (action === "pair_complete") {
      if (typeof data.code !== "string" || !/^\d{8}$/.test(data.code)) throw Error("Eight-digit code required.");
      if (data.verified !== true) throw Error("Local fingerprint confirmation required.");
    }
  } else if (["open", "exec", "close", "revoke", "screen", "input", "schema", "element", "file_offer", "file_put", "file_get", "file_finish", "file_abort"].includes(action)) {
    if (typeof data.deviceId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.deviceId)) throw Error("Valid paired device ID required.");
    if (action === "exec" &&
      (typeof data.command !== "string" || !data.command.trim() || data.command.length > 2000)) throw Error("PowerShell command must contain 1–2000 characters.");
  }
  if (action.startsWith("file_")) {
    if (action === "file_offer") {
      if (data.direction !== "upload" && data.direction !== "download") throw Error("Invalid file direction.");
      if (data.direction === "download" && ["name", "size", "sha256"].some((key) => data[key] !== undefined))
        throw Error("Remote file must be selected on the target; local paths are never accepted.");
      if (data.direction === "upload") {
        if (typeof data.name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}$/.test(data.name)
            || data.name.endsWith(" ") || data.name.endsWith(".")
            || !Number.isSafeInteger(data.size) || Number(data.size) < 1 || Number(data.size) > 4 * 1024 * 1024
            || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256))
          throw Error("Invalid upload name, size or SHA-256.");
      }
    } else {
      if (typeof data.transferId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.transferId))
        throw Error("Invalid file transfer ID.");
      if (action === "file_put" || action === "file_get") {
        if (!Number.isSafeInteger(data.seq) || Number(data.seq) < 0 || Number(data.seq) > 1024)
          throw Error("Invalid file sequence number.");
      }
      if (action === "file_put" && (typeof data.data !== "string" ||
          data.data.length > 5464 || !/^[A-Za-z0-9+/]{1,5464}={0,2}$/.test(data.data)))
        throw Error("Invalid encoded file chunk.");
    }
  }
  if (action === "schema") {
    if (data.knownRevision !== undefined &&
        (!Number.isSafeInteger(data.knownRevision) || Number(data.knownRevision) < 0
         || Number(data.knownRevision) > 1_000_000_000)) throw Error("Invalid known UI schema revision.");
  }
  if (action === "element") {
    if (data.kind !== "click" || typeof data.elementId !== "string"
        || !/^0(?:[.]\d{1,2}){0,12}$/.test(data.elementId)
        || data.elementId.length > 48
        || !Number.isSafeInteger(data.revision) || Number(data.revision) < 1
        || Number(data.revision) > 1_000_000_000) throw Error("Invalid semantic UI action.");
  }
  if (action === "input") {
    const kind = data.kind;
    const allowed: Record<string, string[]> = {
      tap: ["action", "deviceId", "kind", "x", "y"],
      swipe: ["action", "deviceId", "kind", "x", "y", "endX", "endY", "durationMs"],
      back: ["action", "deviceId", "kind"], home: ["action", "deviceId", "kind"],
      recents: ["action", "deviceId", "kind"], text: ["action", "deviceId", "kind", "text"],
    };
    if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(allowed, kind)
        || Object.keys(data).some((key) => !allowed[kind].includes(key))) throw Error("Unsupported Android input.");
    for (const coord of (kind === "tap" ? ["x", "y"] : kind === "swipe" ? ["x", "y", "endX", "endY"] : [])) {
      const n = data[coord];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
        throw Error("Android coordinate outside screen bounds.");
    }
    if (kind === "swipe" &&
        (!Number.isInteger(data.durationMs) || Number(data.durationMs) < 100 || Number(data.durationMs) > 1500))
      throw Error("Invalid swipe duration.");
    if (kind === "text" && (typeof data.text !== "string" || !data.text
        || data.text.length > 160 || data.text.includes(String.fromCharCode(10))
        || data.text.includes(String.fromCharCode(13)))) throw Error("Remote text invalid.");
  }
  return { action, args: data };
}

let latestConnectQrInviteId: string | null = null;
let latestApkQrToken: string | null = null;

export async function dispatchTrayLanAction(input: unknown): Promise<unknown> {
  const { action, args } = parseTrayLanAction(input);
  if (action === "discover") return { success: true,
    devices: await discoverLanDevices(args.segment as string, 1500, args.targetIp as string | undefined) };
  if (action === "list") return { success: true, devices: listLanDevices(), pairingRequests: listLanPairRequests(), tunnelDevices: listDeviceTunnelDevices() };
  if (action === "tunnel_list") return { success: true, devices: listDeviceTunnelDevices() };
  if (action === "qr_heartbeat") {
    const kind = args.kind as "connect" | "apk";
    const id = String(args.id);
    const { getTunnelStatus } = await import("../remoteAgent/cloudflareTunnel.js");
    const tunnel = getTunnelStatus(7888);
    const tunnelActive = Boolean(tunnel.isRunning && tunnel.serviceKind === "superagent-http" && tunnel.publicUrl);
    const status = kind === "connect" ? getDeviceTunnelInviteStatus(id) : getAndroidApkDownloadTicketStatus(id);
    return { success: true, kind, id, tunnelActive, serverNow: Date.now(), ...status };
  }
  if (action === "apk_download_qr") {
    if (!isFullYoloMode()) throw Error("Full YOLO must be enabled locally before exposing a temporary APK download ticket.");
    const tunnel = await ensureOwnedCoreHttpTunnel(7888);
    if (latestApkQrToken) revokeAndroidApkDownloadTicket(latestApkQrToken);
    const ticket = createAndroidApkDownloadTicket();
    latestApkQrToken = ticket.token;
    const baseUrl = tunnel.endpoint.replace(/\/$/, "");
    const downloadUrl = `${baseUrl}/api/device-tunnel/android-apk/${ticket.token}`;
    const qrMatrix = renderDeviceTunnelQrMatrix(downloadUrl);
    return { success: true, apk: {
      heartbeatId: ticket.token, downloadUrl, qrMatrix, expiresAt: ticket.expiresAt, size: ticket.size,
      sha256: ticket.sha256, filename: ticket.filename,
    } };
  }
  if (action === "tunnel_invite") {
    if (!isFullYoloMode()) throw Error("Full YOLO must be enabled locally before creating a QR auto-pair invite.");
    const tunnel = await ensureOwnedCoreHttpTunnel(7888);
    if (latestConnectQrInviteId) revokeDeviceTunnelInvite(latestConnectQrInviteId);
    const invite = createDeviceTunnelInvite();
    latestConnectQrInviteId = invite.inviteId;
    const baseUrl = tunnel.endpoint.replace(/\/$/, "");
    const setup = JSON.stringify({ url: baseUrl, inviteId: invite.inviteId, code: invite.code });
    const qrPayload = buildDeviceTunnelQrPayload({
      baseUrl, inviteId: invite.inviteId, code: invite.code, expiresAt: invite.expiresAt,
    });
    const qrMatrix = renderDeviceTunnelQrMatrix(qrPayload);
    return { success: true, invite: { inviteId: invite.inviteId, code: invite.code,
      expiresAt: invite.expiresAt, baseUrl, setup, qrPayload, qrMatrix } };
  }
  if (action === "pair_status") return { success: true, request: getLanPairRequest(String(args.requestId)) };
  // Closing/revoking/cancelling access decreases privilege and remains available even after YOLO is turned off.
  if (!isFullYoloMode() && !["close", "revoke", "file_abort", "pair_cancel", "tunnel_revoke"].includes(action)) {
    throw Error("Full YOLO must be enabled locally for remote LAN pairing and execution. Target approval is also required.");
  }
  const id = String(args.deviceId ?? "");
  switch (action) {
    case "tunnel_pair_request": return { success: true, request: createTunnelPairRequest({
      tunnelId: args.tunnelId as string, fingerprint: args.fingerprint as string,
      controller: args.controller as string | undefined,
    }) };
    case "tunnel_revoke": revokeDeviceTunnel(args.tunnelId as string); return { success: true, state: "tunnel_device_revoked" };
    case "pair_request": return { success: true, request: createLanPairRequest({
      host: args.host as string, port: args.port as number | undefined,
      fingerprint: args.fingerprint as string, controller: args.controller as string | undefined,
      segment: args.segment as string | undefined,
    }) };
    case "pair_complete": {
      const completed = await completeLanPairRequest(String(args.requestId), args.code as string);
      return { success: true, request: completed.request, device: completed.device };
    }
    case "pair_cancel": return { success: true, request: cancelLanPairRequest(String(args.requestId)) };
    case "pair": return { success: true, device: await pairLanDevice({
      host: args.host as string, port: args.port as number | undefined, code: args.code as string,
       fingerprint: args.fingerprint as string, controller: args.controller as string | undefined,
       segmentName: args.segment as string | undefined,
    }) };
    case "open": return { success: true, device: await openLanSession(id) };
    case "exec": {
      const command = args.command as string;
      if (isSystemDestructiveCommand(command)) throw Error("Potentially destructive remote system command blocked.");
      const result = await execLanCommand(id, command);
      return { success: true, result };
    }
    case "file_offer": return { success: true, file: await offerLanFile(id,
      args.direction as "upload" | "download",
      args.direction === "upload" ? {
        name: args.name as string, size: args.size as number, sha256: args.sha256 as string,
      } : undefined) };
    case "file_put": return { success: true, result: await putLanFileChunk(id,
      args.transferId as string, args.seq as number, args.data as string) };
    case "file_get": return { success: true, result: await getLanFileChunk(id,
      args.transferId as string, args.seq as number) };
    case "file_finish": return { success: true, result: await finalizeLanFile(id, args.transferId as string) };
    case "file_abort": await abortLanFile(id, args.transferId as string); return { success: true };
    case "schema": return { success: true, schema: await getAndroidUiSchema(id, args.knownRevision as number | undefined) };
    case "element": return { success: true,
      result: await clickAndroidUiElement(id, args.revision as number, args.elementId as string) };
    case "screen": return { success: true, frame: await getAndroidScreenFrame(id) };
    case "input": {
      const { kind, x, y, endX, endY, durationMs, text: inputText } = args;
      const command = { kind, x, y, endX, endY, durationMs, text: inputText } as AndroidScreenInput;
      // No arbitrary shell/URI/browser/native command path is exposed here.
      return { success: true, result: await sendAndroidScreenInput(id, command) };
    }
    case "close": await closeLanSession(id); return { success: true, state: "session_closed" };
    case "revoke": await revokeLanDevice(id); return { success: true, state: "device_revoked" };
  }
}
