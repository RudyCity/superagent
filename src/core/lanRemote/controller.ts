import tls from "node:tls";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { lanInterfaces, onLinkToPeer, privateIntranetPeer, outboundLanSource, LAN_PORT, type LanInterface } from "./transport.js";
import { discoveryRequestForSegment, networkSegmentTag, parseSegmentDiscoveryResponse } from "./networkSegment.js";
import { isAllowedAndroidLanCommand, requiresAndroidOwnerActionApproval } from "./androidCapabilities.js";

export interface LanDevice {
  id: string;
  host: string;
  port: number;
  fingerprint: string;
  label: string;
  platform: "windows" | "android";
  paired: boolean;
  connected: boolean;
}
interface SavedSession extends LanDevice {
  pairId: string; pairToken: string; sessionId?: string; sessionToken?: string;
}
const sessions = new Map<string, SavedSession>();
export function listLanDevices(): LanDevice[] {
  return [...sessions.values()].map(({ id, host, port, fingerprint, label, platform, sessionToken }) => ({
    id, host, port, fingerprint, label, platform, paired: true, connected: Boolean(sessionToken),
  }));
}
function assertHost(host: string, port: number, fingerprint: string) {
  if (!privateIntranetPeer(host)) throw new Error("Target must be private IPv4 within the physical adapter's /16 intranet allocation.");
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("Invalid port.");
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error("Provide the complete 64-character fingerprint displayed on the target.");
}
interface Reply { ok?: boolean; error?: string; event?: string; data?: string; stream?: string; [key: string]: unknown }
async function request(host: string, port: number, fingerprint: string, body: object,
  maxWait = 120_000, maxReplyChars = 256 * 1024): Promise<Reply[]> {
  assertHost(host, port, fingerprint);
  return await new Promise<Reply[]>((resolve, reject) => {
    const transport = net.connect({ host, port, localAddress: outboundLanSource(host) });
    const socket = tls.connect({ socket: transport, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    const responses: Reply[] = [];
    let completed = false, text = "";
    const done = (error?: Error) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(responses);
    };
    socket.setTimeout(maxWait, () => done(new Error("LAN request timed out.")));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") {
        done(new Error("LAN TLS handshake was reset by target or network. Check the target app is actively sharing, and verify Windows uses the physical Wi-Fi route to the target IP (not another adapter)."));
        return;
      }
      done(error);
    });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert.raw) { done(new Error("Missing server certificate.")); return; }
      const observed = crypto.createHash("sha256").update(cert.raw).digest("hex");
      if (observed.length !== fingerprint.length ||
          !crypto.timingSafeEqual(Buffer.from(observed), Buffer.from(fingerprint.toLowerCase()))) {
        done(new Error("Certificate fingerprint mismatch: possible impersonation or restarted client."));
        return;
      }
      if (!privateIntranetPeer(host)) { done(new Error("Target is no longer on a verified private physical intranet.")); return; }
      socket.write(JSON.stringify(body) + "\n");
    });
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > maxReplyChars) { done(new Error("Excessive protocol output.")); return; }
      while (text.includes("\n")) {
        const index = text.indexOf("\n");
        const line = text.slice(0, index); text = text.slice(index + 1);
        let parsed: Reply;
        try { parsed = JSON.parse(line); } catch { done(new Error("Malformed LAN reply.")); return; }
        responses.push(parsed);
        if (parsed.ok === false && parsed.event !== "done") { done(new Error(String(parsed.error || "Operation denied."))); return; }
        if (parsed.event === "done" || (parsed.ok !== undefined && parsed.event !== "output")) {
          done(); return;
        }
      }
    });
    socket.once("end", () => {
      if (!completed) done(responses.length ? undefined : new Error("Target closed connection without response."));
    });
  });
}
export async function pairLanDevice(input: { host: string; port?: number; code: string; fingerprint: string; controller?: string; segmentName?: string }): Promise<LanDevice> {
  if (!/^\d{8}$/.test(input.code)) throw new Error("Expected an 8-digit pairing code.");
  const host = input.host, port = input.port ?? LAN_PORT, fingerprint = input.fingerprint.toLowerCase();
  const label = (input.controller || "SuperAgent").trim().slice(0, 60);
  // Optional for manual IP pairing: discovery is not authorization.
  // Physical approval, one-time code, and pinned TLS remain mandatory.
  const segmentTag = input.segmentName === undefined ? undefined : networkSegmentTag(input.segmentName);
  const [reply] = await request(host, port, fingerprint, { op: "pair", code: input.code, label,
    ...(segmentTag ? { segmentTag } : {}) });
  if (segmentTag && reply?.segmentTag !== segmentTag) throw Error("Pairing network segment mismatch.");
  if (!reply || typeof reply.pairId !== "string" || typeof reply.pairToken !== "string") throw new Error("Pairing failed.");
  const id = crypto.randomUUID();
  const platform = reply.platform === "android" ? "android" : "windows";
  const safeDeviceName = typeof reply.deviceName === "string"
    ? reply.deviceName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) : "";
  const deviceLabel = safeDeviceName || (platform === "android" ? "Android" : "Windows") + " LAN Client (" + host + ")";
  const entry: SavedSession = { id, host, port, fingerprint, label: deviceLabel, platform,
    paired: true, connected: false, pairId: reply.pairId, pairToken: reply.pairToken };
  sessions.set(id, entry);
  return { id, host, port, fingerprint, label: entry.label, platform, paired: true, connected: false };
}
function getSession(id: string): SavedSession {
  const entry = sessions.get(id);
  if (!entry) throw new Error("Unknown LAN handle. Pair this laptop again.");
  return entry;
}
export async function openLanSession(id: string): Promise<LanDevice> {
  const d = getSession(id);
  const [reply] = await request(d.host, d.port, d.fingerprint, { op: "open", pairId: d.pairId, pairToken: d.pairToken });
  if (!reply || typeof reply.sessionId !== "string" || typeof reply.sessionToken !== "string") throw new Error("Session approval failed.");
  d.sessionId = reply.sessionId;
  d.sessionToken = reply.sessionToken;
  return { id: d.id, host: d.host, port: d.port, fingerprint: d.fingerprint, label: d.label, platform: d.platform, paired: true, connected: true };
}
export async function execLanCommand(id: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null; ok: boolean; error?: string }> {
  const d = getSession(id);
  if (!d.sessionId || !d.sessionToken) throw new Error("Open an approved session before running commands.");
  if (!command || command.length > 2000) throw new Error("Command must have 1–2000 characters.");
  if (d.platform === "android" && !isAllowedAndroidLanCommand(command)) {
    throw new Error("Android client only accepts supported diagnostic or owner-approved action identifiers.");
  }
  const frames = await request(d.host, d.port, d.fingerprint, {
    op: "exec", pairId: d.pairId, pairToken: d.pairToken,
    sessionId: d.sessionId, sessionToken: d.sessionToken, command,
  }, d.platform === "android" && requiresAndroidOwnerActionApproval(command) ? 115_000 : 40_000);
  const stdout = frames.filter((f) => f.event === "output" && f.stream === "stdout").map((f) => String(f.data || "")).join("");
  const stderr = frames.filter((f) => f.event === "output" && f.stream === "stderr").map((f) => String(f.data || "")).join("");
  const done = frames.find((f) => f.event === "done");
  if (!done) throw new Error("Command did not produce a completion receipt.");
  // Opening Android Settings intentionally backgrounds the phone app and
  // stops its LAN listener. Drop the ephemeral credentials immediately so
  // Tray does not show a falsely connected/paired Android device.
  if (d.platform === "android" && done.ok === true && command.startsWith("android.action.open_")) {
    sessions.delete(id);
  }
  return { stdout, stderr, exitCode: typeof done.exitCode === "number" ? done.exitCode : null, ok: done.ok === true, ...(done.error ? { error: String(done.error) } : {}) };
}
export interface AndroidScreenFrame {
  mime: "image/jpeg";
  width: number;
  height: number;
  data: string;
}
export type AndroidScreenInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x: number; y: number; endX: number; endY: number; durationMs: number }
  | { kind: "back" | "home" | "recents" }
  | { kind: "text"; text: string };

