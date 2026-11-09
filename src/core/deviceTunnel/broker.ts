import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export type DeviceTunnelPlatform = "windows" | "android";

export interface DeviceTunnelPublicDevice {
  id: string;
  name: string;
  platform: DeviceTunnelPlatform;
  fingerprint: string;
  createdAt: number;
  lastSeen: number;
  online: boolean;
}

type PersistedDevice = Omit<DeviceTunnelPublicDevice, "online"> & { tokenHash: string };
type PersistedState = { version: 1; devices: PersistedDevice[] };
type Invite = {
  id: string; codeHash: string; createdAt: number; expiresAt: number; attempts: number;
};
type PendingRequest = {
  requestId: string;
  body: Record<string, unknown>;
  maxReplyChars: number;
  expiresAt: number;
};
type WaitingPoll = {
  resolve: (value: PendingRequest | null) => void;
  timer: ReturnType<typeof setTimeout>;
};
type AwaitingReply = {
  deviceId: string;
  resolve: (frames: unknown[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  maxReplyChars: number;
};

const INVITE_TTL_MS = 10 * 60_000;
const ONLINE_MS = 45_000;
const MAX_DEVICES = 32;
const MAX_QUEUE = 4;
const stateFile = () => path.join(getRootConfigDir(), "device-tunnel-peers.json");

const invites = new Map<string, Invite>();
const consumedInvites = new Map<string, number>();
const queues = new Map<string, PendingRequest[]>();
const pollers = new Map<string, WaitingPoll>();
const awaiting = new Map<string, AwaitingReply>();

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function readState(): PersistedState {
  try {
    const file = stateFile();
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size < 2 || st.size > 64 * 1024)
      throw new Error("DEVICE_TUNNEL_STATE_UNSAFE");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedState;
    if (raw.version !== 1 || !Array.isArray(raw.devices) || raw.devices.length > MAX_DEVICES)
      throw new Error("DEVICE_TUNNEL_STATE_INVALID");
    for (const d of raw.devices) {
      if (!d || !/^[a-f0-9-]{36}$/i.test(d.id)
        || typeof d.name !== "string" || d.name.length < 1 || d.name.length > 60
        || (d.platform !== "windows" && d.platform !== "android")
        || !/^[a-f0-9]{64}$/i.test(d.fingerprint)
        || !/^[a-f0-9]{64}$/.test(d.tokenHash)
        || !Number.isSafeInteger(d.createdAt) || d.createdAt < 1
        || !Number.isSafeInteger(d.lastSeen) || d.lastSeen < 0)
        throw new Error("DEVICE_TUNNEL_STATE_INVALID");
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, devices: [] };
    throw error;
  }
}
function writeState(state: PersistedState): void {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}
function cleanupInvites(now = Date.now()) {
  for (const [id, invite] of invites) if (invite.expiresAt <= now || invite.attempts >= 6) invites.delete(id);
  for (const [id, expiresAt] of consumedInvites) if (expiresAt <= now) consumedInvites.delete(id);
}
function publicDevice(d: PersistedDevice): DeviceTunnelPublicDevice {
  return { id: d.id, name: d.name, platform: d.platform, fingerprint: d.fingerprint,
    createdAt: d.createdAt, lastSeen: d.lastSeen, online: Date.now() - d.lastSeen <= ONLINE_MS };
}
function findDevice(id: string): PersistedDevice {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid tunnel device ID.");
  const device = readState().devices.find((d) => d.id === id);
  if (!device) throw new Error("Unknown tunnel device.");
  return device;
}
function updateLastSeen(id: string): PersistedDevice {
  const state = readState();
  const device = state.devices.find((d) => d.id === id);
  if (!device) throw new Error("Unknown tunnel device.");
  device.lastSeen = Date.now();
  writeState(state);
  return device;
}

export function createDeviceTunnelInvite(): {
  inviteId: string; code: string; createdAt: number; expiresAt: number;
} {
  cleanupInvites();
  const createdAt = Date.now();
  const inviteId = crypto.randomUUID();
  const code = crypto.randomInt(0, 10_000_000_000).toString().padStart(10, "0");
  invites.set(inviteId, {
    id: inviteId, codeHash: digest(code), createdAt,
    expiresAt: createdAt + INVITE_TTL_MS, attempts: 0,
  });
  return { inviteId, code, createdAt, expiresAt: createdAt + INVITE_TTL_MS };
}


export function getDeviceTunnelInviteStatus(inviteId: string): {
  valid: boolean; state: "active" | "used" | "missing"; expiresAt: number | null; remainingMs: number;
} {
  cleanupInvites();
  if (!/^[a-f0-9-]{36}$/i.test(inviteId)) return { valid: false, state: "missing", expiresAt: null, remainingMs: 0 };
  const invite = invites.get(inviteId);
  if (invite) {
    const remainingMs = Math.max(0, invite.expiresAt - Date.now());
    return { valid: remainingMs > 0 && invite.attempts < 6, state: "active", expiresAt: invite.expiresAt, remainingMs };
  }
  const consumedUntil = consumedInvites.get(inviteId);
  if (consumedUntil && consumedUntil > Date.now()) {
    return { valid: false, state: "used", expiresAt: consumedUntil, remainingMs: Math.max(0, consumedUntil - Date.now()) };
  }
  return { valid: false, state: "missing", expiresAt: null, remainingMs: 0 };
}

export function revokeDeviceTunnelInvite(inviteId: string): boolean {
  if (!/^[a-f0-9-]{36}$/i.test(inviteId)) return false;
  return invites.delete(inviteId);
}

export function enrollDeviceTunnel(input: {
  inviteId: string; code: string; name: string; platform: DeviceTunnelPlatform; fingerprint: string;
}): { device: DeviceTunnelPublicDevice; token: string } {
  cleanupInvites();
  if (!/^[a-f0-9-]{36}$/i.test(input.inviteId) || !/^\d{10}$/.test(input.code))
    throw new Error("Invalid tunnel invitation.");
  const invite = invites.get(input.inviteId);
  if (!invite) throw new Error("Tunnel invitation expired or unknown.");
  invite.attempts++;
  if (!safeEqualHex(invite.codeHash, digest(input.code))) {
    if (invite.attempts >= 6) invites.delete(invite.id);
    throw new Error("Tunnel invitation rejected.");
  }
  const name = input.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  if (!name || (input.platform !== "windows" && input.platform !== "android")
      || !/^[a-f0-9]{64}$/i.test(input.fingerprint))
    throw new Error("Invalid tunnel device identity.");

  const state = readState();
  if (state.devices.length >= MAX_DEVICES) throw new Error("Tunnel device registry is full.");
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const record: PersistedDevice = {
    id: crypto.randomUUID(), name, platform: input.platform,
    fingerprint: input.fingerprint.toLowerCase(), createdAt: now, lastSeen: now,
    tokenHash: digest(token),
  };
  state.devices.push(record);
  writeState(state);
  consumedInvites.set(invite.id, invite.expiresAt);
  invites.delete(invite.id);
  return { device: publicDevice(record), token };
}

export function authenticateDeviceTunnel(id: string, token: string): DeviceTunnelPublicDevice {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Tunnel device authentication failed.");
  const device = findDevice(id);
  if (!safeEqualHex(device.tokenHash, digest(token))) throw new Error("Tunnel device authentication failed.");
  return publicDevice(updateLastSeen(id));
}

export function listDeviceTunnelDevices(): DeviceTunnelPublicDevice[] {
  return readState().devices.map(publicDevice).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function revokeDeviceTunnel(id: string): void {
  const state = readState();
  const next = state.devices.filter((d) => d.id !== id);
  if (next.length === state.devices.length) throw new Error("Unknown tunnel device.");
  state.devices = next;
  writeState(state);
  const poller = pollers.get(id);
  if (poller) { clearTimeout(poller.timer); pollers.delete(id); poller.resolve(null); }
  for (const [requestId, pending] of awaiting) {
    if (pending.deviceId === id) {
      clearTimeout(pending.timer); awaiting.delete(requestId);
      pending.reject(new Error("Tunnel device revoked."));
    }
  }
  queues.delete(id);
}

function takeQueued(id: string): PendingRequest | null {
  const queue = queues.get(id);
  if (!queue?.length) return null;
  const now = Date.now();
  while (queue.length && queue[0].expiresAt <= now) queue.shift();
  const value = queue.shift() ?? null;
  if (!queue.length) queues.delete(id);
  return value;
}

export async function pollDeviceTunnel(id: string, token: string, waitMs = 25_000): Promise<PendingRequest | null> {
  authenticateDeviceTunnel(id, token);
  const immediate = takeQueued(id);
  if (immediate) return immediate;
  const previous = pollers.get(id);
  if (previous) { clearTimeout(previous.timer); previous.resolve(null); }
  return await new Promise<PendingRequest | null>((resolve) => {
    const timeout = Math.max(1000, Math.min(30_000, waitMs));
    const timer = setTimeout(() => {
      if (pollers.get(id)?.resolve === resolve) pollers.delete(id);
      resolve(null);
    }, timeout);
    pollers.set(id, { resolve, timer });
  });
}

export function submitDeviceTunnelReply(
  id: string, token: string, requestId: string, frames: unknown[],
): void {
  authenticateDeviceTunnel(id, token);
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || !Array.isArray(frames))
    throw new Error("Invalid tunnel reply.");
  const pending = awaiting.get(requestId);
  if (!pending) throw new Error("Tunnel request is no longer pending.");
  const encoded = JSON.stringify(frames);
  if (Buffer.byteLength(encoded, "utf8") > pending.maxReplyChars)
    throw new Error("Tunnel reply exceeded bounded response size.");
  clearTimeout(pending.timer);
  awaiting.delete(requestId);
  pending.resolve(frames);
}

export async function requestDeviceTunnel(
  id: string,
  body: Record<string, unknown>,
  maxWait = 120_000,
  maxReplyChars = 256 * 1024,
): Promise<unknown[]> {
  const device = findDevice(id);
  if (Date.now() - device.lastSeen > ONLINE_MS) throw new Error("Tunnel device is offline.");
  if (awaiting.size >= 64) throw new Error("Too many pending tunnel operations.");
  const queue = queues.get(id) ?? [];
  if (queue.length >= MAX_QUEUE) throw new Error("Tunnel device request queue is full.");
  const requestId = crypto.randomUUID();
  const wait = Math.max(1000, Math.min(120_000, maxWait));
  const expiresAt = Date.now() + wait;
  const job: PendingRequest = { requestId, body, maxReplyChars, expiresAt };

  return await new Promise<unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      awaiting.delete(requestId);
      const q = queues.get(id);
      if (q) {
        const ix = q.findIndex((item) => item.requestId === requestId);
        if (ix >= 0) q.splice(ix, 1);
        if (!q.length) queues.delete(id);
      }
      reject(new Error("Tunnel device request timed out."));
    }, wait);
    // Register completion before exposing the request to a waiting companion.
    awaiting.set(requestId, { deviceId: id, resolve, reject, timer, maxReplyChars });
    queue.push(job);
    queues.set(id, queue);
    const poller = pollers.get(id);
    if (poller) {
      const next = takeQueued(id);
      clearTimeout(poller.timer);
      pollers.delete(id);
      poller.resolve(next);
    }
  });
}

export function resetDeviceTunnelBrokerForTests(): void {
  for (const waiter of pollers.values()) { clearTimeout(waiter.timer); waiter.resolve(null); }
  for (const pending of awaiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("reset")); }
  invites.clear(); consumedInvites.clear(); queues.clear(); pollers.clear(); awaiting.clear();
}
