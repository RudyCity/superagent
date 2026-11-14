import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import {
  startRemotePrivateViewerLocalUi,
  type RemotePrivateViewerLocalUi,
} from "../../src/core/desktopUi/remotePrivateViewerLocalUi.js";
import type { RemotePrivateViewerClientOptions } from "../../src/core/desktopUi/remotePrivateViewerClient.js";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const JPEG = await sharp({ create: { width: 2, height: 2, channels: 3,
  background: { r: 21, g: 68, b: 105 } } }).jpeg({ quality: 65 }).toBuffer();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUdclkYGBgYmBgYGBgAAAI7gDGjBRHogAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!existsSync(CHROME))("private local viewer: real Chrome 320px JPEG/PNG rendering", () => {
  let browser: Browser | undefined;
  let ui: RemotePrivateViewerLocalUi | undefined;
  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await ui?.close();
    ui = undefined;
  });

  it("renders two digest-verified frames, reports freshness and stops with no input controls", async () => {
    let onFrame: RemotePrivateViewerClientOptions["onFrame"] | undefined;
    const stopped = vi.fn();
    let connected = true;
    ui = await startRemotePrivateViewerLocalUi({
      privateOptions: {
        privateAddress: "127.0.0.1", port: 39421,
        pinnedServerCertSha256: "a".repeat(64),
        credential: {
          sessionId: "b".repeat(64), viewerChallenge: "c".repeat(64),
          viewerKey: "d".repeat(64), pinnedViewerCertSha256: "e".repeat(64),
          hostId: "test-host-123", viewerId: "test-viewer-123",
          expectedOrigin: "https://private.example.test",
          expiresAt: Date.now() + 60_000,
        },
        clientCert: "fake-cert", clientKey: "fake-key", trustedCa: "fake-ca",
      },
      connector: async args => {
        onFrame = args.onFrame;
        return { get isConnected() { return connected; }, close() { connected = false; stopped(); } };
      },
    });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(ui.url);
    expect(await page.locator("h1").textContent()).toBe("Local viewer access");
    await page.locator("#code").fill(ui.accessSecret);
    await page.locator("button[type=submit]").click();

    await page.locator("#start").waitFor({ state: "visible", timeout: 1500 });
    expect(await page.locator("#phase").textContent()).toBe("Idle");
    await page.locator("#start").click();

    await page.waitForFunction(() => document.getElementById("phase")?.textContent === "Connected");
    expect(onFrame).toBeTypeOf("function");

    await onFrame!({
      sequence: 1, width: 2, height: 2,
      capturedAtMs: Date.now(), jpeg: JPEG,
    });
    await page.waitForFunction(() => document.getElementById("sequence")?.textContent === "#1");
    expect(await page.locator("#resolution").textContent()).toBe("2 × 2");
    await page.locator("#frame").waitFor({ state: "visible" });
    expect(await page.locator("#frame").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2);

    await ui.acceptFrame({ sequence: 2, width: 2, height: 2,
      capturedAtMs: Date.now() + 1, mime: "image/png", bytes: PNG });
    await page.waitForFunction(() => document.getElementById("sequence")?.textContent === "#2");
    expect(await page.locator("#frame").evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(2);
    expect(await page.locator("#freshness").textContent()).toContain("Fresh");
    expect(await page.locator("button").allTextContents()).toEqual(["Start view", "Stop session"]);
    await page.locator("#stop").click();
    await page.waitForFunction(() => document.getElementById("phase")?.textContent === "Disconnected");
    expect(stopped).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  }, 20_000);
});
