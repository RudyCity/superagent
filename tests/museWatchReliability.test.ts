import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseClient } from "../src/core/remoteAgent/museClient.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import { saveRemoteAgentConfig } from "../src/core/remoteAgent/config.js";
import { TelegramTransport, type RemoteTransport } from "../src/core/remoteAgent/transport.js";
import type { RemoteAgentEnvelope } from "../src/core/remoteAgent/protocol.js";

describe("Muse watch ingress reliability", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const config = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-watch-health-"));
    roots.push(dir);
    const file = path.join(dir, "remote-agent.json");
    saveRemoteAgentConfig({
      botToken: "test-token", groupId: "-100123", museBotId: "987654",
    }, file);
    return { dir, file };
  };

  const transport = (
    type: "telegram" | "websocket",
    send: (envelope: RemoteAgentEnvelope) => Promise<boolean>,
    start: () => Promise<void> = async () => {},
    connected = false,
  ): RemoteTransport => ({
    type,
    start,
    stop: async () => {},
    sendEnvelope: send,
    isConnected: () => connected,
    getTransportInfo: () => ({ type, details: "isolated test transport" }),
  });

  it("does not leave a falsely ACTIVE watcher when Telegram poller exits unexpectedly", async () => {
    const { dir, file } = config();
    const watcher = new MuseWatcher({
      workspace: dir, customConfigPath: file, announce: false,
      transport: transport("telegram", async () => true),
    });
    await watcher.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(watcher.isActive()).toBe(false);
    expect(watcher.getStats().lastTransportError).toContain("polling exited unexpectedly");
  });

  it("reports WebSocket listener running but not connected as NOT ready", async () => {
    const { dir, file } = config();
    const watcher = new MuseWatcher({
      workspace: dir, customConfigPath: file, announce: false,
      transport: transport("websocket", async () => true),
    });
    await watcher.start();
    try {
      expect(watcher.isActive()).toBe(true);
      expect(watcher.getStats().museConnected).toBe(false);
      expect(watcher.getStats().transport).toBe("websocket");
    } finally {
      await watcher.stop();
    }
  });

  it("records missing task_result delivery, without re-executing a batch", async () => {
    const { dir, file } = config();
    const seen: string[] = [];
    const watcher = new MuseWatcher({
      workspace: dir, customConfigPath: file, announce: false,
      transport: transport("websocket", async (envelope) => {
        seen.push(envelope.kind);
        return envelope.kind !== "task_result";
      }, async () => {}, true),
    });
    await watcher.start();
    try {
      await watcher.handleEnvelope({
        v: 1, kind: "task_batch", id: "delivery-fail",
        task_id: "task-delivery-fail", calls: [],
      });
      await watcher.waitForIdle();
      expect(watcher.getStats().batchesExecuted).toBe(1);
      expect(seen).toEqual(["task_result"]);
      expect(watcher.getStats().lastTransportError).toContain("task_result delivery failed");
    } finally {
      await watcher.stop();
    }
  });

  it("notifies remote side of an indeterminate result send error without replay", async () => {
    const { dir, file } = config();
    const seen: string[] = [];
    const watcher = new MuseWatcher({
      workspace: dir, customConfigPath: file, announce: false,
      transport: transport("websocket", async (envelope) => {
        seen.push(envelope.kind);
        if (envelope.kind === "task_result") throw new Error("disconnect during send");
        if (envelope.kind === "chat") {
          expect(envelope.text).toContain("do NOT retry automatically");
        }
        return true;
      }, async () => {}, true),
    });
    await watcher.start();
    try {
      await watcher.handleEnvelope({
        v: 1, kind: "task_batch", id: "send-throws",
        task_id: "task-send-throws", calls: [],
      });
      await watcher.waitForIdle();
      expect(seen).toEqual(["task_result", "chat"]);
      expect(watcher.getStats().batchesExecuted).toBe(1);
      expect(watcher.getStats().lastTransportError).toContain("send-throws");
    } finally {
      await watcher.stop();
    }
  });

  it("marks conflicting or stale Telegram pollers NOT ready even if their loops are alive", async () => {
    const client = new MuseClient({ botToken: "test-token", groupId: "-100123", museBotId: "987654" });
    vi.spyOn(client, "pollEnvelopes").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(client, "isPollerActive").mockReturnValue(true);
    const health = vi.spyOn(client, "getPollHealth");
    const listener = new TelegramTransport(client.getConfig(), client);
    void listener.start(async () => {});
    try {
      health.mockReturnValue({ lastSuccessfulPollAt: Date.now(), lastError: "Telegram 409 Conflict" });
      expect(listener.isConnected()).toBe(false);
      health.mockReturnValue({ lastSuccessfulPollAt: Date.now() - 61_000 });
      expect(listener.isConnected()).toBe(false);
      health.mockReturnValue({ lastSuccessfulPollAt: Date.now() });
      expect(listener.isConnected()).toBe(true);
    } finally {
      await listener.stop();
    }
  });

  it("advances Telegram getUpdates offset on rejected updates", async () => {
    const received: RemoteAgentEnvelope[] = [];
    const urls: string[] = [];
    const ctrl = new AbortController();
    let polls = 0;
    const client = new MuseClient({
      botToken: "test-token", groupId: "-100123", museBotId: "987654",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      if (String(url).includes("deleteWebhook")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as any;
      }
      urls.push(String(url));
      polls++;
      if (polls > 1) {
        ctrl.abort();
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as any;
      }
      const msg = (update_id: number, chatId: number, senderId: number, text: string) => ({
        update_id, message: {
          message_id: update_id, date: Math.floor(Date.now() / 1000),
          chat: { id: chatId }, from: { id: senderId }, text,
        },
      });
      return { ok: true, status: 200, json: async () => ({
        ok: true,
        result: [
          msg(110, -999, 987654, "other group"),
          msg(111, -100123, 222, JSON.stringify({
            v: 1, kind: "task_batch", id: "untrusted", task_id: "untrusted",
            calls: [{ id: "x", tool: "run_command", args: {} }],
          })),
          msg(112, -100123, 987654, JSON.stringify({
            v: 1, kind: "task_batch", id: "invalid", task_id: "invalid", calls: "bad",
          })),
        ],
      }) } as any;
    });
    await client.pollEnvelopes(envelope => { received.push(envelope); }, ctrl.signal);
    expect(received).toHaveLength(0);
    expect(urls[1]).toContain("offset=113");
    expect(client.getPollHealth().lastError).toBeUndefined();
    expect(client.getPollHealth().lastSuccessfulPollAt).toBeTypeOf("number");
  });
});
