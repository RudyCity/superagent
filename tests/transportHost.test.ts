import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runTransportHost, validTransportPort } from "../src/core/runtime/transportHost.js";

const listeners: http.Server[] = [];
const trustedCore = async () => true;
async function bindMock(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: ping\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method, authorization: req.headers.authorization }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  listeners.push(server);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing port");
  return { server, port: addr.port };
}
afterEach(async () => {
  for (const server of listeners.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});
describe("independent T-Line transport host", () => {
  it("validates distinct loopback ports", async () => {
    expect(validTransportPort(7888)).toBe(true);
    expect(validTransportPort(70000)).toBe(false);
    await expect(runTransportHost(7888, 7888)).rejects.toThrow();
  });
  it("forwards REST + SSE and blocks internal capabilities", async () => {
    const mock = await bindMock();
    const host = await runTransportHost(0, mock.port, trustedCore);
    listeners.push(host.server);
    const base = "http://127.0.0.1:" + host.port;
    const result = await fetch(base + "/api/status?sessionId=old", {
      headers: { Authorization: "Bearer test" },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      path: "/api/status?sessionId=old", method: "GET", authorization: "Bearer test",
    });
    const stream = await fetch(base + "/events");
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toBe("data: ping\n\n");
    expect((await fetch(base + "/_core/internal/drain")).status).toBe(404);
    expect((await fetch(base + "/_transport/other")).status).toBe(404);
    const health = await fetch(base + "/_transport/health");
    expect((await health.json()).service).toBe("superagent-transport-host");
  });
  it("never forwards bearer credentials to an unverified backend port", async () => {
    const mock = await bindMock();
    let touched = 0;
    mock.server.on("request", () => { touched++; });
    const host = await runTransportHost(0, mock.port, async () => false);
    listeners.push(host.server);
    const response = await fetch("http://127.0.0.1:" + host.port + "/api/status", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(response.status).toBe(503);
    expect(touched).toBe(0);
  });
  it("proxies the WebSocket HTTP upgrade handshake", async () => {
    const mock = await bindMock();
    mock.server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.end("upgraded");
    });
    const host = await runTransportHost(0, mock.port, trustedCore);
    listeners.push(host.server);
    const observed = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(host.port, "127.0.0.1", () => {
        socket.write("GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n" +
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      });
      let received = "";
      socket.on("data", chunk => {
        received += chunk.toString("utf8");
        if (received.includes("upgraded")) { socket.destroy(); resolve(received); }
      });
      socket.once("error", reject);
      socket.once("close", () => {
        if (!received.includes("upgraded")) reject(new Error("Upgrade did not complete"));
      });
    });
    expect(observed).toContain("101 Switching Protocols");
    expect(observed).toContain("upgraded");
  });
  it("remains available while its upstream shuts down", async () => {
    const mock = await bindMock();
    const host = await runTransportHost(0, mock.port, trustedCore);
    listeners.push(host.server);
    await new Promise<void>(resolve => mock.server.close(() => resolve()));
    listeners.splice(listeners.indexOf(mock.server), 1);
    const base = "http://127.0.0.1:" + host.port;
    expect((await fetch(base + "/_transport/health")).status).toBe(200);
    const failed = await fetch(base + "/api/status");
    expect(failed.status).toBe(503);
  });
});
