import type http from "node:http";
import fs from "node:fs";
import { isFullYoloMode } from "../permissions.js";
import { pairTunnelDevice } from "../lanRemote/controller.js";
import { getAndroidApkDownloadTicket } from "./apkDownload.js";
import {
  authenticateDeviceTunnel,
  enrollDeviceTunnel,
  pollDeviceTunnel,
  submitDeviceTunnelReply,
  type DeviceTunnelPlatform,
} from "./broker.js";

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}
async function readBounded(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("DEVICE_TUNNEL_BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function rejectBrowser(req: http.IncomingMessage): boolean {
  return Boolean(req.headers.origin || req.headers.referer);
}
function deviceCredentials(req: http.IncomingMessage): { id: string; token: string } | null {
  const id = String(req.headers["x-superagent-device-id"] || "");
  const auth = String(req.headers.authorization || "");
  const match = /^Device ([a-f0-9]{64})$/.exec(auth);
  if (!/^[a-f0-9-]{36}$/i.test(id) || !match) return null;
  return { id, token: match[1] };
}

export async function handleDeviceTunnelPublicRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/device-tunnel/")) return false;

  if (pathname === "/api/device-tunnel/ping") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { success: false, error: "DEVICE_TUNNEL_PING_GET_REQUIRED" });
      return true;
    }
    res.writeHead(204, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
    return true;
  }

  const apkMatch = /^\/api\/device-tunnel\/android-apk\/([a-f0-9]{64})$/.exec(pathname);
  if (apkMatch) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { success: false, error: "DEVICE_TUNNEL_APK_GET_REQUIRED" });
      return true;
    }
    try {
      const ticket = getAndroidApkDownloadTicket(apkMatch[1]);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": `attachment; filename="${ticket.filename}"`,
        "Content-Length": String(ticket.size),
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-SuperAgent-APK-SHA256": ticket.sha256,
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(ticket.filePath).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "APK download rejected.";
      json(res, /expired|unknown|exhausted/i.test(message) ? 410 : 404, {
        success: false, error: message.slice(0, 160),
      });
    }
    return true;
  }
  if (rejectBrowser(req)) {
    json(res, 403, { success: false, error: "DEVICE_TUNNEL_BROWSER_ORIGIN_DENIED" });
    return true;
  }
  if (req.method !== "POST") {
    json(res, 405, { success: false, error: "DEVICE_TUNNEL_POST_REQUIRED" });
    return true;
  }
  try {
    if (pathname === "/api/device-tunnel/enroll") {
      const raw = await readBounded(req, 4096);
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (!body || Array.isArray(body)
        || Object.keys(body).sort().join(",") !== "code,fingerprint,inviteId,name,platform"
        || typeof body.inviteId !== "string" || typeof body.code !== "string"
        || typeof body.name !== "string" || typeof body.fingerprint !== "string"
        || (body.platform !== "windows" && body.platform !== "android")) {
        json(res, 400, { success: false, error: "DEVICE_TUNNEL_INVALID_ENROLLMENT" });
        return true;
      }
      const enrolled = enrollDeviceTunnel({
        inviteId: body.inviteId,
        code: body.code,
        name: body.name,
        platform: body.platform as DeviceTunnelPlatform,
        fingerprint: body.fingerprint,
      });
      json(res, 200, { success: true, device: enrolled.device, token: enrolled.token });
      return true;
    }

    const auth = deviceCredentials(req);
    if (!auth) {
      json(res, 401, { success: false, error: "DEVICE_TUNNEL_AUTH_REQUIRED" });
      return true;
    }
    const authenticated = authenticateDeviceTunnel(auth.id, auth.token);

    if (pathname === "/api/device-tunnel/qr-pair") {
      if (!isFullYoloMode()) {
        json(res, 403, { success: false, error: "DEVICE_TUNNEL_FULL_YOLO_REQUIRED" });
        return true;
      }
      const raw = await readBounded(req, 2048);
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (!body || Array.isArray(body)
        || Object.keys(body).sort().join(",") !== "code,controller,fingerprint"
        || typeof body.code !== "string" || !/^\d{8}$/.test(body.code)
        || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(body.fingerprint)
        || typeof body.controller !== "string" || !/^[A-Za-z0-9_ .-]{1,60}$/.test(body.controller)) {
        json(res, 400, { success: false, error: "DEVICE_TUNNEL_INVALID_QR_PAIR" });
        return true;
      }
      if (body.fingerprint.toLowerCase() !== authenticated.fingerprint) {
        json(res, 409, { success: false, error: "DEVICE_TUNNEL_FINGERPRINT_MISMATCH" });
        return true;
      }
      const device = await pairTunnelDevice({
        tunnelId: auth.id, code: body.code, fingerprint: body.fingerprint, controller: body.controller,
      });
      json(res, 200, { success: true, device });
      return true;
    }

    if (pathname === "/api/device-tunnel/poll") {
      const raw = await readBounded(req, 512);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (!body || Array.isArray(body)
        || Object.keys(body).some((key) => key !== "waitMs")
        || (body.waitMs !== undefined
          && (!Number.isSafeInteger(body.waitMs) || Number(body.waitMs) < 1000 || Number(body.waitMs) > 30_000))) {
        json(res, 400, { success: false, error: "DEVICE_TUNNEL_INVALID_POLL" });
        return true;
      }
      const request = await pollDeviceTunnel(auth.id, auth.token,
        body.waitMs === undefined ? 25_000 : Number(body.waitMs));
      json(res, 200, { success: true, request });
      return true;
    }

    if (pathname === "/api/device-tunnel/reply") {
      const raw = await readBounded(req, 700 * 1024);
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (!body || Array.isArray(body)
        || Object.keys(body).sort().join(",") !== "frames,requestId"
        || typeof body.requestId !== "string" || !Array.isArray(body.frames)) {
        json(res, 400, { success: false, error: "DEVICE_TUNNEL_INVALID_REPLY" });
        return true;
      }
      submitDeviceTunnelReply(auth.id, auth.token, body.requestId, body.frames);
      json(res, 200, { success: true });
      return true;
    }

    json(res, 404, { success: false, error: "DEVICE_TUNNEL_ROUTE_NOT_FOUND" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Device tunnel request rejected.";
    const safe = message.replace(/\d{8,12}/g, "[code]").slice(0, 180);
    const status = /auth/i.test(message) ? 401 : /expired|unknown|rejected/i.test(message) ? 403 : 409;
    json(res, status, { success: false, error: safe });
    return true;
  }
}
