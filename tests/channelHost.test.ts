import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runChannelHost, validateChannelHostMode, handleChannelHostCliCommand, listVerifiedChannelHosts } from "../src/core/runtime/channelHost.js";

const running: http.Server[] = [];
async function freePort(): Promise<number> {
  const srv = net.createServer();
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      srv.close(() => resolve(address.port));
    });
  });
}
afterEach(async () => {
  for (const srv of running.splice(0)) {
    await new Promise<void>(resolve => srv.close(() => resolve()));
  }
});

describe("independent channel-host lifecycle", () => {
  it("requires explicit transport selection and preconfigured external tokens", () => {
    expect(validateChannelHostMode("idle", 9225, {})).toBe("idle");
    expect(() => validateChannelHostMode("muse-ws", 9225, {})).toThrow();
    expect(() => validateChannelHostMode("telegram-fallback", 9225, {})).toThrow();
    expect(validateChannelHostMode("muse-ws", 9225, { wsToken: "long-enough-ws-token-value" })).toBe("muse-ws");
    expect(validateChannelHostMode("telegram-fallback", 9225, {
      botToken: "fake", groupId: "123", museBotId: "456",
    })).toBe("telegram-fallback");
    expect(() => validateChannelHostMode("wrong", 9225, {})).toThrow();
    expect(() => validateChannelHostMode("idle", 0, {})).toThrow();
  });

  it("starts idle with redacted read-only health and no network channel", async () => {
    const port = await freePort();
    const { server } = await runChannelHost({ port, wsPort: 9225, mode: "idle" });
    running.push(server);
    const base = "http://127.0.0.1:" + port;
    const result = await fetch(base + "/_channel/health");
    const value = await result.json() as Record<string, unknown>;
    expect(value).toMatchObject({
      service: "superagent-channel-host", port, mode: "idle",
      status: "idle", watcherActive: false, taskActive: false,
    });
    expect(JSON.stringify(value)).not.toMatch(/botToken|groupId|workspace|authToken|wsToken/);
    expect((await fetch(base + "/_channel/start", { method: "POST" })).status).toBe(404);
    expect((await fetch(base + "/api/status")).status).toBe(404);
    await expect(runChannelHost({ port, wsPort: 9225, mode: "idle" })).rejects.toThrow(/registration already exists/);
    await handleChannelHostCliCommand(["status", "--port", String(port)]);
    const listed = await listVerifiedChannelHosts();
    expect(listed.some(item => item.port === port && item.mode === "idle")).toBe(true);
    const { getRemoteServiceStatus, formatRemoteServiceStatus } =
      await import("../src/core/remoteAgent/remoteStatusService.js");
    const remote = await getRemoteServiceStatus("all");
    expect(remote.channelHosts?.some(item => item.port === port)).toBe(true);
    expect(formatRemoteServiceStatus(remote, "all")).toContain("[4] Independent Channel Hosts:");
  });

  it("uses exclusive leases for real Muse/Telegram modes without contacting providers in tests", async () => {
    const first = await freePort();
    const second = await freePort();
    const fixture = { botToken: "fixture", groupId: "group", museBotId: "muse" };
    const noOp = async () => {};
    const firstHost = await runChannelHost({
      port: first, wsPort: 9225, mode: "telegram-fallback",
      config: fixture, startWatcher: noOp,
    });
    running.push(firstHost.server);
    const health = await fetch("http://127.0.0.1:" + first + "/_channel/health");
    const data = await health.json() as Record<string, unknown>;
    expect(data).toMatchObject({ mode: "telegram-fallback", status: "running" });
    expect(data.watcherActive).toBe(false); // Mock: no real Telegram connection.
    await expect(runChannelHost({
      port: second, wsPort: 9225, mode: "telegram-fallback",
      config: fixture, startWatcher: noOp,
    })).rejects.toThrow();
    await new Promise<void>(resolve => firstHost.server.close(() => resolve()));
    running.splice(running.indexOf(firstHost.server), 1);
    const replacement = await runChannelHost({
      port: second, wsPort: 9225, mode: "telegram-fallback",
      config: fixture, startWatcher: noOp,
    });
    running.push(replacement.server);
  });
  it("does not take over the core port, an existing socket or another channel port", async () => {
    await expect(runChannelHost({ port: 7888, wsPort: 9225, mode: "idle" })).rejects.toThrow();
    await expect(runChannelHost({ port: 9225, wsPort: 9225, mode: "idle" })).rejects.toThrow();
    const mock = net.createServer();
    const port = await freePort();
    await new Promise<void>(resolve => mock.listen(port, "127.0.0.1", resolve));
    try {
      await expect(runChannelHost({ port, wsPort: 9225, mode: "idle" })).rejects.toThrow();
    } finally {
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  });
});
