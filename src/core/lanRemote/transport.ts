import crypto from "node:crypto";
import dgram from "node:dgram";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import tls, { type TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import forge from "node-forge";
import { LanTargetFiles, safeLanFilename, LAN_FILE_MAX_BYTES } from "./fileTransfer.js";
import { isSegmentDiscoveryRequest, networkSegmentTag } from "./networkSegment.js";

export const LAN_PORT = 17845;
export const PAIR_WINDOW_MS = 120_000;
export const MAX_WIRE_BYTES = 8192;
export const SESSION_IDLE_MS = 10 * 60_000;
export const SESSION_MAX_MS = 60 * 60_000;

export interface LanInterface { name: string; address: string; netmask: string; broadcast: string }
const VIRTUAL = /(^|[\s_-])(vpn|wsl|virtual|vEthernet|docker|hyper-v|tailscale|zerotier|hamachi|vmware|virtualbox|loopback|tunnel|bluetooth)([\s_-]|$)/i;

export function ipv4Value(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((s) => !/^(0|[1-9][0-9]{0,2})$/.test(s) || Number(s) > 255)) return null;
  return parts.reduce((v, s) => ((v << 8) | Number(s)) >>> 0, 0);
}
export function privateV4(address: string): boolean {
  const v = ipv4Value(address);
  if (v === null) return false;
  return ((v & 0xff000000) >>> 0) === 0x0a000000
    || ((v & 0xfff00000) >>> 0) === 0xac100000
    || ((v & 0xffff0000) >>> 0) === 0xc0a80000;
}
let physicalNamesCache: { at: number; names: Set<string> } | null = null;
function physicalAdapterNames(): Set<string> | null {
  if (process.platform !== "win32") return null;
  if (physicalNamesCache && Date.now() - physicalNamesCache.at < 15_000) return physicalNamesCache.names;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty Name"
  ], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16_384 });
  // Fail closed if Windows native physical-adapter inspection is unavailable.
  const names = new Set<string>();
  if (!result.error && result.status === 0) {
    for (const name of result.stdout.split(/\r?\n/)) {
      if (name.trim()) names.add(name.trim().toLowerCase());
    }
  }
  physicalNamesCache = { at: Date.now(), names };
  return names;
}
export function lanInterfaces(): LanInterface[] {
  const result: LanInterface[] = [];
  const physical = physicalAdapterNames();
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (physical && !physical.has(name.toLowerCase())) continue;
    if (VIRTUAL.test(name) || !entries) continue;
    for (const item of entries) {
      if (item.family !== "IPv4" || item.internal || !privateV4(item.address)) continue;
      const ip = ipv4Value(item.address);
      const mask = ipv4Value(item.netmask);
      if (ip === null || mask === null || mask === 0 || mask === 0xffffffff) continue;
      const broadcast = ((ip & mask) | (~mask >>> 0)) >>> 0;
      result.push({ name, address: item.address, netmask: item.netmask, broadcast: [broadcast >>> 24, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join(".") });
    }
  }
  return result;
}
export function sameOnLink(localAddress: string, mask: string, peerAddress: string): boolean {
  const l = ipv4Value(localAddress), m = ipv4Value(mask), p = ipv4Value(peerAddress);
  return l !== null && m !== null && p !== null && privateV4(localAddress)
    && privateV4(peerAddress) && ((l & m) >>> 0) === ((p & m) >>> 0);
}
export function onLinkToPeer(peerAddress: string): boolean {
  return lanInterfaces().some((i) => sameOnLink(i.address, i.netmask, peerAddress));
}

/** Explicitly addressed peers may cross a subnet only within the same private
 * /16 allocation. Discovery tags are NOT authentication; TLS pinning, a fresh
 * code, and physical consent remain mandatory. */
export function samePrivateIntranetAllocation(localAddress: string, peerAddress: string): boolean {
  const local = ipv4Value(localAddress), peer = ipv4Value(peerAddress);
  return local !== null && peer !== null && privateV4(localAddress)
    && privateV4(peerAddress) && (local >>> 16) === (peer >>> 16);
}
export function privateIntranetPeer(peerAddress: string): boolean {
  return lanInterfaces().some((adapter) =>
    samePrivateIntranetAllocation(adapter.address, peerAddress));
}
/** Bind outbound TLS to a currently verified physical adapter in the peer's
 * private /16 allocation. Do not use the OS default route's source address,
 * which may belong to another adapter and be rejected by the target. */
