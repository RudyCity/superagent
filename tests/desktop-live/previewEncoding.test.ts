import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { NativeWindowPreviewManager, PRIVATE_PREVIEW_INTERVAL_MS } from "../../src/core/desktopUi/livePreview.js";
import {
  encodeJpegPreview, MAX_PREVIEW_JPEG_BYTES, MAX_PREVIEW_SOURCE_PIXELS,
  validateJpegSettings,
} from "../../src/core/desktopUi/livePreviewEncoding.js";
import type {
  DesktopDiscoveredWindow, DesktopUiAdapter, DesktopUiCapabilities, NativeCapture,
} from "../../src/core/desktopUi/types.js";

const target: DesktopDiscoveredWindow = {
  pid: 4102, nativeId: "window-42", title: "Shared document",
  application: "Native Editor", active: true,
  bounds: { x: 15, y: 20, width: 2400, height: 900 },
};
async function createPng(): Promise<Uint8Array> {
  const canvas = createCanvas(2400,900);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0,0,2400,900);
  gradient.addColorStop(0,"#ed6c36");
  gradient.addColorStop(1,"#24487c");
  context.fillStyle = gradient;
  context.fillRect(0,0,2400,900);
  context.fillStyle = "#fff";
  context.font = "bold 64px Arial";
  context.fillText("Native preview fixture",100,140);
  return canvas.encode("png");
}
function mockAdapter(image: Uint8Array, options: {
  before?:()=>void; capture?:()=>void; platform?:"win32"|"darwin"|"linux";
}={}): DesktopUiAdapter {
  const platform = options.platform ?? "win32";
  return {
    platform,
    async probe(): Promise<DesktopUiCapabilities> {
      return { platform,available:true,screenshot:true,accessibility:true,
        input:false,scroll:false,sessionType:"test",prerequisites:[],limitations:[],errors:[] };
    },
    async listWindows(limit) {
      options.before?.();
      return { windows:[target],limit,truncated:false };
    },
    async capture(): Promise<NativeCapture> {
      options.capture?.();
      return {image,capturedAt:"2026-11-14T08:00:00.000Z",targetWindow:target};
    },
    async inspectAccessibility(){throw Error("must not inspect");},
    async dispatch(){throw Error("must not dispatch");},
  };
}
describe("bounded native preview JPEG transport", () => {
  it("encodes native PNG to smaller bounded JPEG at the requested dimensions", async () => {
    const png = await createPng();
    const jpeg = await encodeJpegPreview(png,{maxWidth:640,quality:70});
    expect(jpeg.format).toBe("jpeg");
    expect(jpeg.width).toBe(640);
    expect(jpeg.height).toBe(240);
    const bytes = Buffer.from(jpeg.jpeg,"base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_PREVIEW_JPEG_BYTES);
    expect(bytes.subarray(0,3)).toEqual(Buffer.from([255,216,255]));
    expect(bytes.byteLength).toBeLessThan(png.byteLength);
  });

  it("negotiates JPEG, skips unchanged full-frame transfers, preserves hash and rate limit", async () => {
    let now = 1000;
    let captured = 0;
    const png = await createPng();
    const manager = new NativeWindowPreviewManager(
      ()=>mockAdapter(png,{capture:()=>captured++}),
      ()=>now,
    );
    const {token} = await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    const first = await manager.frame({token,codec:"jpeg",quality:65,maxWidth:1280});
    expect(first.unchanged).toBe(false);
    if (first.unchanged !== false || first.format !== "jpeg") throw Error("Expected JPEG");
    expect(first.width).toBe(1280);
    expect(first.jpeg).toMatch(/^\/9j\//);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.nextPollMs).toBeGreaterThanOrEqual(PRIVATE_PREVIEW_INTERVAL_MS);
    expect(captured).toBe(1);
    await expect(manager.frame({token,codec:"jpeg",knownHash:first.hash})).rejects.toThrow(/rate limited/);
    now += PRIVATE_PREVIEW_INTERVAL_MS;
    const second = await manager.frame({token,codec:"jpeg",quality:65,maxWidth:1280,knownHash:first.hash});
    expect(second.unchanged).toBe(true);
    expect(second).not.toHaveProperty("jpeg");
    expect(second).not.toHaveProperty("png");
    expect(second.hash).toBe(first.hash);
    expect(second.nextPollMs).toBeGreaterThanOrEqual(first.nextPollMs);
    expect(captured).toBe(2);
    now += PRIVATE_PREVIEW_INTERVAL_MS;
    const newWidth = await manager.frame({
      token, codec: "jpeg", maxWidth: 640, quality: 65, knownHash: first.hash,
    });
    expect(newWidth.unchanged).toBe(false);
    if (newWidth.unchanged !== false || newWidth.format !== "jpeg") throw Error("New dimensions must re-encode");
    expect(newWidth.width).toBe(640);
    now += PRIVATE_PREVIEW_INTERVAL_MS;
    const newQuality = await manager.frame({
      token, codec: "jpeg", maxWidth: 640, quality: 50, knownHash: first.hash,
    });
    expect(newQuality.unchanged).toBe(false);
    expect(captured).toBe(4);
    expect(manager.stop({token})).toEqual({stopped:true});
  });

  it("denies malformed and unbounded frame settings before any native capture", async () => {
    let captured = 0;
    const manager = new NativeWindowPreviewManager(
      ()=>mockAdapter(awaitableImage,{capture:()=>captured++}),
    );
    const {token} = await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    for (const request of [
      {token,codec:"h264"}, {token,codec:"png",quality:80},
      {token,codec:"jpeg",quality:20}, {token,codec:"jpeg",maxWidth:99999},
      {token,codec:"jpeg",knownHash:"0"}, {token,codec:"jpeg",extra:"unsafe"},
    ]) {
      await expect(manager.frame(request)).rejects.toThrow(/Invalid|JPEG|settings/);
    }
    expect(captured).toBe(0);
    expect(manager.stop({token})).toEqual({stopped:true});
  });

  it("rejects a fully black native capture instead of displaying a protected or GPU-black frame", async () => {
    const black=createCanvas(320,180);
    black.getContext("2d").fillStyle="#000";
    black.getContext("2d").fillRect(0,0,320,180);
    await expect(encodeJpegPreview(await black.encode("png"),{maxWidth:640,quality:65}))
      .rejects.toThrow(/black or transparent/);
    const dark=createCanvas(320,180);
    const context=dark.getContext("2d");
    context.fillStyle="#000";
    context.fillRect(0,0,320,180);
    context.fillStyle="#ffffff";
    context.fillRect(60,60,200,30);
    expect((await encodeJpegPreview(await dark.encode("png"),{maxWidth:640,quality:65})).format)
      .toBe("jpeg");
  });

  it("enforces pixel and JPEG encoding options before allocating a full-sized canvas", async () => {
    expect(()=>validateJpegSettings({maxWidth:1919,quality:85})).not.toThrow();
    for (const options of [{quality:39},{quality:86},{maxWidth:319},{maxWidth:1921},
      {quality:70.5},{maxWidth:"1280"}]) {
      expect(()=>validateJpegSettings(options)).toThrow(/settings/);
    }
    const fake = Buffer.alloc(24);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(fake);
    fake.writeUInt32BE(7000,16);
    fake.writeUInt32BE(Math.floor(MAX_PREVIEW_SOURCE_PIXELS/7000)+1,20);
    await expect(encodeJpegPreview(fake,{maxWidth:640,quality:65})).rejects.toThrow(/dimensions/);
  });
});
const awaitableImage = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82,
  0,0,9,96,0,0,3,132]);
