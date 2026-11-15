import crypto from "node:crypto";
import { createDeviceTunnelInvite } from "./broker.js";
import { isFullYoloMode } from "../permissions.js";

/**
 * Camera-free TV bootstrap. The TV owns a secret poll token that is NEVER
 * encoded in its visible QR. A privileged local operator approves the QR
 * challenge; enrollment still requires the TV to accept a local prompt.
 */
interface Request {
  id: string;
  challenge: string;
  secretHash: string;
  name: string;
  expiresAt: number;
  setup?: { inviteId: string; code: string; expiresAt: number };
}

const TTL = 3 * 60_000;
const MAX_PENDING = 16;
const requests = new Map<string, Request>();
const hex64 = /^[a-f0-9]{64}$/i;
const uuid = /^[a-f0-9-]{36}$/i;
function cleanup() {
  for (const [id, request] of requests) if (request.expiresAt <= Date.now()) requests.delete(id);
}
function hash(value: string) { return crypto.createHash("sha256").update(value).digest(); }
function equalHash(a: string, b: string) {
  return crypto.timingSafeEqual(hash(a), hash(b));
}

export function requestTvTunnelBootstrap(input: { challenge: string; name: string }) {
  cleanup();
  if (!hex64.test(input.challenge) || !/^[\w .-]{1,60}$/.test(input.name))
    throw new Error("Invalid TV bootstrap identity.");
  if ([...requests.values()].some(r => r.challenge === input.challenge.toLowerCase()))
    throw new Error("TV bootstrap challenge already in use.");
  if (requests.size >= MAX_PENDING) throw new Error("Too many pending TV pairing requests.");
  const id = crypto.randomUUID();
  const pollToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TTL;
  requests.set(id, {
    id, challenge: input.challenge.toLowerCase(),
    secretHash: hash(pollToken).toString("hex"), name: input.name,
    expiresAt,
  });
  return { id, pollToken, expiresAt };
}

export function approveTvTunnelBootstrap(input: { id: string; challenge: string }) {
  if (!isFullYoloMode()) throw new Error("Full YOLO required to approve a TV pairing QR.");
  cleanup();
  if (!uuid.test(input.id) || !hex64.test(input.challenge))
    throw new Error("Invalid TV pairing QR.");
  const request = requests.get(input.id);
  if (!request || !equalHash(request.challenge, input.challenge.toLowerCase()))
    throw new Error("TV pairing request missing or challenge mismatch.");
  if (request.setup) throw new Error("TV pairing request already approved.");
  const invite = createDeviceTunnelInvite();
  request.setup = { inviteId: invite.inviteId, code: invite.code, expiresAt: invite.expiresAt };
  return { id: request.id, name: request.name, approved: true, expiresAt: request.expiresAt };
}

export function pollTvTunnelBootstrap(input: { id: string; pollToken: string }) {
  cleanup();
  if (!uuid.test(input.id) || !hex64.test(input.pollToken))
    throw new Error("Invalid TV pairing poll.");
  const request = requests.get(input.id);
  if (!request || !equalHash(request.secretHash, hash(input.pollToken).toString("hex")))
    throw new Error("TV pairing request expired or unknown.");
  if (!request.setup) return { state: "pending" as const };
  requests.delete(input.id);
  return { state: "approved" as const, ...request.setup };
}

export function resetTvTunnelBootstrapForTests() { requests.clear(); }
