import { describe, test, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { withBrowserBridgeOperation } from "../src/core/tools/chromeCdpSessionManager.js";
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

    await vi.waitFor(() => expect(isRemoteChromeConnected()).toBe(true), {timeout:2000});
    // Closing before the globally serialized operation is dispatched tests a
    // different contract ("not connected"). Wait for the actual request.
    const delivered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bridge request was not dispatched")), 3000);
      client.on("message", (payload) => {
        try {
          if (JSON.parse(payload.toString()).action === "navigate") {
            clearTimeout(timer);resolve();
          }
        } catch {}
      });
    });
    const commandPromise = sendRemoteCommand("navigate", "https://example.com");
    await delivered;
    client.close();
    await expect(commandPromise).rejects.toThrow(/disconnect/i);
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

    await vi.waitFor(() => expect(isRemoteChromeConnected()).toBe(true), {timeout:2000});
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

    // A top-level burst is serialized by the browser lifecycle mutex and may
    // not exceed 30/s. Inside an already-authorized bridge operation, send
    // the actual concurrent burst to verify the rate limiter itself.
    const results = await withBrowserBridgeOperation(async () => {
      const promises: Promise<string>[] = [];
      for (let i = 0; i < 35; i++) promises.push(sendRemoteCommand("ping", "target"));
      return Promise.allSettled(promises);
    });
    const rateLimited = results.filter((r) => r.status === "rejected" && /rate limit/i.test(String((r as PromiseRejectedResult).reason)));
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