function authenticatedAndroid(id: string): SavedSession {
  const d = getSession(id);
  if (d.platform !== "android") throw Error("Screen control requires an Android LAN Client.");
  if (!d.sessionId || !d.sessionToken) throw Error("Open a user-approved support session first.");
  return d;
}

export async function getAndroidScreenFrame(id: string): Promise<AndroidScreenFrame> {
  const d = authenticatedAndroid(id);
  const frames = await request(d.host, d.port, d.fingerprint, {
    op: "screen", pairId: d.pairId, pairToken: d.pairToken,
    sessionId: d.sessionId, sessionToken: d.sessionToken,
  }, 8_000, 600 * 1024);
  const frame = frames.find((f) => f.event === "frame");
  if (!frames.some((f) => f.event === "done" && f.ok === true) || !frame) {
    throw Error("Android screen capture is not available or not approved.");
  }
  const width = Number(frame.width), height = Number(frame.height);
  if (frame.mime !== "image/jpeg" || !Number.isInteger(width) || width < 1 || width > 480
    || !Number.isInteger(height) || height < 1 || height > 1080
    || typeof frame.data !== "string" || frame.data.length > 290_000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) {
    throw Error("Invalid or oversized screen frame.");
  }
  return { mime: "image/jpeg", width, height, data: frame.data };
}

