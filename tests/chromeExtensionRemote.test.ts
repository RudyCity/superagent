import { describe, test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  ensureRemoteChromeBridge,
  sendRemoteCommand,
  stopRemoteChromeBridge,
} from "../src/core/tools/remoteChromeBridge.js";

describe("chromeExtensionRemote & remoteChromeBridge", () => {
  afterEach(async () => {
    await stopRemoteChromeBridge();
  });

  test("ensureRemoteChromeBridge initializes WebSocket server on specified port", async () => {
    const started = await ensureRemoteChromeBridge(9245);
    expect(started).toBe(true);
  });

  test("sendRemoteCommand rejects when no extension is connected", async () => {
    await ensureRemoteChromeBridge(9246);
    await expect(sendRemoteCommand("navigate", "https://example.com")).rejects.toThrow(
      "Remote Chrome Control Extension (chrome-extension-remote) is not connected"
    );
  });

  test("sendRemoteCommand handles client error response", async () => {
    await ensureRemoteChromeBridge(9247);

    const client = new WebSocket("ws://127.0.0.1:9247");
    await new Promise((res) => client.on("open", res));

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
    await stopRemoteChromeBridge();

    const client = new WebSocket("ws://127.0.0.1:9248");
    const isClosed = await new Promise<boolean>((resolve) => {
      client.on("error", () => resolve(true));
      client.on("open", () => {
        client.close();
        resolve(false);
      });
    });
    expect(isClosed).toBe(true);
  });
});
