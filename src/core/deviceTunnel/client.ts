import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export interface DeviceTunnelEnrollment {
  url: string;
  inviteId: string;
  code: string;
}
export interface DeviceTunnelCredentials {
  deviceId: string;
  token: string;
}
export interface DeviceTunnelRelayOptions {
  enrollment: DeviceTunnelEnrollment;
  platform: "windows" | "android";
  name: string;
  fingerprint: string;
  localHost: string;
  localPort: number;
  signal?: AbortSignal;
  onNotice?: (message: string) => void;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Device Tunnel URL."); }
  const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp)
    throw new Error("Device Tunnel requires HTTPS except for loopback tests.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Device Tunnel URL must not contain credentials, query, or fragment.");
  return url.origin.replace(/\/$/, "");
}
function validEnrollment(value: DeviceTunnelEnrollment): DeviceTunnelEnrollment {
  const url = normalizeBaseUrl(value.url);
  if (!/^[a-f0-9-]{36}$/i.test(value.inviteId) || !/^\d{10}$/.test(value.code))
    throw new Error("Invalid Device Tunnel invitation.");
  return { url, inviteId: value.inviteId, code: value.code };
}
async function api(
  baseUrl: string,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path.endsWith("/poll") ? 35_000 : 15_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(baseUrl + path, { ...init, signal: controller.signal, redirect: "error" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success !== true)
      throw new Error(String(body?.error || "Device Tunnel HTTP " + response.status));
    return body;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function enrollDeviceTunnelClient(
  enrollment: DeviceTunnelEnrollment,
  identity: { platform: "windows" | "android"; name: string; fingerprint: string },
  signal?: AbortSignal,
): Promise<DeviceTunnelCredentials> {
  const setup = validEnrollment(enrollment);
  const name = identity.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  if (!name || !/^[a-f0-9]{64}$/i.test(identity.fingerprint))
    throw new Error("Invalid local device identity.");
  const response = await api(setup.url, "/api/device-tunnel/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inviteId: setup.inviteId,
      code: setup.code,
      name,
      platform: identity.platform,
      fingerprint: identity.fingerprint.toLowerCase(),
    }),
  }, signal);
  if (!response.device || typeof response.device.id !== "string"
      || !/^[a-f0-9-]{36}$/i.test(response.device.id)
      || typeof response.token !== "string" || !/^[a-f0-9]{64}$/.test(response.token))
    throw new Error("Malformed Device Tunnel enrollment response.");
  return { deviceId: response.device.id, token: response.token };
}

export async function relayLocalLanRequest(input: {
  host: string; port: number; fingerprint: string; body: Record<string, unknown>;
  maxReplyChars?: number; timeoutMs?: number;
}): Promise<Record<string, unknown>[]> {
  if (!/^[a-f0-9]{64}$/i.test(input.fingerprint)
      || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65534)
    throw new Error("Invalid local relay target.");
  return await new Promise((resolve, reject) => {
    const transport = net.connect({ host: input.host, port: input.port });
    const socket = tls.connect({ socket: transport, rejectUnauthorized: false,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    const frames: Record<string, unknown>[] = [];
    let text = "", done = false;
    const maxChars = Math.max(4096, Math.min(700 * 1024, input.maxReplyChars ?? 256 * 1024));
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      error ? reject(error) : resolve(frames);
    };
    socket.setTimeout(Math.max(2000, Math.min(120_000, input.timeoutMs ?? 120_000)),
      () => finish(new Error("Local Device Tunnel relay timed out.")));
    socket.once("error", (error) => finish(error));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      if (!raw) { finish(new Error("Local device TLS certificate missing.")); return; }
      const observed = crypto.createHash("sha256").update(raw).digest("hex");
      const expected = input.fingerprint.toLowerCase();
      if (observed.length !== expected.length
          || !crypto.timingSafeEqual(Buffer.from(observed), Buffer.from(expected))) {
        finish(new Error("Local device TLS fingerprint changed."));
        return;
      }
      socket.write(JSON.stringify(input.body) + "\n");
    });
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > maxChars) { finish(new Error("Local device reply exceeded bound.")); return; }
      while (text.includes("\n")) {
        const index = text.indexOf("\n");
        const line = text.slice(0, index); text = text.slice(index + 1);
        if (!line) continue;
        let frame: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("shape");
          frame = parsed;
        } catch {
          finish(new Error("Malformed local device reply."));
          return;
        }
        frames.push(frame);
        if (frame.event === "done" || (frame.ok !== undefined && frame.event !== "output")) {
          finish(); return;
        }
      }
    });
    socket.once("end", () => {
      if (!done) finish(frames.length ? undefined : new Error("Local device closed without response."));
    });
  });
}

export async function runDeviceTunnelRelay(
  options: DeviceTunnelRelayOptions,
): Promise<DeviceTunnelCredentials> {
  const setup = validEnrollment(options.enrollment);
  options.enrollment.code = "";
  const credentials = await enrollDeviceTunnelClient(setup, {
    platform: options.platform, name: options.name, fingerprint: options.fingerprint,
  }, options.signal);
  setup.code = "";
  options.onNotice?.("Device Tunnel enrolled. Reverse HTTPS relay is active.");

  const authHeaders = {
    "Authorization": "Device " + credentials.token,
    "X-SuperAgent-Device-Id": credentials.deviceId,
    "Content-Type": "application/json",
  };
  let failures = 0;
  while (!options.signal?.aborted) {
    try {
      const polled = await api(setup.url, "/api/device-tunnel/poll", {
        method: "POST", headers: authHeaders, body: JSON.stringify({ waitMs: 25_000 }),
      }, options.signal);
      failures = 0;
      const job = polled.request;
      if (!job) continue;
      if (typeof job.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(job.requestId)
          || !job.body || typeof job.body !== "object" || Array.isArray(job.body)
          || !Number.isSafeInteger(job.maxReplyChars) || job.maxReplyChars < 4096
          || job.maxReplyChars > 700 * 1024) {
        throw new Error("Malformed Core tunnel request.");
      }
      let frames: Record<string, unknown>[];
      try {
        frames = await relayLocalLanRequest({
          host: options.localHost, port: options.localPort,
          fingerprint: options.fingerprint, body: job.body,
          maxReplyChars: job.maxReplyChars,
        });
      } catch (error) {
        frames = [{ ok: false, error: error instanceof Error ? error.message.slice(0, 180) : "Local relay failed." }];
      }
      await api(setup.url, "/api/device-tunnel/reply", {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ requestId: job.requestId, frames }),
      }, options.signal);
    } catch (error) {
      if (options.signal?.aborted) break;
      failures++;
      options.onNotice?.("Device Tunnel reconnecting after transport error.");
      const delay = Math.min(10_000, 500 * Math.pow(2, Math.min(5, failures)));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return credentials;
}
