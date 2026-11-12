import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDeviceTunnelInvite,
  requestDeviceTunnel,
  resetDeviceTunnelBrokerForTests,
} from "../src/core/deviceTunnel/broker.js";
import { handleDeviceTunnelPublicRoute } from "../src/core/deviceTunnel/http.js";
import { createAndroidApkDownloadTicket, resetAndroidApkDownloadTicketsForTests } from "../src/core/deviceTunnel/apkDownload.js";
import { setFullYoloMode } from "../src/core/permissions.js";

const previous = process.env.SUPERAGENT_CONFIG_DIR;
let root = "";
let server: http.Server;
let origin = "";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-device-tunnel-http-"));
  process.env.SUPERAGENT_CONFIG_DIR = root;
  resetDeviceTunnelBrokerForTests();
  setFullYoloMode(true);
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (!(await handleDeviceTunnelPublicRoute(req, res, pathname))) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  origin = "http://127.0.0.1:" + address.port;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setFullYoloMode(false);
  resetAndroidApkDownloadTicketsForTests();
  resetDeviceTunnelBrokerForTests();
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previous;
});

async function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
  });
}

describe("Device Tunnel public HTTP ingress", () => {
  it("exposes a no-secret public readiness ping for tunnel publication", async () => {
    const response = await fetch(origin + "/api/device-tunnel/ping", { method: "HEAD", redirect: "error" });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("is mounted before the general Core bearer gate but only under its fixed namespace", () => {
    const source = fs.readFileSync(path.resolve("src/server.ts"), "utf8");
    const tunnel = source.indexOf('pathname.startsWith("/api/device-tunnel/")');
    const authGate = source.indexOf("// Auth gate for the HTTP API");
    expect(tunnel).toBeGreaterThan(0);
    expect(authGate).toBeGreaterThan(tunnel);
    expect(source.slice(tunnel, authGate)).toContain("handleDeviceTunnelPublicRoute");
  });
  it("serves the pinned APK through a temporary browser-download ticket", async () => {
    const ticket = createAndroidApkDownloadTicket();
    const response = await fetch(origin + "/api/device-tunnel/android-apk/" + ticket.token, {
      method: "HEAD",
      headers: { Origin: "https://camera.example" },
      redirect: "error",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(response.headers.get("content-disposition")).toContain(ticket.filename);
    expect(response.headers.get("content-length")).toBe(String(ticket.size));
    expect(response.headers.get("x-superagent-apk-sha256")).toBe(ticket.sha256);
    expect(response.headers.get("cache-control")).toContain("no-store");
    // The filename and SHA header must describe the exact bytes delivered.
    const download = await fetch(origin + "/api/device-tunnel/android-apk/" + ticket.token, {
      method: "GET", redirect: "error",
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(ticket.filename);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(ticket.size);
    expect((await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")).toBe(ticket.sha256);
  });

  it("enrolls without the Core bearer and then requires device-scoped auth", async () => {
    const invite = createDeviceTunnelInvite();
    const enrollment = await post("/api/device-tunnel/enroll", {
      inviteId: invite.inviteId,
      code: invite.code,
      name: "HTTP Test",
      platform: "windows",
      fingerprint: "d".repeat(64),
    });
    expect(enrollment.status).toBe(200);
    const enrolled = await enrollment.json() as any;
    expect(enrolled.success).toBe(true);
    expect(enrolled.device.id).toMatch(/^[a-f0-9-]{36}$/i);
    expect(enrolled.token).toMatch(/^[a-f0-9]{64}$/);

    const denied = await post("/api/device-tunnel/poll", { waitMs: 1000 });
    expect(denied.status).toBe(401);

    const headers = {
      Authorization: "Device " + enrolled.token,
      "X-SuperAgent-Device-Id": enrolled.device.id,
    };
    const pending = requestDeviceTunnel(enrolled.device.id, { op: "ping" }, 5_000);
    const poll = await post("/api/device-tunnel/poll", { waitMs: 1000 }, headers);
    expect(poll.status).toBe(200);
    const jobBody = await poll.json() as any;
    expect(jobBody.request.body).toEqual({ op: "ping" });

    const reply = await post("/api/device-tunnel/reply", {
      requestId: jobBody.request.requestId,
      frames: [{ ok: true }],
    }, headers);
    expect(reply.status).toBe(200);
    await expect(pending).resolves.toEqual([{ ok: true }]);
  });

  it("supports QR auto-pair through the enrolled device channel", async () => {
    const fingerprint = "f".repeat(64);
    const invite = createDeviceTunnelInvite();
    const enrollment = await post("/api/device-tunnel/enroll", {
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Android QR",
      platform: "android",
      fingerprint,
    });
    expect(enrollment.status).toBe(200);
    const enrolled = await enrollment.json() as any;
    const headers = {
      Authorization: "Device " + enrolled.token,
      "X-SuperAgent-Device-Id": enrolled.device.id,
    };

    const pairResponsePromise = post("/api/device-tunnel/qr-pair", {
      code: "12345678",
      fingerprint,
      controller: "SuperAgent Tray QR",
    }, headers);
    const poll = await post("/api/device-tunnel/poll", { waitMs: 3000 }, headers);
    expect(poll.status).toBe(200);
    const job = await poll.json() as any;
    expect(job.request.body).toEqual({
      op: "pair",
      code: "12345678",
      label: "SuperAgent Tray QR",
    });

    const pairId = "11111111-2222-4333-8444-555555555555";
    const pairToken = "a".repeat(64);
    const reply = await post("/api/device-tunnel/reply", {
      requestId: job.request.requestId,
      frames: [{ ok: true, pairId, pairToken, platform: "android", deviceName: "Android QR" }],
    }, headers);
    expect(reply.status).toBe(200);

    const pairedResponse = await pairResponsePromise;
    expect(pairedResponse.status).toBe(200);
    const paired = await pairedResponse.json() as any;
    expect(paired.success).toBe(true);
    expect(paired.device).toMatchObject({
      platform: "android",
      transport: "tunnel",
      paired: true,
    });
    expect(JSON.stringify(paired)).not.toContain("12345678");
    expect(JSON.stringify(paired)).not.toContain(pairToken);
  });

  it("fails closed when QR auto-pair is attempted without Full YOLO", async () => {
    const fingerprint = "c".repeat(64);
    const invite = createDeviceTunnelInvite();
    const enrollment = await post("/api/device-tunnel/enroll", {
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Android QR Guard",
      platform: "android",
      fingerprint,
    });
    const enrolled = await enrollment.json() as any;
    setFullYoloMode(false);
    const response = await post("/api/device-tunnel/qr-pair", {
      code: "87654321",
      fingerprint,
      controller: "SuperAgent Tray QR",
    }, {
      Authorization: "Device " + enrolled.token,
      "X-SuperAgent-Device-Id": enrolled.device.id,
    });
    expect(response.status).toBe(403);
    const body = await response.json() as any;
    expect(body.error).toBe("DEVICE_TUNNEL_FULL_YOLO_REQUIRED");
    setFullYoloMode(true);
  });

  it("rejects browser-origin enrollment attempts", async () => {
    const invite = createDeviceTunnelInvite();
    const response = await post("/api/device-tunnel/enroll", {
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Browser Attempt",
      platform: "android",
      fingerprint: "e".repeat(64),
    }, { Origin: "https://example.test" });
    expect(response.status).toBe(403);
  });
});

describe("Device Tunnel authenticated self-revocation", () => {
  it("invalidates only the requesting device token and clears queued requests", async () => {
    const broker = await import("../src/core/deviceTunnel/broker.js");
    const first = broker.createDeviceTunnelInvite();
    const second = broker.createDeviceTunnelInvite();
    const enroll = async (invite: typeof first, name: string) => {
      const res = await post("/api/device-tunnel/enroll", {
        inviteId: invite.inviteId, code: invite.code, name,
        platform: "windows", fingerprint: "d".repeat(64),
      });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    const one = await enroll(first, "Receiver A");
    const two = await enroll(second, "Receiver B");
    const headers = (client: any) => ({
      Authorization: "Device " + client.token,
      "X-SuperAgent-Device-Id": client.device.id,
    });
    const queued = broker.requestDeviceTunnel(one.device.id, { op: "status" }, 5_000).then(
      () => { throw Error("Revoked request unexpectedly completed."); },
      error => error as Error,
    );
    const unauthenticated = await post("/api/device-tunnel/leave", {});
    expect(unauthenticated.status).toBe(401);
    const malformed = await post("/api/device-tunnel/leave", { deleteAll: true }, headers(one));
    expect(malformed.status).toBe(400);
    const leave = await post("/api/device-tunnel/leave", {}, headers(one));
    expect(leave.status).toBe(200);
    expect((await queued).message).toMatch(/revoked/i);
    expect(() => broker.authenticateDeviceTunnel(one.device.id, one.token)).toThrow();
    const replay = await post("/api/device-tunnel/leave", {}, headers(one));
    expect([401, 403]).toContain(replay.status);
    expect(broker.authenticateDeviceTunnel(two.device.id, two.token).id).toBe(two.device.id);
    expect(broker.listDeviceTunnelDevices().some(d => d.id === one.device.id)).toBe(false);
  });
});
