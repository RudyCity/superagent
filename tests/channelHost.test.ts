import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  runChannelHost, validateChannelHostMode, handleChannelHostCliCommand,
  listVerifiedChannelHosts, requestChannelHostIpc, validateChannelIpcCommand,
} from "../src/core/runtime/channelHost.js";

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
  it("rejects unauthorized IPC, deduplicates retries, and never exposes its token", async () => {
    const port = await freePort();
    const id = "a".repeat(32);
    const received: string[] = [];
    const host = await runChannelHost({
      port, wsPort: 9225, mode: "telegram-fallback",
      config: { botToken: "fixture", groupId: "group", museBotId: "muse" },
      startWatcher: async () => {},
      executeIpc: async command => {
        received.push(command.operation + ":" + command.text);
        await new Promise(resolve => setTimeout(resolve, 50));
        return true;
      },
    });
    running.push(host.server);
    const base = "http://127.0.0.1:" + port;
    await new Promise(resolve => setTimeout(resolve, 20));
    const health = await (await fetch(base + "/_channel/health")).text();
    const discoveryFile = path.join(os.homedir(), ".superagent-r", "channel-host-" + port + ".json");
    const discovery = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
    expect(discovery.ipcToken).toMatch(/^[a-f0-9]{64}$/);
    expect(health).not.toContain(discovery.ipcToken);
    const payload = { operation: "steer", text: "change plan", requestId: id };
    const unauthorized = await fetch(base + "/_channel/ipc", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(unauthorized.status).toBe(401);
    expect(received).toHaveLength(0);
    const sent = await Promise.all([
      requestChannelHostIpc(port, "steer", "change plan", id),
      requestChannelHostIpc(port, "steer", "change plan", id),
    ]);
    expect(sent.every(reply => reply.ok)).toBe(true);
    expect(received).toEqual(["steer:change plan"]);
    const different = await fetch(base + "/_channel/ipc", {
      method: "POST",
      headers: { Authorization: "Bearer " + discovery.ipcToken, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, text: "different instruction" }),
    });
    expect(different.status).toBe(409);
    expect(received).toHaveLength(1);
    expect((await requestChannelHostIpc(port, "task", "next task")).ok).toBe(true);
    expect((await requestChannelHostIpc(port, "abort", "")).ok).toBe(true);
    expect(received).toEqual(["steer:change plan", "task:next task", "abort:"]);
    // Exercise the real /muse host command path across the authenticated
    // loopback HTTP boundary, never touching a real external Muse transport.
    const { museCommand } = await import("../src/core/commands/museCommand.js");
    const lines: Array<{ type: string; content: string }> = [];
    await museCommand.execute("host steer via core --port " + port, {
      addLine: (line: { type: string; content: string }) => { lines.push(line); },
    } as any);
    expect(received.at(-1)).toBe("steer:via core");
    expect(lines.some(line => line.content.includes("acknowledged"))).toBe(true);
  });

  it("rejects malformed and excessive IPC commands and fails closed when idle", async () => {
    expect(() => validateChannelIpcCommand({ operation: "task", text: "hello", requestId: "bad" })).toThrow();
    expect(() => validateChannelIpcCommand({ operation: "steer", text: "", requestId: "a".repeat(32) })).toThrow();
    expect(() => validateChannelIpcCommand({ operation: "task", text: "x".repeat(4097), requestId: "a".repeat(32) })).toThrow();
    const port = await freePort();
    const host = await runChannelHost({ port, wsPort: 9225, mode: "idle" });
    running.push(host.server);
    await expect(requestChannelHostIpc(port, "task", "hello")).rejects.toThrow(/not active/);
    const discovery = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), ".superagent-r", "channel-host-" + port + ".json"), "utf8"));
    const res = await fetch("http://127.0.0.1:" + port + "/_channel/ipc", {
      method: "POST",
      headers: { Authorization: "Bearer " + discovery.ipcToken, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "task", text: "hello", requestId: "a".repeat(32) }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_READY");
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
