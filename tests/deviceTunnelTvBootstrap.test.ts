import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setFullYoloMode } from "../src/core/permissions.js";
import { resetDeviceTunnelBrokerForTests } from "../src/core/deviceTunnel/broker.js";
import {
  requestTvTunnelBootstrap,
  approveTvTunnelBootstrap,
  pollTvTunnelBootstrap,
  resetTvTunnelBootstrapForTests,
} from "../src/core/deviceTunnel/tvBootstrap.js";
import { handleDeviceTunnelPublicRoute } from "../src/core/deviceTunnel/http.js";
import { parseTrayLanAction, dispatchTrayLanAction } from "../src/core/runtime/trayLanBridge.js";
import { LAN_MCP_TOOL_CLASSIFICATIONS, LAN_MCP_TOOL_DEFS } from "../src/core/mcp/tools/lanMcpTools.js";

let server: http.Server;
let origin = "";
let temp = "";
const old = process.env.SUPERAGENT_CONFIG_DIR;
const challenge = "a".repeat(64);
const otherChallenge = "b".repeat(64);

beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "satv-bootstrap-"));
  process.env.SUPERAGENT_CONFIG_DIR = temp;
  resetDeviceTunnelBrokerForTests();
  resetTvTunnelBootstrapForTests();
  setFullYoloMode(true);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!(await handleDeviceTunnelPublicRoute(req, res, url.pathname))) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  setFullYoloMode(false);
  resetTvTunnelBootstrapForTests();
  resetDeviceTunnelBrokerForTests();
  fs.rmSync(temp, { force: true, recursive: true });
  if (old === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = old;
});
async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + route, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("camera-free TV pairing bootstrap", () => {
  it("exposes the QR approval to MCP only as a dangerous, exact-input tool", () => {
    const def = LAN_MCP_TOOL_DEFS.find(d => d.name === "superagent_device_tunnel_tv_approve");
    expect(def).toBeDefined();
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_device_tunnel_tv_approve).toBe("dangerous");
    expect(def!.inputSchema.additionalProperties).toBe(false);
    expect(def!.inputSchema.required).toEqual(["requestId", "challenge"]);
  });
  it("shows only a public challenge in QR while keeping poll credential private", () => {
    const request = requestTvTunnelBootstrap({ challenge, name: "Android TV" });
    expect(request.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(request.pollToken).toMatch(/^[a-f0-9]{64}$/);
    expect(() => pollTvTunnelBootstrap({ id: request.id, pollToken: otherChallenge }))
      .toThrow(/expired|unknown/);
    expect(pollTvTunnelBootstrap({ id: request.id, pollToken: request.pollToken }))
      .toEqual({ state: "pending" });
    const java = fs.readFileSync(
      "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/AndroidTvQrPairing.java", "utf8");
    const qr = java.split("String publicQr()")[1]?.split("static String requireHttpsOrigin")[0];
    expect(qr).toContain('.put("h", challenge)');
    expect(qr).not.toContain(".put(\"pollToken\"");
  });

  it("requires exact QR proof and Full YOLO before granting an invitation", () => {
    const request = requestTvTunnelBootstrap({ challenge, name: "Android TV" });
    expect(() => approveTvTunnelBootstrap({ id: request.id, challenge: otherChallenge }))
      .toThrow(/challenge mismatch/);
    setFullYoloMode(false);
    expect(() => approveTvTunnelBootstrap({ id: request.id, challenge }))
      .toThrow(/Full YOLO/);
    setFullYoloMode(true);
    expect(approveTvTunnelBootstrap({ id: request.id, challenge }).approved).toBe(true);
    expect(() => approveTvTunnelBootstrap({ id: request.id, challenge }))
      .toThrow(/already approved/);
    const approved = pollTvTunnelBootstrap({ id: request.id, pollToken: request.pollToken });
    expect(approved.state).toBe("approved");
    if (approved.state === "approved") {
      expect(approved.code).toMatch(/^\d{10}$/);
      expect(approved.inviteId).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(() => pollTvTunnelBootstrap({ id: request.id, pollToken: request.pollToken }))
      .toThrow(/expired|unknown/);
  });

  it("serves TV bootstrap POSTs but rejects malformed requests and browser-origin calls", async () => {
    expect((await post("/api/device-tunnel/tv/request", {
      challenge, name: "Android TV", unexpected: 1,
    })).status).toBe(400);
    expect((await post("/api/device-tunnel/tv/request", { challenge, name: "Android TV" }, {
      Origin: "https://untrusted.example",
    })).status).toBe(403);
    const response = await post("/api/device-tunnel/tv/request", { challenge, name: "Android TV" });
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    const { id, pollToken } = payload.request;
    expect((await post("/api/device-tunnel/tv/poll", { id, pollToken: otherChallenge })).status)
      .toBeGreaterThanOrEqual(400);
    const pending = await post("/api/device-tunnel/tv/poll", { id, pollToken });
    expect((await pending.json() as any).result.state).toBe("pending");

    expect(parseTrayLanAction({ action: "tunnel_tv_approve", requestId: id, challenge }).action)
      .toBe("tunnel_tv_approve");
    expect(() => parseTrayLanAction({ action: "tunnel_tv_approve", requestId: id,
      challenge, extra: true })).toThrow(/Unexpected/);
    // Authorized local bridge approves; the HTTP ingress deliberately has no public approval route.
    const approved = await dispatchTrayLanAction({ action: "tunnel_tv_approve", requestId: id, challenge }) as any;
    expect(approved.request.approved).toBe(true);
    const issued = await post("/api/device-tunnel/tv/poll", { id, pollToken });
    expect((await issued.json() as any).result.code).toMatch(/^\d{10}$/);
    expect((await post("/api/device-tunnel/tv/approve", { id, challenge })).status).toBe(401);
  });

  it("prevents request exhaustion and duplicate public challenges", () => {
    requestTvTunnelBootstrap({ challenge, name: "Android TV" });
    expect(() => requestTvTunnelBootstrap({ challenge: challenge.toUpperCase(), name: "Android TV" }))
      .toThrow(/already in use/);
    for (let i = 0; i < 15; i++) {
      requestTvTunnelBootstrap({ challenge: i.toString(16).padStart(64, "0"), name: "Android TV" });
    }
    expect(() => requestTvTunnelBootstrap({ challenge: otherChallenge, name: "Android TV" }))
      .toThrow(/Too many pending/);
  });
});
