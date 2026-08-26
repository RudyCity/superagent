import { describe, test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  ensureRemoteChromeBridge,
  sendRemoteCommand,
  stopRemoteChromeBridge,
  isRemoteChromeConnected,
  getRemoteChromeClientMetadata,
  getBridgeToken,
} from "../src/core/tools/remoteChromeBridge.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("remoteChromeBridge comprehensive test suite", () => {
  afterEach(async () => {
    await stopRemoteChromeBridge();
  });

  test("tracks client metadata when hello packet is received", async () => {
    const port = 9260;
    await ensureRemoteChromeBridge(port);
    const authToken = getBridgeToken();

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res) => client.on("open", res));

    // Complete the post-connect handshake first.
    client.send(
      JSON.stringify({ type: "bridge_handshake_v1", token: authToken })
    );
    await new Promise((res) => setTimeout(res, 100));

    client.send(
      JSON.stringify({
        type: "hello",
        userAgent: "Mozilla/5.0 Test Chrome",
        platform: "Win32",
        extensionVersion: "1.2.0",
        tabsCount: 5,
      })
    );

    // Give server time to process hello packet
    await new Promise((res) => setTimeout(res, 200));

    expect(isRemoteChromeConnected()).toBe(true);
    const meta = getRemoteChromeClientMetadata();
    expect(meta).not.toBeNull();
    expect(meta?.extensionVersion).toBe("1.2.0");
    expect(meta?.platform).toBe("Win32");
    expect(meta?.tabsCount).toBe(5);

    client.close();
  });

  test("rejects pending requests instantly when client disconnects", async () => {
    const port = 9261;
    await ensureRemoteChromeBridge(port);
    const authToken = getBridgeToken();

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res) => client.on("open", res));
    // Complete the post-connect handshake first.
    client.send(
      JSON.stringify({ type: "bridge_handshake_v1", token: authToken })
    );
    await new Promise((res) => setTimeout(res, 100));

    const commandPromise = sendRemoteCommand("navigate", "https://example.com");

    // Close client immediately before responding to trigger instant rejection
    client.close();

    await expect(commandPromise).rejects.toThrow("disconnected");
  });

  test("enforces command rate limit when exceeding max requests per second", async () => {
    const port = 9262;
    await ensureRemoteChromeBridge(port);
    const authToken = getBridgeToken();

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res) => client.on("open", res));
    client.send(
      JSON.stringify({ type: "bridge_handshake_v1", token: authToken })
    );
    await new Promise((res) => setTimeout(res, 100));

    // Respond immediately to requests so they resolve quickly
    client.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      client.send(
        JSON.stringify({
          id: data.id,
          success: true,
          result: "ok",
        })
      );
    });

    const promises: Promise<string>[] = [];
    for (let i = 0; i < 35; i++) {
      promises.push(sendRemoteCommand("ping", "target"));
    }

    const results = await Promise.allSettled(promises);
    const rateLimited = results.filter((r) => r.status === "rejected");
    expect(rateLimited.length).toBeGreaterThan(0);

    client.close();
  });

  test("appends logs to ~/.superagent-r/bridge.log on events", async () => {
    const port = 9263;
    await ensureRemoteChromeBridge(port);

    const logFile = path.join(os.homedir(), ".superagent-r", "bridge.log");
    expect(fs.existsSync(logFile)).toBe(true);

    const logContent = fs.readFileSync(logFile, "utf8");
    expect(logContent).toContain("[BRIDGE] Server Started");
  });
});
