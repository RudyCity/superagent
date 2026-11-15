import crypto from "node:crypto";
import QRCode from "qrcode";
import type { DeviceTunnelEnrollment } from "./client.js";

const UUID = /^[a-f0-9-]{36}$/i;
const HEX = /^[a-f0-9]{64}$/i;
const TTL_MS = 3 * 60_000;

export interface DisplayQrTicket {
  origin: string;
  id: string;
  challenge: string;
  expiresAt: number;
  /** Secret stays inside the receiver process; never emit to the UI or encode in QR. */
  pollToken: string;
}

export function normalizeDeviceQrOrigin(value: string): string {
  if (typeof value !== "string" || value.length > 240 || value !== value.trim())
    throw Error("Enter a clean HTTPS Core origin.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Error("Invalid Core HTTPS URL."); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port)
    throw Error("Core address must be a clean HTTPS origin without a path, port or credentials.");
  return parsed.origin;
}

async function post(origin: string, route: string, body: unknown, signal?: AbortSignal) {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), 10_000);
  const aborted = () => timer.abort();
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (signal?.aborted) throw Error("Device QR pairing was cancelled.");
    const response = await fetch(origin + route, {
      method: "POST", redirect: "error", signal: timer.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const bytes = Number(response.headers.get("content-length") || "0");
    if (bytes > 4096) throw Error("Device QR response too large.");
    if (!response.body) throw Error("Empty device QR response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 4096) throw Error("Device QR response too large.");
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
    const result = JSON.parse(raw) as Record<string, any>;
    if (!response.ok || result.success !== true)
      throw Error(typeof result.error === "string" ? result.error.slice(0, 150) : "Core rejected device QR request.");
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", aborted);
  }
}

export async function startDeviceQrRequest(originInput: string, name: string, signal?: AbortSignal):
  Promise<{ ticket: DisplayQrTicket; qrDataUrl: string; publicPayload: string }> {
  const origin = normalizeDeviceQrOrigin(originInput);
  if (!/^[A-Za-z0-9_ .-]{1,60}$/.test(name)) throw Error("Invalid device display name.");
  const challenge = crypto.randomBytes(32).toString("hex");
  const response = await post(origin, "/api/device-tunnel/tv/request", { challenge, name }, signal);
  const request = response.request;
  const expiresAt = request?.expiresAt;
  if (!UUID.test(request?.id) || !HEX.test(request?.pollToken)
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()
      || expiresAt > Date.now() + TTL_MS + 5_000)
    throw Error("Malformed device QR bootstrap response.");
  const ticket: DisplayQrTicket = {
    origin, id: request.id, challenge, expiresAt, pollToken: request.pollToken,
  };
  const publicPayload = JSON.stringify({
    k: "satv", v: 1, u: origin, i: ticket.id, h: challenge, e: expiresAt,
  });
  const qrDataUrl = await QRCode.toDataURL(publicPayload, {
    errorCorrectionLevel: "M", margin: 2, width: 320, type: "image/png",
  });
  if (!qrDataUrl.startsWith("data:image/png;base64,") || qrDataUrl.length > 180_000)
    throw Error("Failed to render device QR.");
  return { ticket, publicPayload, qrDataUrl };
}

export async function pollDeviceQrRequest(ticket: DisplayQrTicket, signal?: AbortSignal):
  Promise<{ state: "pending" } | { state: "approved"; enrollment: DeviceTunnelEnrollment }> {
  if (Date.now() >= ticket.expiresAt) throw Error("Device QR expired.");
  const response = await post(ticket.origin, "/api/device-tunnel/tv/poll", {
    id: ticket.id, pollToken: ticket.pollToken,
  }, signal);
  const answer = response.result;
  if (answer?.state === "pending") return { state: "pending" };
  if (answer?.state !== "approved" || !UUID.test(answer.inviteId)
      || typeof answer.code !== "string" || !/^\d{10}$/.test(answer.code)
      || !Number.isSafeInteger(answer.expiresAt)
      || answer.expiresAt <= Date.now() || answer.expiresAt > Date.now() + 11 * 60_000)
    throw Error("Invalid or expired device QR approval.");
  return { state: "approved", enrollment: {
    url: ticket.origin, inviteId: answer.inviteId, code: answer.code,
  } };
}
