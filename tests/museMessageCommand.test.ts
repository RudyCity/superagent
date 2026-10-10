import { describe, it, expect, vi, beforeEach } from "vitest";

const mockState = {
  sentTelegramMessages: [] as { chatId: string | number; text: string }[],
  steerMessages: [] as string[],
  config: {
    botToken: "test_bot_token",
    groupId: "-100123456789",
    museBotId: "987654321",
    transport: "telegram",
  } as any,
  isWatcherActive: false,
};

vi.mock("../src/core/remoteAgent/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/remoteAgent/config.js")>();
  return {
    ...actual,
    loadRemoteAgentConfig: () => mockState.config,
  };
});

vi.mock("../src/core/remoteAgent/museClient.js", () => {
  return {
    MuseClient: class {
      config: any;
      constructor(config: any) {
        this.config = config;
      }
      async sendMessage(chatId: string | number, text: string) {
        mockState.sentTelegramMessages.push({ chatId, text });
        return true;
      }
    },
  };
});

vi.mock("../src/core/remoteAgent/museWatcher.js", () => {
  return {
    isMuseWatcherActive: () => mockState.isWatcherActive,
    sendMuseSteerMessage: async (text: string) => {
      mockState.steerMessages.push(text);
      return true;
    },
    abortActiveMuseBatch: vi.fn(),
  };
});

import { museCommand } from "../src/core/commands/museCommand.js";

describe("/muse msg and /muse send commands", () => {
  let lines: { type: string; content: string }[];
  let ctx: any;

  beforeEach(() => {
    mockState.sentTelegramMessages = [];
    mockState.steerMessages = [];
    mockState.isWatcherActive = false;
    mockState.config = {
      botToken: "test_bot_token",
      groupId: "-100123456789",
      museBotId: "987654321",
      transport: "telegram",
    };
    lines = [];
    ctx = {
      addLine: (line: any) => lines.push(line),
    };
  });

  it("should show usage error if /muse msg is called without text", async () => {
    await museCommand.execute("msg", ctx);
    expect(lines.some((l) => l.type === "error" && l.content.includes("Usage: /muse msg <message>"))).toBe(true);
    expect(mockState.sentTelegramMessages).toHaveLength(0);
  });

  it("should send message directly to Telegram group via /muse msg <text>", async () => {
    await museCommand.execute("msg Halo dari Superagent", ctx);
    expect(mockState.sentTelegramMessages).toHaveLength(1);
    expect(mockState.sentTelegramMessages[0].chatId).toBe("-100123456789");
    expect(mockState.sentTelegramMessages[0].text).toBe("Halo dari Superagent");
    expect(lines.some((l) => l.type === "system" && l.content.includes("Sent message to Telegram group"))).toBe(true);
  });

  it("should support /muse send and /muse tg aliases", async () => {
    await museCommand.execute("send Pesan penting", ctx);
    expect(mockState.sentTelegramMessages).toHaveLength(1);
    expect(mockState.sentTelegramMessages[0].text).toBe("Pesan penting");

    await museCommand.execute("tg Pesan kedua", ctx);
    expect(mockState.sentTelegramMessages).toHaveLength(2);
    expect(mockState.sentTelegramMessages[1].text).toBe("Pesan kedua");
  });

  it("should forward to Muse brain when watcher is active", async () => {
    mockState.isWatcherActive = true;
    await museCommand.execute("msg Halo Muse dan Telegram", ctx);

    expect(mockState.sentTelegramMessages).toHaveLength(1);
    expect(mockState.steerMessages).toHaveLength(1);
    expect(mockState.steerMessages[0]).toBe("Halo Muse dan Telegram");
    expect(lines.some((l) => l.content.includes("Forwarded chat message to active Muse brain session"))).toBe(true);
  });

  it("should notify user when Telegram is not configured", async () => {
    mockState.config = { transport: "websocket" };
    await museCommand.execute("msg Halo tanpa config", ctx);

    expect(lines.some((l) => l.type === "error" && l.content.includes("not configured for Telegram"))).toBe(true);
  });
});
