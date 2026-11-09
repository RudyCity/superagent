import { describe, expect, it } from "vitest";
import {
  buildDeviceTunnelQrPayload,
  renderDeviceTunnelQrDataUrl,
  renderDeviceTunnelQrMatrix,
} from "../src/core/deviceTunnel/qrInvite.js";

describe("Device Tunnel QR invite", () => {
  it("builds a bounded one-time auto-pair payload and renders a local PNG data URL", async () => {
    const expiresAt = Date.now() + 10 * 60_000;
    const payload = buildDeviceTunnelQrPayload({
      baseUrl: "https://example.trycloudflare.com",
      inviteId: "11111111-2222-4333-8444-555555555555",
      code: "0123456789",
      expiresAt,
    });
    const parsed = JSON.parse(payload);
    expect(parsed).toEqual({
      k: "sat",
      v: 1,
      u: "https://example.trycloudflare.com",
      i: "11111111-2222-4333-8444-555555555555",
      c: "0123456789",
      e: expiresAt,
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(220);

    const matrix = renderDeviceTunnelQrMatrix(payload);
    expect(matrix.size).toBeGreaterThanOrEqual(21);
    expect(matrix.size).toBeLessThanOrEqual(65);
    expect(matrix.cells).toMatch(/^[01]+$/);
    expect(matrix.cells.length).toBe(matrix.size * matrix.size);

    const dataUrl = await renderDeviceTunnelQrDataUrl(payload);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(200);
    expect(dataUrl.length).toBeLessThan(180_000);
  });

  it("rejects non-HTTPS, malformed, and stale invitations", () => {
    const good = {
      inviteId: "11111111-2222-4333-8444-555555555555",
      code: "0123456789",
      expiresAt: Date.now() + 60_000,
    };
    expect(() => buildDeviceTunnelQrPayload({ ...good, baseUrl: "http://example.test" }))
      .toThrow(/HTTPS/);
    expect(() => buildDeviceTunnelQrPayload({ ...good, baseUrl: "https://example.test", code: "123" }))
      .toThrow(/invalid/);
    expect(() => buildDeviceTunnelQrPayload({
      ...good,
      baseUrl: "https://example.test",
      expiresAt: Date.now() - 1,
    })).toThrow(/expiry/);
  });
});
