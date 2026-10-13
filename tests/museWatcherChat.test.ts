import { beforeEach, describe, expect, it, vi } from "vitest";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";

function makeWatcher(sendEnvelope: (envelope: any) => Promise<boolean>, connected = true) {
  const watcher = Object.create(MuseWatcher.prototype) as any;
  watcher.isRunning = true;
  watcher.transport = {
    type: "websocket",
    isConnected: () => connected,
    sendEnvelope,
  };
  watcher.pendingChatReplies = new Map();
  watcher.seenChatIds = new Set();
  watcher.emitLine = vi.fn();
  return watcher;
}

describe("MuseWatcher two-way chat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for a response correlated to the exact chat request ID", async () => {
    let watcher: any;
    const sendEnvelope = vi.fn(async (envelope: any) => {
      queueMicrotask(() => {
        void watcher.handleEnvelope({
          v: 1,
          kind: "chat",
          id: "muse-response-1",
          reply_to: envelope.id,
          text: "Halo juga dari Muse.",
        });
      });
      return true;
    });
    watcher = makeWatcher(sendEnvelope);

    const result = await watcher.requestChat("Halo Muse", 1_000);

    expect(result.requestId).toMatch(/^mcp-muse-chat-/);
    expect(result.responseId).toBe("muse-response-1");
    expect(result.reply).toBe("Halo juga dari Muse.");
    expect(sendEnvelope).toHaveBeenCalledOnce();
    expect(sendEnvelope.mock.calls[0][0]).toMatchObject({
      v: 1,
      kind: "chat",
      id: result.requestId,
    });
    expect(sendEnvelope.mock.calls[0][0].text).toContain("Halo Muse");
    expect(watcher.pendingChatReplies.size).toBe(0);
  });

  it("times out when Muse does not send a correlated reply", async () => {
    const watcher = makeWatcher(vi.fn(async () => true));

    await expect(watcher.requestChat("Ada?", 1_000)).rejects.toThrow(/Timed out/);
    expect(watcher.pendingChatReplies.size).toBe(0);
  });

  it("refuses to send when the WebSocket is disconnected", async () => {
    const sendEnvelope = vi.fn(async () => true);
    const watcher = makeWatcher(sendEnvelope, false);

    await expect(watcher.requestChat("Halo", 1_000)).rejects.toThrow(/not connected/i);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });
});
