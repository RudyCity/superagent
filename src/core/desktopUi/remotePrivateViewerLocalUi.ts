/**
 * Viewer-machine-only HTTP UI for the existing mTLS desktop viewer SDK.
 * Not an MCP/host endpoint: never binds a public address, forwards a bearer,
 * discovers windows, exposes remote input, records frames, or retries TLS.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  connectRemotePrivateViewerClient,
  type RemotePrivateViewerClient,
  type RemotePrivateViewerClientOptions,
  type RemotePrivateViewerFrame,
} from "./remotePrivateViewerClient.js";
import {
  PRIVATE_VIEWER_CSS, PRIVATE_VIEWER_HTML, PRIVATE_VIEWER_LOCK_HTML,
  privateViewerBrowserMain,
} from "./remotePrivateViewerLocalUiHtml.js";

const FRAME_LIMIT = 3_000_000;
const COOKIE_NAME = "sa_viewer";
const HEX64 = /^[0-9a-f]{64}$/;
const PNG_START = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]);
const LOCAL_IP = "127.0.0.1";
const POLL_MS = 8_000;

export type RemotePrivateViewerLocalConnector = (
  options: RemotePrivateViewerClientOptions,
) => Promise<Pick<RemotePrivateViewerClient, "close" | "isConnected">>;

export interface RemotePrivateViewerLocalUiOptions {
  /** Material provisioned only on the viewer machine; never serialized to HTTP. */
  privateOptions: Omit<RemotePrivateViewerClientOptions, "onFrame">;
  /** Default 0: kernel allocates an unused loopback-only port. */
  localPort?: number;
  /** Injectable for bounded local tests; production uses the mTLS SDK. */
  connector?: RemotePrivateViewerLocalConnector;
  now?: () => number;
}

export interface RemotePrivateViewerLocalFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly capturedAtMs: number;
  readonly mime: "image/jpeg" | "image/png";
  readonly bytes: Uint8Array;
}

interface StoredFrame {
  sequence: number;
  width: number;
  height: number;
  capturedAtMs: number;
  mime: "image/jpeg" | "image/png";
  data: Buffer;
  digest: string;
}

export interface RemotePrivateViewerLocalUi {
  readonly url: string;
  /** Out-of-band terminal value. Never put in URL, HTML, script or logs. */
  readonly accessSecret: string;
  readonly port: number;
  readonly server: Server;
  /** Process-internal only, useful for an SDK consumer / focused tests. */
  acceptFrame: (frame: RemotePrivateViewerLocalFrame) => Promise<void>;
  stop: () => void;
  close: () => Promise<void>;
}

const PAGE_SCRIPT = "(" + privateViewerBrowserMain.toString() + ")();";

function reply(res: ServerResponse, status: number, body = "", mime = "text/plain; charset=utf-8"): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", mime);
  res.end(body);
}

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count;
}