export async function sendAndroidScreenInput(id: string, command: AndroidScreenInput): Promise<{ ok: boolean; kind: string }> {
  const d = authenticatedAndroid(id);
  if (!command || typeof command !== "object") throw Error("Invalid remote input.");
  const keys: Record<AndroidScreenInput["kind"], string[]> = {
    tap: ["kind", "x", "y"],
    swipe: ["kind", "x", "y", "endX", "endY", "durationMs"],
    back: ["kind"], home: ["kind"], recents: ["kind"], text: ["kind", "text"],
  };
  if (!(command.kind in keys) || Object.keys(command).some((key) => !keys[command.kind].includes(key)))
    throw Error("Invalid Android input operation.");
  const coords = command.kind === "tap" ? [command.x, command.y]
    : command.kind === "swipe" ? [command.x, command.y, command.endX, command.endY] : [];
  if (coords.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) throw Error("Input coordinate out of bounds.");
  if (command.kind === "swipe" &&
    (!Number.isInteger(command.durationMs) || command.durationMs < 100 || command.durationMs > 1500))
    throw Error("Invalid swipe duration.");
  if (command.kind === "text" && (!command.text || command.text.length > 160
      || command.text.includes(String.fromCharCode(10)) || command.text.includes(String.fromCharCode(13))))
    throw Error("Remote text must be 1–160 characters and contain no newline.");
  const [reply] = await request(d.host, d.port, d.fingerprint, {
    op: "input", pairId: d.pairId, pairToken: d.pairToken,
    sessionId: d.sessionId, sessionToken: d.sessionToken, ...command,
  }, 8_000);
  if (!reply || reply.ok !== true || reply.accepted !== true || reply.kind !== command.kind)
    throw Error("Android did not accept the input. Check Accessibility and on-phone consent.");
  return { ok: true, kind: command.kind };
}

export interface AndroidUiElement {
  id: string;
  role: string;
  resource?: string;
  bounds: { x: number; y: number; w: number; h: number };
  clickable: boolean; enabled: boolean; editable: boolean; scrollable: boolean; focused: boolean;
}
export interface AndroidUiSchemaSnapshot {
  version: 1;
  revision: number;
  changed: boolean;
  width?: number;
  height?: number;
  truncated?: boolean;
  nodes?: AndroidUiElement[];
}

