import { afterEach, describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { parseWindowsTunnelQrPayload, startWindowsQrConnectCapture } from "../src/core/deviceTunnel/windowsQrConnect.js";

const id = "11111111-2222-4333-8444-555555555555";
const payload = (e: number = Date.now() + 300_000) => JSON.stringify({
  k: "sat", v: 1, u: "https://device-controller.example", i: id, c: "0123456789", e,
});
let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; });

describe("Windows laptop QR enrollment", () => {
  it("accepts Tray QR and copied setup JSON, but never arbitrary URLs", () => {
    expect(parseWindowsTunnelQrPayload(payload())).toEqual({
      url: "https://device-controller.example", inviteId: id, code: "0123456789",
    });
    expect(parseWindowsTunnelQrPayload(JSON.stringify({
      url: "https://device-controller.example", inviteId: id, code: "0123456789",
    }))).toMatchObject({ inviteId: id });
    expect(() => parseWindowsTunnelQrPayload("https://device-controller.example"))
      .toThrow(/Connect QR/);
  });
  it("rejects expired, far-future, malformed, and unsafe host payloads", () => {
    expect(() => parseWindowsTunnelQrPayload(payload(Date.now() - 1))).toThrow(/expired/);
    expect(() => parseWindowsTunnelQrPayload(payload(Date.now() + 999_999_999))).toThrow(/expired/);
    for (const base of ["http://device.example", "https://device.example/path",
      "https://user:secret@device.example", "https://device.example:8443"]) {
      const json = JSON.parse(payload());
      json.u = base;
      expect(() => parseWindowsTunnelQrPayload(JSON.stringify(json))).toThrow(/HTTPS/);
    }
    expect(() => parseWindowsTunnelQrPayload(JSON.stringify({ ...JSON.parse(payload()), injected: 1 })))
      .toThrow(/Unsupported/);
  });
  it("serves a private, browser-readable one-use QR session without raw invitation leakage", async () => {
    const intake = await startWindowsQrConnectCapture({ openBrowser: false });
    close = intake.close;
    expect(intake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(intake.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const body = await page.text();
    expect(body).toContain("Scan using camera");
    expect(body).toContain("BarcodeDetector");
    expect(body).not.toContain(id);
    expect(body).toContain("Connect to verified host");
    const js = body.match(/<script[^>]*>([\s\S]+?)<\/script>/)?.[1];
    expect(js).toBeTruthy();
    expect(() => new Script(js!)).not.toThrow();
    const csrf = body.match(/name="qr-token" content="([a-f0-9]{64})"/)?.[1];
    expect(csrf).toMatch(/^[a-f0-9]{64}$/);
    const headers = {
      Origin: new URL(intake.url).origin,
      "Content-Type": "application/json",
      "X-SuperAgent-QR-CSRF": csrf!,
    };
    const refused = await fetch(intake.url + "connect", {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: JSON.stringify({ payload: payload() }),
    });
    expect(refused.status).toBe(403);
    const bad = await fetch(intake.url + "connect", {
      method: "POST", headers, body: JSON.stringify({ payload: payload(Date.now() - 1) }),
    });
    expect(bad.status).toBe(400);
    const valid = await fetch(intake.url + "connect", {
      method: "POST", headers, body: JSON.stringify({ payload: payload() }),
    });
    expect(valid.status).toBe(200);
    await expect(intake.setup).resolves.toMatchObject({ inviteId: id, code: "0123456789" });
    const reused = await fetch(intake.url + "connect", {
      method: "POST", headers, body: JSON.stringify({ payload: payload() }),
    });
    expect(reused.status).toBe(410);
  });
});

describe("Windows QR auto-pair relay", () => {
  it("sends the 8-digit target code through authenticated Core pairing and clears it", async () => {
    const http = await import("node:http");
    const { runDeviceTunnelRelay } = await import("../src/core/deviceTunnel/client.js");
    const abort = new AbortController();
    let received: any = null;
    let credentialsSeen = false;
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part.toString("utf8");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/device-tunnel/enroll") {
        res.end(JSON.stringify({ success: true, device: { id }, token: "a".repeat(64) }));
      } else if (req.url === "/api/device-tunnel/qr-pair") {
        credentialsSeen = req.headers.authorization === "Device " + "a".repeat(64)
          && req.headers["x-superagent-device-id"] === id;
        received = JSON.parse(body);
        res.end(JSON.stringify({ success: true, device: { id } }));
        setTimeout(() => abort.abort(), 60);
      } else if (req.url === "/api/device-tunnel/poll") {
        res.end(JSON.stringify({ success: true, request: null }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const autoPair = { code: "12345678", controller: "SuperAgent Tray QR" };
    const timer = setTimeout(() => abort.abort(), 2000);
    try {
      await runDeviceTunnelRelay({
        enrollment: { url: "http://127.0.0.1:" + port, inviteId: id, code: "0123456789" },
        platform: "windows", name: "Windows test", fingerprint: "f".repeat(64),
        localHost: "127.0.0.1", localPort: 17845, signal: abort.signal, autoPair,
      });
      expect(credentialsSeen).toBe(true);
      expect(received).toEqual({
        code: "12345678", fingerprint: "f".repeat(64), controller: "SuperAgent Tray QR",
      });
      expect(autoPair.code).toBe("");
    } finally {
      clearTimeout(timer);
      abort.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
