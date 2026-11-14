import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  startRemotePrivateViewerLocalUi,
  type RemotePrivateViewerLocalUi,
} from "../../src/core/desktopUi/remotePrivateViewerLocalUi.js";
import type {
  RemotePrivateViewerClientOptions,
  RemotePrivateViewerFrame,
} from "../../src/core/desktopUi/remotePrivateViewerClient.js";

const JPEG = await sharp({ create: { width: 2, height: 2, channels: 3,
  background: { r: 21, g: 68, b: 105 } } }).jpeg({ quality: 65 }).toBuffer();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUdclkYGBgYmBgYGBgAAAI7gDGjBRHogAAAABJRU5ErkJggg==",
  "base64",
);
const origin = (ui: RemotePrivateViewerLocalUi) => ui.url;
const postHeaders = (ui: RemotePrivateViewerLocalUi, cookie?: string) => ({
  Origin: origin(ui), "x-viewer-request": "1", "content-type": "application/json",
  ...(cookie ? { Cookie: cookie } : {}),
});
const post = (ui: RemotePrivateViewerLocalUi, path: string, cookie: string, originOverride?: string) =>
  fetch(ui.url + path, {
    method: "POST", redirect: "manual", headers: {
      ...postHeaders(ui, cookie),
      ...(originOverride ? { Origin: originOverride } : {}),
    },
    body: "{}",
  });
const get = (ui: RemotePrivateViewerLocalUi, path: string, cookie?: string, more?: Record<string, string>) =>
  fetch(ui.url + path, { redirect: "manual", headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...more,
  } });