const validNormalized = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export async function getAndroidUiSchema(id: string, knownRevision = 0): Promise<AndroidUiSchemaSnapshot> {
  const d = authenticatedAndroid(id);
  if (!Number.isInteger(knownRevision) || knownRevision < 0 || knownRevision > 1_000_000_000)
    throw Error("Invalid last-known UI schema revision.");
  const frames = await request(d.host, d.port, d.fingerprint, {
    op: "schema", pairId: d.pairId, pairToken: d.pairToken,
    sessionId: d.sessionId, sessionToken: d.sessionToken, knownRevision,
  }, 5_000, 110_000);
  const schema = frames.find((f) => f.event === "schema")?.schema as AndroidUiSchemaSnapshot | undefined;
  if (!frames.some((f) => f.event === "done" && f.ok === true)
    || !schema || schema.version !== 1 || !Number.isSafeInteger(schema.revision)
    || schema.revision < 1 || schema.revision > 1_000_000_000
    || typeof schema.changed !== "boolean") throw Error("Invalid Android schema response.");
  if (!schema.changed) {
    if (schema.revision !== knownRevision || schema.nodes !== undefined) throw Error("Invalid unchanged schema.");
    return { version: 1, revision: knownRevision, changed: false };
  }
  if (!Number.isInteger(schema.width) || !Number.isInteger(schema.height)
    || schema.width! < 1 || schema.width! > 10000
    || schema.height! < 1 || schema.height! > 10000
    || typeof schema.truncated !== "boolean"
    || !Array.isArray(schema.nodes) || schema.nodes.length > 96) throw Error("Invalid UI schema bounds.");
  for (const n of schema.nodes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string"
      || !/^0(?:[.]\d{1,2}){0,12}$/.test(n.id) || n.id.length > 48
      || typeof n.role !== "string" || !/^[a-z-]{1,24}$/.test(n.role)
      || (n.resource !== undefined && (typeof n.resource !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_.-]{1,47}$/.test(n.resource)))
      || !n.bounds || ![n.bounds.x, n.bounds.y, n.bounds.w, n.bounds.h].every(validNormalized)
      || n.bounds.w <= 0 || n.bounds.h <= 0
      || n.bounds.x + n.bounds.w > 1.001 || n.bounds.y + n.bounds.h > 1.001
      || ["clickable", "enabled", "editable", "scrollable", "focused"]
        .some((key) => typeof (n as unknown as Record<string, unknown>)[key] !== "boolean")
    ) throw Error("Malformed Android UI node.");
  }
  return schema;
}

export async function clickAndroidUiElement(id: string, revision: number, elementId: string): Promise<{ ok: true; kind: "click" }> {
  const d = authenticatedAndroid(id);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000_000)
    throw Error("Invalid UI schema revision.");
  if (!/^0(?:[.]\d{1,2}){0,12}$/.test(elementId) || elementId.length > 48)
    throw Error("Invalid UI element path.");
  const [reply] = await request(d.host, d.port, d.fingerprint, {
    op: "element", pairId: d.pairId, pairToken: d.pairToken,
    sessionId: d.sessionId, sessionToken: d.sessionToken,
    kind: "click", revision, elementId,
  }, 5_000);
  if (!reply || reply.ok !== true || reply.accepted !== true || reply.kind !== "click")
    throw Error("Android refused stale or unauthorized element click.");
  return { ok: true, kind: "click" };
}