function sameOriginHeaders(req: IncomingMessage, origin: string, mutating: boolean): boolean {
  if (headerCount(req, "host") !== 1 || req.headers.host !== origin.slice("http://".length) ||
      headerCount(req, "origin") > 1 || headerCount(req, "referer") > 1 ||
      headerCount(req, "cookie") > 1) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  if (mutating && req.headers.origin !== origin) return false;
  const referer = req.headers.referer;
  if (referer !== undefined) {
    try {
      const ref = new URL(referer);
      if (ref.origin !== origin || ref.username || ref.password) return false;
    } catch { return false; }
  }
  const fetchSite = req.headers["sec-fetch-site"];
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

function constantTimeHex(actual: string, expected: string): boolean {
  return HEX64.test(actual) && HEX64.test(expected) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function validFrame(frame: RemotePrivateViewerLocalFrame, previous: number, previousCaptured: number, now: number): boolean {
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= previous || frame.sequence > 0xffffffff ||
      !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > 1920 ||
      !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 1920 ||
      frame.width * frame.height > 2_073_600 ||
      !Number.isSafeInteger(frame.capturedAtMs) || frame.capturedAtMs <= previousCaptured ||
      frame.capturedAtMs < now - 5000 || frame.capturedAtMs > now + 1000 ||
      !(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength < 12 ||
      frame.bytes.byteLength > FRAME_LIMIT) return false;
  const b = frame.bytes;
  if (frame.mime === "image/jpeg") {
    return b[0] === 255 && b[1] === 216 &&
      b[b.length - 2] === 255 && b[b.length - 1] === 217;
  }
  if (frame.mime === "image/png") {
    return b.length >= 45 &&
      PNG_START.every((byte, index) => b[index] === byte) &&
      PNG_END.every((byte, index) => b[b.length - 8 + index] === byte);
  }
  return false;
}

/**
 * Starts only a loopback listener. Remote TLS connection is deferred until an
 * authenticated browser POST /api/start (a deliberate attended user gesture).
 */
export async function startRemotePrivateViewerLocalUi(
  options: RemotePrivateViewerLocalUiOptions,
): Promise<RemotePrivateViewerLocalUi> {
  if (!options || !options.privateOptions || (options.localPort !== undefined &&
      (!Number.isSafeInteger(options.localPort) || options.localPort < 0 || options.localPort > 65535))) {
    throw new Error("Private local viewer configuration denied.");
  }
  const now = options.now || Date.now;
  const expiry = options.privateOptions.credential?.expiresAt;
  if (!Number.isSafeInteger(expiry) || expiry <= now() || expiry > now() + 120_000) {
    throw new Error("Private local viewer lease denied.");
  }
  const accessSecret = randomBytes(32).toString("hex");
  const browserCookie = createHmac("sha256", accessSecret).update("local-browser-session-v1").digest("hex");
  const connector = options.connector || connectRemotePrivateViewerClient;
  let phase: "idle" | "connecting" | "active" | "stopped" = "idle";
  let client: Pick<RemotePrivateViewerClient, "close" | "isConnected"> | null = null;
  let frame: StoredFrame | null = null;
  let previousSequence = 0;
  let previousCaptured = 0;
  let pending: ServerResponse | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let transferring = false;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let port = 0;

  function clearPending(status = 410): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (pending) {
      const response = pending;
      pending = null;
      reply(response, status);
    }
  }

  function stop(): void {
    if (phase === "stopped") return;
    phase = "stopped";
    if (expiryTimer) clearTimeout(expiryTimer);
    if (liveTimer) clearInterval(liveTimer);
    expiryTimer = null; liveTimer = null;
    clearPending();
    if (frame) { frame.data.fill(0); frame = null; }
    client?.close();
    client = null;
    // Zeroize the mutable PEM copies supplied by the secure stdin pipe.
    for (const material of [options.privateOptions.clientKey,
      options.privateOptions.clientCert, options.privateOptions.trustedCa]) {
      if (Buffer.isBuffer(material)) material.fill(0);
    }
  }

  async function sendFrame(res: ServerResponse, current: StoredFrame): Promise<void> {
    transferring = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pending = null;
    try {
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        res.once("finish", () => { finished = true; resolve(); });
        res.once("close", () => { if (!finished) reject(new Error("Local browser disconnected.")); });
        res.statusCode = 200;
        res.setHeader("Content-Type", current.mime);
        res.setHeader("Content-Length", current.data.length);
        res.setHeader("X-Frame-Sequence", String(current.sequence));
        res.setHeader("X-Frame-Captured-At", String(current.capturedAtMs));
        res.setHeader("X-Frame-Width", String(current.width));
        res.setHeader("X-Frame-Height", String(current.height));
        res.setHeader("X-Frame-Sha256", current.digest);
        res.end(current.data);
      });
    } catch {
      stop();
      throw new Error("Local browser disconnected.");
    } finally {
      current.data.fill(0);
      transferring = false;
    }
  }

  async function acceptFrame(incoming: RemotePrivateViewerLocalFrame): Promise<void> {
    if (phase === "stopped" || (phase !== "active" && phase !== "connecting") ||
        !validFrame(incoming, previousSequence, previousCaptured, now())) {
      stop();
      throw new Error("Private viewer frame rejected.");
    }
    const copy = Buffer.from(incoming.bytes);
    const entry: StoredFrame = {
      sequence: incoming.sequence, width: incoming.width, height: incoming.height,
      capturedAtMs: incoming.capturedAtMs, mime: incoming.mime, data: copy,
      digest: createHash("sha256").update(copy).digest("hex"),
    };
    previousSequence = entry.sequence;
    previousCaptured = entry.capturedAtMs;
    if (frame) frame.data.fill(0);
    frame = entry;
    if (pending && !transferring) {
      frame = null;
      await sendFrame(pending, entry);
    }
  }

  function hasCookie(req: IncomingMessage): boolean {
    if (typeof req.headers.cookie !== "string" || req.headers.cookie.length > 1024) return false;
    const cookies = req.headers.cookie.split(";").map(part => part.trim());
    const matches = cookies.filter(part => part.startsWith(COOKIE_NAME + "="));
    return matches.length === 1 &&
      constantTimeHex(matches[0].slice(COOKIE_NAME.length + 1), browserCookie);
  }

  async function readUnlockBody(req: IncomingMessage): Promise<string | null> {
    const type = req.headers["content-type"];
    if (type !== "application/x-www-form-urlencoded") return null;
    const declared = req.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 256)) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += (chunk as Buffer).length;
        if (total > 256) return null;
        chunks.push(Buffer.from(chunk));
      }
      const data = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const fields = [...data.keys()];
      if (fields.length !== 1 || fields[0] !== "code") return null;
      return data.get("code");
    } catch { return null; }
  }

  const server = createServer((req, res) => {
    // Applied before even rejected responses, including frame binaries.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Same-origin referrers are safe here (no secrets in paths); Chrome otherwise
    // sends Origin: null for the local unlock form under no-referrer policy.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=()");
    res.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; " +
      "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    if (req.url === undefined || !req.url.startsWith("/") || req.url.startsWith("//") ||
        req.url.length > 256 || !sameOriginHeaders(req, "http://" + LOCAL_IP + ":" + port, req.method === "POST")) {
      reply(res, 403);
      return;
    }
    let parsed: URL;
    try { parsed = new URL(req.url, "http://" + LOCAL_IP + ":" + port); }
    catch { reply(res, 400); return; }
    const path = parsed.pathname;
    if (req.method === "GET" && path === "/viewer.css" && !parsed.search) {
      reply(res, 200, PRIVATE_VIEWER_CSS, "text/css; charset=utf-8");
      return;
    }
    if (req.method === "GET" && path === "/" && !parsed.search) {
      reply(res, 200, hasCookie(req) ? PRIVATE_VIEWER_HTML : PRIVATE_VIEWER_LOCK_HTML,
        "text/html; charset=utf-8");
      return;
    }
    if (req.method === "POST" && path === "/unlock" && !parsed.search) {
      void (async () => {
        if (phase === "stopped" || now() >= expiry) { reply(res, 410); return; }
        const code = await readUnlockBody(req);
        if (!code || !constantTimeHex(code, accessSecret)) { reply(res, 403); return; }
        res.setHeader("Set-Cookie", COOKIE_NAME + "=" + browserCookie +
          "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" +
          Math.max(1, Math.ceil((expiry - now()) / 1000)));
        res.setHeader("Location", "/");
        reply(res, 303);
      })().catch(() => reply(res, 403));
      return;
    }
    if (!hasCookie(req)) { reply(res, 403); return; }
    if (req.method === "GET" && path === "/viewer.js" && !parsed.search) {
      reply(res, 200, PAGE_SCRIPT, "text/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && path === "/api/status" && !parsed.search) {
      reply(res, 200, JSON.stringify({
        state: phase,
        frameSequence: previousSequence,
        capturedAtMs: previousCaptured,
        expiresAt: expiry,
      }), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "POST" && (path === "/api/start" || path === "/api/stop") &&
        !parsed.search && req.headers["x-viewer-request"] === "1" &&
        req.headers["content-type"] === "application/json" &&
        (req.headers["content-length"] === undefined ||
          (Number.isSafeInteger(Number(req.headers["content-length"])) &&
           Number(req.headers["content-length"]) <= 256))) {
      // Deliberately accept no posted data, even from authenticated browsers.
      if (req.headers["content-length"] && Number(req.headers["content-length"]) > 0) {
        let length = 0;
        req.on("data", data => {
          length += data.length;
          if (length > 256) req.destroy();
        });
      }
      if (path === "/api/stop") {
        stop();
        reply(res, 200, '{"state":"stopped"}', "application/json; charset=utf-8");
        return;
      }
      if (phase !== "idle" || now() >= expiry) { reply(res, 409); return; }
      phase = "connecting";
      const onFrame = (frameFromSdk: RemotePrivateViewerFrame) => acceptFrame({
        sequence: frameFromSdk.sequence, width: frameFromSdk.width,
        height: frameFromSdk.height, capturedAtMs: frameFromSdk.capturedAtMs,
        mime: "image/jpeg", bytes: frameFromSdk.jpeg,
      });
      void connector({ ...options.privateOptions, onFrame }).then(connected => {
        if (phase === "stopped" || now() >= expiry || !connected.isConnected) {
          connected.close();
          stop();
          reply(res, 410);
          return;
        }
        client = connected;
        phase = "active";
        liveTimer = setInterval(() => {
          if (!client?.isConnected || now() >= expiry) stop();
        }, 300);
        liveTimer.unref?.();
        reply(res, 200, '{"state":"active"}', "application/json; charset=utf-8");
      }).catch(() => {
        stop();
        reply(res, 403);
      });
      return;
    }
    if (req.method === "GET" && path === "/api/frame" && parsed.searchParams.size === 1 &&
        parsed.searchParams.has("after") && !transferring && phase === "active") {
      const text = parsed.searchParams.get("after") || "";
      if (!/^(0|[1-9]\d{0,9})$/.test(text) || Number(text) > 0xffffffff ||
          Number(text) > previousSequence) { reply(res, 400); return; }
      if (pending) { reply(res, 409); return; }
      if (frame && frame.sequence > Number(text)) {
        const current = frame;
        frame = null;
        void sendFrame(res, current).catch(() => {});
        return;
      }
      pending = res;
      pendingTimer = setTimeout(() => {
        if (pending === res) { pending = null; pendingTimer = null; reply(res, 204); }
      }, POLL_MS);
      pendingTimer.unref?.();
      res.once("close", () => {
        if (pending === res) {
          if (pendingTimer) clearTimeout(pendingTimer);
          pending = null; pendingTimer = null;
          stop();
        }
      });
      return;
    }
    reply(res, 404);
  });
  server.maxHeadersCount = 24;
  server.maxConnections = 8;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.localPort ?? 0, LOCAL_IP, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === "string" || addr.address !== LOCAL_IP) {
      throw new Error("Private local viewer refused non-loopback binding.");
    }
    port = addr.port;
  } catch (error) {
    server.close();
    throw error;
  }
  expiryTimer = setTimeout(stop, Math.max(1, expiry - now()));
  expiryTimer.unref?.();
  return {
    url: "http://" + LOCAL_IP + ":" + port,
    accessSecret, port, server, acceptFrame, stop,
    close: async () => {
      stop();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