describe("private remote desktop viewer browser UI (real 127.0.0.1)", () => {
  const handles: RemotePrivateViewerLocalUi[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map(handle => handle.close()));
  });

  async function setup(expiresIn = 60_000) {
    const close = vi.fn();
    let connected = true;
    let onFrame: RemotePrivateViewerClientOptions["onFrame"] | null = null;
    const connect = vi.fn(async (args: RemotePrivateViewerClientOptions) => {
      onFrame = args.onFrame;
      return { get isConnected() { return connected; }, close() { connected = false; close(); } };
    });
    const ui = await startRemotePrivateViewerLocalUi({
      localPort: 0,
      privateOptions: {
        privateAddress: "127.0.0.1",
        port: 39421,
        pinnedServerCertSha256: "a".repeat(64),
        credential: {
          sessionId: "b".repeat(64), viewerChallenge: "c".repeat(64),
          viewerKey: "d".repeat(64), pinnedViewerCertSha256: "e".repeat(64),
          hostId: "test-host-123", viewerId: "test-viewer-123",
          expectedOrigin: "https://private.example.test",
          expiresAt: Date.now() + expiresIn,
        },
        clientCert: "test-cert", clientKey: "test-key", trustedCa: "test-ca",
      },
      connector: connect,
    });
    handles.push(ui);
    expect(ui.server.address()).toMatchObject({ address: "127.0.0.1" });
    return { ui, connect, close,
      get onFrame() { return onFrame; },
    };
  }

  async function unlock(ui: RemotePrivateViewerLocalUi): Promise<string> {
    const response = await fetch(ui.url + "/unlock", {
      method: "POST", redirect: "manual",
      headers: { Origin: origin(ui), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: ui.accessSecret }),
    });
    expect(response.status).toBe(303);
    const value = response.headers.get("set-cookie") || "";
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Strict");
    expect(value).not.toContain(ui.accessSecret);
    return value.split(";")[0];
  }

  it("does not connect until explicitly requested; never emits secrets in HTTP HTML/JS/URL", async () => {
    const { ui, connect } = await setup();
    const locked = await get(ui, "/");
    expect(locked.status).toBe(200);
    expect(locked.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(locked.headers.get("cache-control")).toContain("no-store");
    expect(locked.headers.get("x-frame-options")).toBe("DENY");
    const html = await locked.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain(ui.accessSecret);
    expect(ui.url).not.toContain(ui.accessSecret);
    expect(await (await get(ui, "/viewer.js")).status).toBe(403);
    const cookie = await unlock(ui);
    const page = await (await get(ui, "/", cookie)).text();
    const script = await (await get(ui, "/viewer.js", cookie)).text();
    expect(page).toContain("Start view");
    expect(page).toContain("Stop session");
    expect(script).toContain("crypto.subtle.digest");
    expect(script).toContain("URL.createObjectURL");
    expect(script).toContain("image.decode()");
    expect(page + script).not.toContain(ui.accessSecret);
    expect(page + script).not.toContain("test-key");
    expect(page + script).not.toContain("test-host-123");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects wrong access, cross-origin requests, forged Host and referer", async () => {
    const { ui, connect } = await setup();
    const noOrigin = await fetch(ui.url + "/unlock", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=" + ui.accessSecret,
    });
    expect(noOrigin.status).toBe(403);
    const badSecret = await fetch(ui.url + "/unlock", {
      method: "POST", redirect: "manual",
      headers: { Origin: origin(ui), "content-type": "application/x-www-form-urlencoded" },
      body: "code=" + "0".repeat(64),
    });
    expect(badSecret.status).toBe(403);
    const cookie = await unlock(ui);
    expect((await post(ui, "/api/start", cookie, "https://evil.example")).status).toBe(403);
    expect((await get(ui, "/api/status", cookie, { Referer: "https://evil.example/" })).status).toBe(403);
    expect((await get(ui, "/", cookie, { Host: "example.com" })).status).toBe(403);
    expect((await get(ui, "/api/status", cookie, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(ui, "/api/start", "sa_viewer=" + "0".repeat(64))).status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });

  it("serves verified JPEG and PNG events in sequence using bounded one-at-a-time pulls", async () => {
    const { ui, connect, onFrame: unused } = await setup();
    const cookie = await unlock(ui);
    expect((await post(ui, "/api/start", cookie)).status).toBe(200);
    expect(connect).toHaveBeenCalledOnce();
    const first = get(ui, "/api/frame?after=0", cookie);
    await new Promise(resolve => setTimeout(resolve, 25));
    const second = await get(ui, "/api/frame?after=0", cookie);
    expect(second.status).toBe(409);
    const now = Date.now();
    await ui.acceptFrame({ sequence: 1, width: 2, height: 2, capturedAtMs: now,
      mime: "image/jpeg", bytes: JPEG });
    const response = await first;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-frame-sequence")).toBe("1");
    expect(response.headers.get("x-frame-width")).toBe("2");
    expect(response.headers.get("x-frame-sha256"))
      .toBe(createHash("sha256").update(JPEG).digest("hex"));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
    const next = get(ui, "/api/frame?after=1", cookie);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ui.acceptFrame({ sequence: 2, width: 2, height: 2, capturedAtMs: now + 1,
      mime: "image/png", bytes: PNG });
    const pngResponse = await next;
    expect(pngResponse.status).toBe(200);
    expect(pngResponse.headers.get("content-type")).toBe("image/png");
    expect(pngResponse.headers.get("x-frame-sequence")).toBe("2");
    expect(pngResponse.headers.get("x-frame-sha256"))
      .toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(Buffer.from(await pngResponse.arrayBuffer())).toEqual(PNG);
    // SDK path is strictly JPEG; PNG is permitted only to the local display sink.
    expect((await get(ui, "/api/status", cookie)).status).toBe(200);
  });

  it("connects SDK callback only after start, closes on manual stop without reconnect", async () => {
    const session = await setup();
    const cookie = await unlock(session.ui);
    expect((await post(session.ui, "/api/start", cookie)).status).toBe(200);
    const callback = session.onFrame;
    expect(callback).toBeTypeOf("function");
    await callback!({ sequence: 1, width: 2, height: 2, capturedAtMs: Date.now(), jpeg: JPEG } as RemotePrivateViewerFrame);
    const frame = await get(session.ui, "/api/frame?after=0", cookie);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    await frame.arrayBuffer();
    const stopped = await post(session.ui, "/api/stop", cookie);
    expect(stopped.status).toBe(200);
    expect(session.close).toHaveBeenCalledOnce();
    expect((await (await get(session.ui, "/api/status", cookie)).json()).state).toBe("stopped");
    expect((await post(session.ui, "/api/start", cookie)).status).toBe(409);
    await expect(session.ui.acceptFrame({ sequence: 2, width: 2, height: 2,
      capturedAtMs: Date.now(), mime: "image/png", bytes: PNG })).rejects.toThrow();
  });

  it("fails closed on oversized/invalid frame; never exposes its binary afterwards", async () => {
    const { ui, close } = await setup();
    const cookie = await unlock(ui);
    expect((await post(ui, "/api/start", cookie)).status).toBe(200);
    const huge = Buffer.alloc(3_000_001, 0);
    huge[0] = 255; huge[1] = 216; huge[huge.length - 2] = 255; huge[huge.length - 1] = 217;
    await expect(ui.acceptFrame({
      sequence: 1, width: 2, height: 2, capturedAtMs: Date.now(),
      mime: "image/jpeg", bytes: huge,
    })).rejects.toThrow("rejected");
    expect(close).toHaveBeenCalledOnce();
    expect((await (await get(ui, "/api/status", cookie)).json()).state).toBe("stopped");
    expect((await get(ui, "/api/frame?after=0", cookie)).status).toBe(404);
  });

  it("expires without connecting and destroys the one-shot viewing session", async () => {
    const { ui, connect } = await setup(250);
    const cookie = await unlock(ui);
    await new Promise(resolve => setTimeout(resolve, 330));
    expect((await (await get(ui, "/api/status", cookie)).json()).state).toBe("stopped");
    expect((await post(ui, "/api/start", cookie)).status).toBe(409);
    expect(connect).not.toHaveBeenCalled();
  });
});