export const LAN_TRANSFER_MAX = 4 * 1024 * 1024;
export const LAN_TRANSFER_CHUNK = 4096;
function authFile(id: string) {
  const device = getSession(id);
  if (!device.sessionId || !device.sessionToken)
    throw Error("A physically approved LAN session is required for file transfer.");
  return device;
}
function fileEnvelope(device: SavedSession, op: string, additional: object = {}) {
  return { op, pairId: device.pairId, pairToken: device.pairToken,
    sessionId: device.sessionId, sessionToken: device.sessionToken, ...additional };
}
function checkedOffer(reply: Reply | undefined) {
  if (!reply || typeof reply.transferId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(reply.transferId)
      || typeof reply.name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}$/.test(reply.name)
      || reply.name.endsWith(".") || reply.name.endsWith(" ")
      || !Number.isInteger(reply.size) || Number(reply.size) < 1
      || Number(reply.size) > LAN_TRANSFER_MAX
      || typeof reply.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reply.sha256)
      || reply.chunkBytes !== LAN_TRANSFER_CHUNK)
    throw Error("Target rejected or returned invalid file metadata.");
  return { transferId: reply.transferId, name: reply.name, size: Number(reply.size),
    sha256: reply.sha256, chunkBytes: LAN_TRANSFER_CHUNK };
}
export async function offerLanFile(id: string, direction: "upload" | "download",
  metadata?: { name: string; size: number; sha256: string }) {
  const device = authFile(id);
  if (direction !== "upload" && direction !== "download") throw Error("Invalid transfer direction.");
  if (direction === "upload" && (!metadata || !/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}$/.test(metadata.name)
      || metadata.name.endsWith(".") || metadata.name.endsWith(" ")
      || !Number.isInteger(metadata.size) || metadata.size < 1 || metadata.size > LAN_TRANSFER_MAX
      || !/^[a-f0-9]{64}$/.test(metadata.sha256)))
    throw Error("Invalid upload metadata.");
  const [reply] = await request(device.host, device.port, device.fingerprint,
    fileEnvelope(device, "file_offer", { direction, ...metadata }), 110_000);
  return checkedOffer(reply);
}
export async function putLanFileChunk(id: string, transferId: string, seq: number, data: string) {
  const device = authFile(id);
  if (!/^[a-f0-9-]{36}$/i.test(transferId) || !Number.isInteger(seq) || seq < 0 || seq > 1024
      || typeof data !== "string" || !/^[A-Za-z0-9+/]{1,5464}={0,2}$/.test(data))
    throw Error("Invalid transfer chunk.");
  const [reply] = await request(device.host, device.port, device.fingerprint,
    fileEnvelope(device, "file_put", { transferId, seq, data }), 10_000);
  if (!reply || reply.ok !== true || reply.seq !== seq + 1
      || !Number.isInteger(reply.received) || Number(reply.received) > LAN_TRANSFER_MAX)
    throw Error("Target did not acknowledge the chunk.");
  return { received: Number(reply.received), seq: seq + 1 };
}
export async function getLanFileChunk(id: string, transferId: string, seq: number) {
  const device = authFile(id);
  if (!/^[a-f0-9-]{36}$/i.test(transferId) || !Number.isInteger(seq) || seq < 0 || seq > 1024)
    throw Error("Invalid chunk sequence.");
  const [reply] = await request(device.host, device.port, device.fingerprint,
    fileEnvelope(device, "file_get", { transferId, seq }), 10_000, 8192);
  if (!reply || reply.ok !== true || reply.seq !== seq || typeof reply.data !== "string"
      || !/^[A-Za-z0-9+/]{1,5464}={0,2}$/.test(reply.data)
      || !Number.isInteger(reply.received) || Number(reply.received) > LAN_TRANSFER_MAX)
    throw Error("Malformed or unauthenticated file chunk.");
  return { data: reply.data, received: Number(reply.received), seq };
}
export async function finalizeLanFile(id: string, transferId: string) {
  const device = authFile(id);
  if (!/^[a-f0-9-]{36}$/i.test(transferId)) throw Error("Invalid transfer handle.");
  const [reply] = await request(device.host, device.port, device.fingerprint,
    fileEnvelope(device, "file_finish", { transferId }), 20_000);
  if (!reply || reply.ok !== true || !Number.isInteger(reply.bytes) || Number(reply.bytes) > LAN_TRANSFER_MAX)
    throw Error("File not committed after verification.");
  return { ok: true, bytes: Number(reply.bytes), name: String(reply.name || ""),
    savedTo: typeof reply.savedTo === "string" ? reply.savedTo.slice(0, 256) : "" };
}
export async function abortLanFile(id: string, transferId: string): Promise<void> {
  const device = authFile(id);
  if (!/^[a-f0-9-]{36}$/i.test(transferId)) throw Error("Invalid transfer handle.");
  await request(device.host, device.port, device.fingerprint,
    fileEnvelope(device, "file_abort", { transferId }), 10_000);
}

