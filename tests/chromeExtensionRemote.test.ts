import { describe, test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  ensureRemoteChromeBridge,
  sendRemoteCommand,
  stopRemoteChromeBridge,
  isRemoteChromeConnected,
  getBridgeToken,
} from "../src/core/tools/remoteChromeBridge.js";

describe("chromeExtensionRemote & remoteChromeBridge", () => {
  afterEach(async () => {
    await stopRemoteChromeBridge();
  });

  test("sendRemoteCommand rejects when no extension is connected", async () => {
    await ensureRemoteChromeBridge(9246);
    await expect(sendRemoteCommand("navigate", "https://example.com")).rejects.toThrow(
      /not connected/i
    );
  });

  test("sendRemoteCommand handles client error response", async () => {
    await ensureRemoteChromeBridge(9247);
    const authToken = getBridgeToken();

    const client = new WebSocket("ws://127.0.0.1:9247");
    await new Promise((res) => client.on("open", res));
    // Complete the post-connect handshake first.
    client.send(
      JSON.stringify({ type: "bridge_handshake_v1", token: authToken })
    );
    await new Promise((res) => setTimeout(res, 100));

    const responsePromise = new Promise<void>((resolve, reject) => {
      client.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          client.send(
            JSON.stringify({
              id: msg.id,
              success: false,
              error: "Element not found on page",
            })
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    const commandPromise = sendRemoteCommand("click", "#invalid-btn");
    await responsePromise;
    await expect(commandPromise).rejects.toThrow("Element not found on page");

    client.close();
  });

  test("stopRemoteChromeBridge shuts down server and resets state", async () => {
    await ensureRemoteChromeBridge(9248);
    expect(isRemoteChromeConnected()).toBe(false);
    await stopRemoteChromeBridge();
    expect(isRemoteChromeConnected()).toBe(false);
  });

  test("isRemoteChromeConnected returns false when bridge is not started", () => {
    expect(isRemoteChromeConnected()).toBe(false);
  });
});
