/**
 * Foreground Windows QR intake. The webcam is read only by the user's browser;
 * the LAN Client receives only a one-use invite after explicit confirmation.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import type { DeviceTunnelEnrollment } from "./client.js";

export function parseWindowsTunnelQrPayload(raw: string, now = Date.now()): DeviceTunnelEnrollment {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 2048)
    throw Error("Connect QR payload is too large.");
  let item: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("format");
    item = value as Record<string, unknown>;
  } catch { throw Error("Use a Connect QR, not an APK download QR."); }
  const keys = Object.keys(item).sort().join(",");
  const qr = keys === "c,e,i,k,u,v" && item.k === "sat" && item.v === 1;
  const paste = keys === "code,inviteId,url";
  if (!qr && !paste) throw Error("Unsupported Device Tunnel QR format.");
  const rawUrl = qr ? item.u : item.url;
  const inviteId = qr ? item.i : item.inviteId;
  const code = qr ? item.c : item.code;
  if (typeof rawUrl !== "string" || typeof inviteId !== "string" || typeof code !== "string"
      || !/^[a-f0-9-]{36}$/i.test(inviteId) || !/^[0-9]{10}$/.test(code))
    throw Error("Invalid Device Tunnel invitation.");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw Error("Invalid HTTPS endpoint."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/" || url.port)
    throw Error("Device Tunnel requires a clean HTTPS origin.");
  if (qr && (!Number.isSafeInteger(item.e) || Number(item.e) <= now
      || Number(item.e) > now + 11 * 60_000))
    throw Error("Connect QR expired. Generate a fresh QR.");
  return { url: url.origin, inviteId, code };
}

function browserScan() {
  const $ = (id: string) => document.getElementById(id)!;
  const note = (message: string) => { $("status").textContent = message; };
  let camera: MediaStream | null = null;
  let stop = false, selection: string | null = null;
  const closeCamera = () => {
    stop = true;
    camera?.getTracks().forEach((track) => track.stop());
    camera = null;
    ( $("video") as HTMLVideoElement ).srcObject = null;
  };
  const picked = (raw: string) => {
    try {
      const item = JSON.parse(raw);
      const qr = item.k === "sat" && item.v === 1 && Number.isSafeInteger(item.e)
        && item.e > Date.now() && typeof item.u === "string"
        && typeof item.i === "string" && typeof item.c === "string";
      const paste = typeof item.url === "string" && typeof item.inviteId === "string"
        && typeof item.code === "string";
      if (!qr && !paste) throw Error("Use Create connect QR, not APK download QR.");
      const url = new URL(qr ? item.u : item.url);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.search ||
          url.hash || url.username || url.password || url.port) throw Error("Invalid endpoint.");
      selection = raw;
      $("host").textContent = url.origin;
      $("confirmation").hidden = false;
      ( $("connect") as HTMLButtonElement ).disabled = false;
      closeCamera();
      note("Check the HTTPS host above, then confirm connecting.");
    } catch (error) {
      selection = null;
      ( $("connect") as HTMLButtonElement ).disabled = true;
      note(error instanceof Error ? error.message : "Invalid QR code.");
    }
  };
  $("camera").addEventListener("click", async () => {
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
      note("Browser cannot scan the camera QR. Try current Chrome, an image, or paste setup JSON.");
      return;
    }
    try {
      stop = false;
      camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const video = $("video") as HTMLVideoElement;
      video.hidden = false; video.srcObject = camera;
      await video.play();
      const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
      note("Aim this laptop's camera at the Connect QR in SuperAgent Tray.");
      while (!stop) {
        const found = await detector.detect(video);
        if (found.length) { picked(found[0].rawValue || ""); break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch { note("Camera unavailable or denied. Use a QR image or paste setup JSON."); }
    finally { closeCamera(); }
  });
  $("qr-file").addEventListener("change", async () => {
    const file = ( $("qr-file") as HTMLInputElement ).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { note("QR image too large."); return; }
    if (!("BarcodeDetector" in window)) { note("Use Chrome or paste setup JSON."); return; }
    try {
      const image = await createImageBitmap(file);
      const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
      const found = await detector.detect(image);
      image.close();
      if (!found.length) throw Error("No QR found in the image.");
      picked(found[0].rawValue || "");
    } catch { note("Cannot read QR from that image."); }
  });
  $("paste").addEventListener("click", () => picked(( $("raw") as HTMLTextAreaElement ).value));
  $("connect").addEventListener("click", async () => {
    if (!selection) return;
    ( $("connect") as HTMLButtonElement ).disabled = true;
    try {
      const answer = await fetch("/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "X-SuperAgent-QR-CSRF": (document.querySelector('meta[name="qr-token"]') as HTMLMetaElement).content },
        body: JSON.stringify({ payload: selection }),
      });
      const result = await answer.json();
      if (!answer.ok || !result.ok) throw Error(result.error || "Connection rejected.");
      selection = null;
      ( $("raw") as HTMLTextAreaElement ).value = "";
      note("Invitation accepted. Return to the Windows client console for pairing approval.");
    } catch (error) {
      ( $("connect") as HTMLButtonElement ).disabled = false;
      note(error instanceof Error ? error.message : "Connection failed.");
    }
  });
  window.addEventListener("pagehide", closeCamera);
}

function page(csrf: string, nonce: string) {
  const css = "body{color-scheme:dark;max-width:720px;margin:35px auto;padding:0 20px;background:#0b111c;color:#e9edf7;font:15px/1.6 system-ui}h1{letter-spacing:-.04em;font-size:29px}p{color:#adbad0}main{background:#111c2b;border:1px solid #36465c;border-radius:16px;padding:22px}button{border:1px solid #537299;border-radius:9px;background:#246bd0;color:white;padding:12px 18px;min-height:46px;font-weight:600;cursor:pointer;margin:6px 10px 6px 0}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid #9cc2ff;outline-offset:3px}textarea{box-sizing:border-box;width:100%;min-height:82px;border-radius:8px;background:#09121e;color:white;border:1px solid #415572;padding:12px}video{display:block;width:100%;max-width:480px;background:black;margin-top:10px}input{display:block;margin:10px 0}label{display:block;margin-top:18px}#confirmation{border:1px solid #526c8d;border-radius:10px;padding:12px;margin:12px 0;overflow-wrap:anywhere}[hidden]{display:none!important}";
  const js = "(" + browserScan.toString() + ")();";
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="qr-token" content="' + csrf + '"><title>SuperAgent Windows QR pairing</title><style nonce="' + nonce + '">' + css + '</style></head><body>' +
    '<h1>Connect this Windows laptop</h1><p>On the controller laptop, open SuperAgent Tray → LAN Devices → Device Tunnel → Create connect QR. Camera frames stay here; pairing still requires approval.</p>' +
    '<main><button id="camera">Scan using camera</button><video id="video" playsinline muted hidden></video>' +
    '<label for="qr-file">Or choose an image of the Connect QR</label><input id="qr-file" type="file" accept="image/png,image/jpeg,image/webp">' +
    '<label for="raw">Or paste the QR payload / copied setup JSON</label><textarea id="raw" autocomplete="off" spellcheck="false"></textarea>' +
    '<button id="paste">Use pasted code</button><div id="confirmation" hidden>Verify HTTPS destination: <strong id="host"></strong><p>Only connect to your trusted SuperAgent Tray host.</p></div>' +
    '<button id="connect" disabled>Connect to verified host</button><p id="status" role="status" aria-live="polite">Scan a QR or paste a code to begin.</p></main>' +
    '<script nonce="' + nonce + '">' + js + '</script></body></html>';
}
export async function startWindowsQrConnectCapture(options: {
  timeoutMs?: number; openBrowser?: boolean;
} = {}): Promise<{ url: string; setup: Promise<DeviceTunnelEnrollment>; close: () => void }> {
  const csrf = crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(16).toString("base64");
  let resolve!: (value: DeviceTunnelEnrollment) => void;
  let reject!: (reason: Error) => void;
  const setup = new Promise<DeviceTunnelEnrollment>((ok, fail) => { resolve = ok; reject = fail; });
  let port = 0, consumed = false;
  const server = http.createServer(async (req, res) => {
    const origin = "http://127.0.0.1:" + port;
    const headers = {
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; media-src blob:; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(self)",
    };
    const send = (status: number, data: Record<string, unknown>) => {
      res.writeHead(status, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== "127.0.0.1:" + port) {
      send(403, { ok: false, error: "Local browser required." }); return;
    }
    if (req.method === "GET" && req.url === "/" &&
        (!req.headers["sec-fetch-site"] || ["none", "same-origin"].includes(String(req.headers["sec-fetch-site"])))) {
      res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
      res.end(page(csrf, nonce)); return;
    }
    if (req.method !== "POST" || req.url !== "/connect") {
      send(404, { ok: false, error: "Unknown QR operation." }); return;
    }
    if (consumed) { send(410, { ok: false, error: "QR intake already used." }); return; }
    if (req.headers.origin !== origin || req.headers["x-superagent-qr-csrf"] !== csrf ||
        !String(req.headers["content-type"]).startsWith("application/json")) {
      send(403, { ok: false, error: "Unauthorized local request." }); return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body, "utf8") > 4096) throw Error("QR request too large.");
      }
      const item = JSON.parse(body) as Record<string, unknown>;
      if (!item || Array.isArray(item) || Object.keys(item).join(",") !== "payload" ||
          typeof item.payload !== "string") throw Error("Invalid request.");
      const enrollment = parseWindowsTunnelQrPayload(item.payload);
      consumed = true; send(200, { ok: true }); resolve(enrollment);
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message.slice(0, 140) : "Invalid QR." });
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail); server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw Error("Local QR intake unavailable."); }
  port = address.port;
  const timeout = setTimeout(() => {
    if (!consumed) {
      consumed = true;
      reject(Error("QR scan timed out. Run --tunnel-qr again."));
      server.close();
    }
  }, Math.min(600_000, Math.max(500, options.timeoutMs ?? 600_000)));
  const close = () => { clearTimeout(timeout); server.close(); };
  const url = "http://127.0.0.1:" + port + "/";
  if (options.openBrowser !== false && process.platform === "win32") {
    const explorer = spawn("explorer.exe", [url], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    explorer.on("error", () => { /* Local URL is also shown in CLI. */ });
    explorer.unref();
  }
  return { url, setup, close };
}
