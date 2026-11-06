import crypto from "node:crypto";
import { privateIntranetPeer } from "./transport.js";
import { listLanDevices, pairLanDevice, type LanDevice } from "./controller.js";

export type LanPairRequestState =
  | "pending" | "completing" | "paired" | "failed" | "cancelled" | "expired";

export interface LanPairRequest {
  requestId: string;
  host: string;
  port: number;
  fingerprint: string;
  controller: string;
  segment?: string;
  state: LanPairRequestState;
  createdAt: number;
  expiresAt: number;
  deviceId?: string;
  error?: string;
}

type PairRequestRecord = LanPairRequest;

const REQUEST_TTL_MS = 5 * 60_000;
const RETAIN_MS = 10 * 60_000;
const requests = new Map<string, PairRequestRecord>();

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "LAN pairing failed.")
    .replace(/[a-f0-9]{64}/gi, "[fingerprint]")
    .replace(/\b\d{8}\b/g, "[code]")
    .slice(0, 220);
}

function cleanup(now = Date.now()) {
  const paired = listLanDevices();
  for (const [id, request] of requests) {
    if (request.state === "pending" || request.state === "completing") {
      const matching = paired.find((device) =>
        device.host === request.host && device.port === request.port &&
        device.fingerprint.toLowerCase() === request.fingerprint.toLowerCase());
      if (matching) {
        request.state = "paired";
        request.deviceId = matching.id;
        request.error = undefined;
      } else if (now >= request.expiresAt) {
        request.state = "expired";
        request.error = "Pairing request expired before local completion.";
      }
    }
    if (now - request.createdAt > RETAIN_MS) requests.delete(id);
  }
}

function validateInput(input: {
  host: string; port?: number; fingerprint: string; controller?: string; segment?: string;
}) {
  const port = input.port ?? 17845;
  if (!privateIntranetPeer(input.host))
    throw new Error("Target must be private IPv4 within the physical adapter's /16 intranet allocation.");
  if (!Number.isInteger(port) || port < 1024 || port > 65534)
    throw new Error("Invalid LAN port.");
  if (!/^[a-f0-9]{64}$/i.test(input.fingerprint))
    throw new Error("Full SHA-256 fingerprint required.");
  const controller = input.controller?.trim() || "SuperAgent MCP";
  if (!/^[A-Za-z0-9_ .-]{1,60}$/.test(controller))
    throw new Error("Invalid controller label.");
  const segment = input.segment?.trim();
  if (segment && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}$/.test(segment))
    throw new Error("Invalid network segment.");
  return { port, controller, segment };
}

export function createLanPairRequest(input: {
  host: string; port?: number; fingerprint: string; controller?: string; segment?: string;
}): LanPairRequest {
  cleanup();
  const checked = validateInput(input);
  const now = Date.now();
  const request: PairRequestRecord = {
    requestId: crypto.randomUUID(),
    host: input.host,
    port: checked.port,
    fingerprint: input.fingerprint.toLowerCase(),
    controller: checked.controller,
    ...(checked.segment ? { segment: checked.segment } : {}),
    state: "pending",
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
  };
  requests.set(request.requestId, request);
  return { ...request };
}

export function listLanPairRequests(): LanPairRequest[] {
  cleanup();
  return [...requests.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((request) => ({ ...request }));
}

export function getLanPairRequest(requestId: string): LanPairRequest {
  cleanup();
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("Invalid pairing request ID.");
  const request = requests.get(requestId);
  if (!request) throw new Error("Pairing request not found or no longer retained.");
  return { ...request };
}

export async function completeLanPairRequest(
  requestId: string,
  code: string,
): Promise<{ request: LanPairRequest; device: LanDevice }> {
  cleanup();
  if (!/^\d{8}$/.test(code)) throw new Error("Eight-digit pairing code required.");
  const request = requests.get(requestId);
  if (!request) throw new Error("Pairing request not found or no longer retained.");
  if (request.state !== "pending") throw new Error("Pairing request is not pending.");
  if (Date.now() >= request.expiresAt) {
    request.state = "expired";
    request.error = "Pairing request expired before local completion.";
    throw new Error(request.error);
  }

  request.state = "completing";
  request.error = undefined;
  try {
    const device = await pairLanDevice({
      host: request.host,
      port: request.port,
      code,
      fingerprint: request.fingerprint,
      controller: request.controller,
      segmentName: request.segment,
    });
    request.state = "paired";
    request.deviceId = device.id;
    return { request: { ...request }, device };
  } catch (error) {
    request.state = "failed";
    request.error = safeError(error);
    throw new Error(request.error);
  }
}

export function cancelLanPairRequest(requestId: string): LanPairRequest {
  cleanup();
  const request = requests.get(requestId);
  if (!request) throw new Error("Pairing request not found or no longer retained.");
  if (request.state !== "pending") throw new Error("Only a pending pairing request can be cancelled.");
  request.state = "cancelled";
  request.error = "Pairing request cancelled locally.";
  return { ...request };
}

export function resetLanPairRequestsForTests() {
  requests.clear();
}