export async function closeLanSession(id: string): Promise<void> {
  const d = getSession(id);
  if (!d.sessionToken) return;
  try {
    await request(d.host, d.port, d.fingerprint, {
      op: "close", pairId: d.pairId, pairToken: d.pairToken, sessionId: d.sessionId, sessionToken: d.sessionToken,
    }, 10_000);
  } finally {
    delete d.sessionId;
    delete d.sessionToken;
    // Android capture permission and input consent do not survive session close.
    // Remove the ephemeral paired handle as a fail-closed recovery choice.
    if (d.platform === "android") sessions.delete(id);
  }
}
export async function revokeLanDevice(id: string): Promise<void> {
  const d = getSession(id);
  try { await request(d.host, d.port, d.fingerprint, { op: "revoke", pairId: d.pairId, pairToken: d.pairToken }, 10_000); }
  finally { sessions.delete(id); }
}
/** A direct target probe inspects only the public TLS certificate. It does not
 * send app requests, authenticate the device, or authorize a support session. */
async function directTlsFingerprint(host: string): Promise<string | null> {
  if (!privateIntranetPeer(host)) return null;
  return await new Promise<string | null>((resolve) => {
    const transport = net.connect({ host, port: LAN_PORT, localAddress: outboundLanSource(host) });
    const socket = tls.connect({ socket: transport, rejectUnauthorized: false,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1700, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      finish(raw && privateIntranetPeer(host)
        ? crypto.createHash("sha256").update(raw).digest("hex") : null);
    });
  });
}
export interface DiscoveryResult {
  address: string; port: number; name: string; fingerprint: string;
  platform: "android" | "windows" | "unknown"; segmentTag: string;
  appVersion?: string; buildCode?: number;
  discoveryMode?: "tls-unverified";
}
export async function discoverLanDevices(segmentName: string, waitMs = 1500, targetIp?: string): Promise<DiscoveryResult[]> {
  // Fail closed before emitting even one UDP packet.
  const discoveryRequest = discoveryRequestForSegment(segmentName);
  const expectedTag = networkSegmentTag(segmentName);
  const results = new Map<string, DiscoveryResult>();
  if (targetIp !== undefined && !privateIntranetPeer(targetIp))
    throw Error("Direct target must be a private IPv4 on the same physical /16 intranet.");
  const interfaces = lanInterfaces().filter((adapter) => !targetIp ||
    adapter.address.split(".").slice(0, 2).join(".") === targetIp.split(".").slice(0, 2).join("."));
  await Promise.all(interfaces.map((adapter: LanInterface) => new Promise<void>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const stop = () => { if (settled) return; settled = true; socket.close(); resolve(); };
    socket.on("error", stop);
    socket.on("message", (buf, remote) => {
      if (targetIp ? (remote.address !== targetIp || remote.port !== LAN_PORT + 1)
        : !onLinkToPeer(remote.address)) return;
      try {
        const value: unknown = JSON.parse(buf.toString("utf8"));
        const device = parseSegmentDiscoveryResponse(value, remote.address, expectedTag);
        if (!device) return;
        const valueResult: DiscoveryResult = { address: remote.address, port: device.port,
          name: device.name, fingerprint: device.fingerprint,
          platform: device.platform, segmentTag: device.segmentTag,
          ...(device.appVersion ? { appVersion: device.appVersion } : {}),
          ...(device.buildCode ? { buildCode: device.buildCode } : {}) };
        results.set(remote.address + ":" + valueResult.port, valueResult);
      } catch {}
    });
    socket.bind(0, adapter.address, () => {
      try {
        if (targetIp) socket.send(discoveryRequest, LAN_PORT + 1, targetIp);
        else { socket.setBroadcast(true); socket.send(discoveryRequest, LAN_PORT + 1, adapter.broadcast); }
      }
      catch { stop(); }
    });
    setTimeout(stop, Math.max(200, Math.min(5000, waitMs))).unref?.();
  })));
  // Routed campus Wi-Fi can permit TLS while filtering UDP between subnets.
  // Never mistake a certificate-only observation for verified discovery.
  if (targetIp && !results.size) {
    const fingerprint = await directTlsFingerprint(targetIp);
    if (fingerprint) results.set(targetIp + ":" + LAN_PORT, {
      address: targetIp, port: LAN_PORT, name: "Direct TLS target (unverified)",
      fingerprint, platform: "unknown", segmentTag: expectedTag,
      discoveryMode: "tls-unverified",
    });
  }
  return [...results.values()];
}

