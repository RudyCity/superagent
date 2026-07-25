import { describe, test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  ensureRemoteChromeBridge,
  sendRemoteCommand,
  stopRemoteChromeBridge,
} from "../src/core/tools/remoteChromeBridge.js";

describe("remoteChromeBridge", () => {
  afterEach(async () => {
    await stopRemoteChromeBridge();
  });

  test("ensureRemoteChromeBridge starts WebSocket server on port 9223", async () => {
    const started = await ensureRemoteChromeBridge(9223);
    expect(started).toBe(true);
  });

  test("sendRemoteCommand exchanges messages with connected client", async () => {
    await ensureRemoteChromeBridge(9224);

    const client = new WebSocket("ws://127.0.0.1:9224");

    await new Promise((res) => client.on("open", res));

    client.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      client.send(
        JSON.stringify({
          id: msg.id,
          success: true,
          result: `Handled ${msg.action} on ${msg.target}`,
        })
      );
    });

    const result = await sendRemoteCommand("navigate", "https://example.com");
    expect(result).toBe("Handled navigate on https://example.com");

    client.close();
  });
});