export function outboundLanSource(peerAddress: string): string {
  const candidates = lanInterfaces().filter((adapter) =>
    samePrivateIntranetAllocation(adapter.address, peerAddress));
  const exact = candidates.find((adapter) =>
    sameOnLink(adapter.address, adapter.netmask, peerAddress));
  const chosen = exact ?? candidates[0];
  if (!chosen) throw new Error("No approved physical private interface for LAN target.");
  return chosen.address;
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function token(): string { return crypto.randomBytes(32).toString("hex"); }
function fail(socket: TLSSocket, message: string): void { send(socket, { ok: false, error: message }); }
function send(socket: TLSSocket, message: object): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
}
function certificate(): { cert: string; key: string; fingerprint: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(12).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000);
  cert.setSubject([{ name: "commonName", value: "SuperAgent LAN Client (temporary)" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex"),
  };
}
export interface ApprovalRequest { kind: "pair" | "session" | "file-upload" | "file-download"; controller: string; ip: string; expiresInSeconds: number; detail?: string }
export interface ServerOptions {
  host: string;
  /** Mandatory; missing/invalid segment rejects before any network listener starts. */
  segmentName: string;
  port?: number;
  code?: string;
  onApproval: (request: ApprovalRequest) => Promise<boolean>;
  onNotice?: (message: string) => void;
  // Optional isolated receive destination for regression fixtures, not a remote client path.
  transferDirectory?: string;
  now?: () => number;
}
interface PairedDevice { id: string; secret: string; ip: string; label: string }
interface ActiveSession { id: string; secret: string; pairId: string; ip: string; created: number; lastUsed: number }
export interface LanServerHandle {
  port: number; host: string; code: string; fingerprint: string;
  close(): Promise<void>; revoke(): void; rotatePairCode(): string;
  shareSelectedFile(filePath: string): Promise<{ name: string; size: number }>;
  shareSelectedFolder(folderPath: string): Promise<{ name: string; size: number; files: number }>;
  state(): { paired: number; sessionActive: boolean; sharing?: { name: string; size: number } | null };
}
export async function startLanServer(options: ServerOptions): Promise<LanServerHandle> {
  const segmentTag = networkSegmentTag(options.segmentName);
  const interfaces = lanInterfaces();
  const adapter = interfaces.find((item) => item.address === options.host);
  if (!adapter) throw new Error("Choose a verified physical private IPv4 adapter; wildcard, loopback and VPN are not allowed.");
  const keypair = certificate();
  let code = options.code ?? crypto.randomInt(0, 100_000_000).toString().padStart(8, "0");
  if (!/^[0-9]{8}$/.test(code)) throw new Error("Invalid pairing code.");
  const now = options.now || Date.now;
  let codeExpires = now() + PAIR_WINDOW_MS;
  let attempts = 0;
  const devices = new Map<string, PairedDevice>();
  let session: ActiveSession | null = null;
  let busy = false;
  const files = new LanTargetFiles(options.transferDirectory);
  let activeChild: ChildProcess | null = null;
  const sockets = new Set<TLSSocket>();
  const notice = options.onNotice || (() => {});
  function abortChild() {
    if (!activeChild || !activeChild.pid) return;
    const pid = activeChild.pid;
    try { activeChild.kill(); } catch {}
    if (process.platform === "win32") {
      const reaper = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      reaper.on("error", () => {});
    }
  }
  function revoke() {
    devices.clear(); session = null; files.clear(); abortChild();
    notice("All paired devices and sessions revoked.");
  }
  const server = tls.createServer({
    key: keypair.key, cert: keypair.cert, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    requestCert: false,
  }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const ip = (socket.remoteAddress || "").replace(/^::ffff:/, "");
    const localIp = (socket.localAddress || "").replace(/^::ffff:/, "");
    if (localIp !== adapter.address || !privateIntranetPeer(ip)
        || !lanInterfaces().some((i) => i.name === adapter.name && i.address === adapter.address && i.netmask === adapter.netmask)) {
      socket.destroy();
      notice("Rejected a non-local or changed-network connection.");
      return;
    }
    socket.setTimeout(150_000, () => socket.destroy());
    let data = "";
    let received = false;
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > MAX_WIRE_BYTES) { socket.destroy(); return; }
      const pos = data.indexOf("\n");
      if (pos < 0) return;
      received = true;
      let request: Record<string, unknown>;
      try { request = JSON.parse(data.slice(0, pos)); }
      catch { fail(socket, "Invalid request."); socket.end(); return; }
      void handle(request, socket, ip).catch(() => { fail(socket, "Request denied."); socket.end(); });
    });
  });
  async function handle(req: Record<string, unknown>, socket: TLSSocket, ip: string): Promise<void> {
    const op = req.op;
    if (op === "pair") {
      if (req.segmentTag !== undefined && req.segmentTag !== segmentTag) {
        fail(socket, "Network segment mismatch."); socket.end(); return;
      }
      if (now() >= codeExpires || attempts >= 5) { fail(socket, "Pairing closed or expired."); socket.end(); return; }
      attempts++;
      if (typeof req.code !== "string" || !equal(req.code, code)
        || typeof req.label !== "string" || req.label.length < 1 || req.label.length > 60) {
        fail(socket, "Pairing rejected."); socket.end(); return;
      }
      const label = req.label.replace(/[^\w .-]/g, "").slice(0, 60);
      const allowed = await options.onApproval({ kind: "pair", controller: label, ip, expiresInSeconds: 90 });
      if (!allowed || socket.destroyed || now() >= codeExpires) { fail(socket, "Pairing not approved."); socket.end(); return; }
      const d: PairedDevice = { id: crypto.randomUUID(), secret: token(), ip, label };
      devices.set(d.id, d);
      notice("Paired controller " + label + " from " + ip);
      send(socket, { ok: true, pairId: d.id, pairToken: d.secret, platform: "windows", segmentTag });
      socket.end();
      return;
    }
    const device = typeof req.pairId === "string" ? devices.get(req.pairId) : null;
    if (!device || !equal(String(req.pairToken || ""), device.secret) || device.ip !== ip) {
      fail(socket, "Controller not paired."); socket.end(); return;
    }
    if (op === "open") {
      if (session) { fail(socket, "A support session is already active."); socket.end(); return; }
      const allowed = await options.onApproval({ kind: "session", controller: device.label, ip, expiresInSeconds: 90 });
      if (!allowed || socket.destroyed || session) { fail(socket, "Session not approved."); socket.end(); return; }
      session = { id: crypto.randomUUID(), secret: token(), pairId: device.id, ip, created: now(), lastUsed: now() };
      notice("Support session approved for " + device.label);
      send(socket, { ok: true, sessionId: session.id, sessionToken: session.secret });
      socket.end(); return;
    }
    if (op === "revoke") {
      revoke(); send(socket, { ok: true }); socket.end(); return;
    }
    if (!session || session.pairId !== device.id || session.ip !== ip
        || req.sessionId !== session.id || !equal(String(req.sessionToken || ""), session.secret)
        || now() - session.created > SESSION_MAX_MS || now() - session.lastUsed > SESSION_IDLE_MS) {
      session = null;
      fail(socket, "Session expired or denied."); socket.end(); return;
    }
    session.lastUsed = now();
    if (op === "close") {
      session = null; files.clear(); abortChild(); send(socket, { ok: true });
      socket.end(); notice("Support session closed."); return;
    }
    if (op === "file_offer") {
      if (busy) { fail(socket, "Target is busy."); socket.end(); return; }
      const direction = req.direction;
      if (direction !== "upload" && direction !== "download") {
        fail(socket, "Invalid file direction."); socket.end(); return;
      }
      try {
        // Snapshot source metadata before asking the user. Re-selecting a
        // different local file while an approval dialog is visible must not
        // silently switch which bytes are exported.
        const selectedAtPrompt = direction === "download" ? files.getShared() : null;
        const sessionAtPrompt = session;
        const name = direction === "upload" ? safeLanFilename(req.name)
          : selectedAtPrompt?.name;
        const size = direction === "upload" ? req.size : selectedAtPrompt?.size;
        if (!name || typeof size !== "number" || !Number.isInteger(size) ||
            size < 1 || size > LAN_FILE_MAX_BYTES) throw Error("Invalid transfer.");
        const allowed = await options.onApproval({
          kind: direction === "upload" ? "file-upload" : "file-download",
          controller: device.label, ip, expiresInSeconds: 90,
          detail: (direction === "upload" ? "Receive " : "Send ") + name + " (" + size + " bytes)",
        });
        const selectedNow = direction === "download" ? files.getShared() : null;
        if (!allowed || !session || session !== sessionAtPrompt ||
            session.pairId !== device.id || socket.destroyed ||
            (direction === "download" && (selectedNow?.name !== selectedAtPrompt?.name ||
              selectedNow?.size !== selectedAtPrompt?.size ||
              selectedNow?.sha256 !== selectedAtPrompt?.sha256))) {
          throw Error("File transfer not approved or the selected source/session changed.");
        }
        const metadata = files.offer(direction, direction === "upload" ? {
          name, size, sha256: req.sha256 as string,
        } : undefined);
        send(socket, { ok: true, ...metadata });
      } catch { fail(socket, "File offer denied, invalid, or another transfer active."); }
      socket.end(); return;
    }
    if (["file_put", "file_get", "file_finish", "file_abort"].includes(String(op))) {
      try {
        let reply: unknown;
        if (op === "file_put") reply = files.put(req.transferId, req.seq, req.data);
        else if (op === "file_get") reply = files.get(req.transferId, req.seq);
        else if (op === "file_finish") reply = await files.finish(req.transferId);
        else { files.abort(req.transferId); reply = { ok: true }; }
        send(socket, reply as object);
      } catch { fail(socket, "File transfer rejected; check session, sequence and SHA-256."); }
      socket.end(); return;
    }
    if (op !== "exec" || typeof req.command !== "string" || !req.command.trim() || req.command.length > 2000) {
      fail(socket, "Unknown operation or command limit exceeded."); socket.end(); return;
    }
    if (busy) { fail(socket, "Another command is running."); socket.end(); return; }
    busy = true;
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", req.command] : ["-c", req.command];
    // Explicitly run as the current desktop user: never elevate or install a service.
    const child = spawn(shell, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    notice("Executing command for " + device.label + " (contents not logged).");
    let bytes = 0;
    let terminated = false;
    const timeout = setTimeout(() => { terminated = true; abortChild(); }, 30_000);
    const output = (stream: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { terminated = true; abortChild(); return; }
      send(socket, { event: "output", stream, data: chunk.toString("utf8") });
    };
    child.stdout.on("data", (chunk: Buffer) => output("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => output("stderr", chunk));
    socket.once("close", () => { if (!terminated && activeChild === child) { terminated = true; abortChild(); } });
    let complete = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (complete) return; complete = true;
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      busy = false;
      send(socket, { event: "done", ok: !terminated && !error, exitCode, ...(terminated || error ? { error: error || "Command stopped by timeout/output/disconnect." } : {}) });
      socket.end();
    };
    child.once("error", (error: Error) => finish(null, error.message));
    child.once("close", (exitCode: number | null) => finish(exitCode));
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? LAN_PORT, adapter.address, () => { server.removeListener("error", reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  let udp: dgram.Socket | null = null;
  try {
    udp = dgram.createSocket("udp4");
    const listener = udp;
    listener.on("message", (msg, rinfo) => {
      if (!isSegmentDiscoveryRequest(msg, segmentTag) || !privateIntranetPeer(rinfo.address)) return;
      const body = Buffer.from(JSON.stringify({ version: 2, segmentTag, address: adapter.address, port, name: os.hostname().slice(0, 60), platform: "windows", fingerprint: keypair.fingerprint }));
      listener.send(body, rinfo.port, rinfo.address, () => {});
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.bind(port + 1, adapter.address, () => { listener.removeAllListeners("error"); resolve(); });
    });
  } catch { try { udp?.close(); } catch {} udp = null; }
  return {
    port, host: adapter.address, get code() { return code; }, fingerprint: keypair.fingerprint,
    rotatePairCode: () => {
      code = crypto.randomInt(0, 100_000_000).toString().padStart(8, "0");
      codeExpires = now() + PAIR_WINDOW_MS;
      attempts = 0;
      return code;
    },
    revoke,
    shareSelectedFile: (filePath) => files.shareSelectedFile(filePath),
    shareSelectedFolder: (folderPath) => files.shareSelectedFolder(folderPath),
    state: () => ({ paired: devices.size, sessionActive: Boolean(session), sharing: files.getShared() }),
    close: async () => {
      revoke();
      const discovery = udp;
      if (discovery) try { discovery.close(); } catch {}
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

