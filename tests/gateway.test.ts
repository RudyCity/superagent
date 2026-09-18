import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { GatewayManager } from "../src/core/gateway/gatewayManager.js";
import { WebhookAdapter } from "../src/core/gateway/adapters/webhookAdapter.js";
import { TelegramAdapter } from "../src/core/gateway/adapters/telegramAdapter.js";
import { DiscordAdapter } from "../src/core/gateway/adapters/discordAdapter.js";
import { SlackAdapter } from "../src/core/gateway/adapters/slackAdapter.js";

describe("Omnichannel Gateway", () => {
  let tmpDir: string;
  let manager: GatewayManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `superagent_gateway_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new GatewayManager(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("initializes with default status and configuration", () => {
    const status = manager.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.channels.webhook.enabled).toBe(true);
    expect(status.channels.telegram.enabled).toBe(false);
    expect(status.channels.discord.enabled).toBe(false);
    expect(status.channels.slack.enabled).toBe(false);
    expect(status.totalMessagesReceived).toBe(0);
  });

  it("updates configuration dynamically and persists to disk", () => {
    manager.updateConfig({
      channels: {
        telegram: { enabled: true, botToken: "test_bot_token" },
        webhook: { enabled: true, secretToken: "my_secret" },
        discord: { enabled: false },
        slack: { enabled: false }
      }
    });

    const updated = manager.getConfig();
    expect(updated.channels.telegram.enabled).toBe(true);
    expect(updated.channels.telegram.botToken).toBe("test_bot_token");
    expect(updated.channels.webhook.secretToken).toBe("my_secret");

    // Load a second instance to check persistence
    const manager2 = new GatewayManager(tmpDir);
    expect(manager2.getConfig().channels.telegram.botToken).toBe("test_bot_token");
  });

  describe("WebhookAdapter", () => {
    it("validates secret token authorization", () => {
      const adapter = new WebhookAdapter({ enabled: true, secretToken: "valid_token" });
      expect(adapter.isAuthorized({ "x-webhook-secret": "valid_token" })).toBe(true);
      expect(adapter.isAuthorized({ "authorization": "Bearer valid_token" })).toBe(true);
      expect(adapter.isAuthorized({ "x-webhook-secret": "wrong_token" })).toBe(false);
    });

    it("parses inbound payload correctly", () => {
      const adapter = new WebhookAdapter({ enabled: true });
      const inbound = adapter.parseInbound({
        message: "Hello Superagent",
        senderId: "user_42",
        senderName: "Alice"
      });

      expect(inbound.channel).toBe("webhook");
      expect(inbound.text).toBe("Hello Superagent");
      expect(inbound.senderId).toBe("user_42");
      expect(inbound.senderName).toBe("Alice");
    });
  });

  describe("TelegramAdapter", () => {
    it("chunks long messages properly", () => {
      const adapter = new TelegramAdapter({ enabled: true });
      const longText = "a".repeat(9000);
      const chunks = adapter.chunkMessage(longText, 4000);
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4000);
      }
    });

    it("checks user whitelisting", () => {
      const adapter = new TelegramAdapter({ enabled: true, allowedUserIds: ["12345", "67890"] });
      expect(adapter.isUserAllowed("12345")).toBe(true);
      expect(adapter.isUserAllowed(67890)).toBe(true);
      expect(adapter.isUserAllowed("99999")).toBe(false);
    });

    it("parses Telegram update object", () => {
      const adapter = new TelegramAdapter({ enabled: true });
      const inbound = adapter.parseInbound({
        update_id: 100,
        message: {
          message_id: 55,
          from: { id: 12345, username: "testuser" },
          chat: { id: 12345 },
          text: "/status check"
        }
      });

      expect(inbound).not.toBeNull();
      expect(inbound?.channel).toBe("telegram");
      expect(inbound?.text).toBe("/status check");
      expect(inbound?.senderId).toBe("12345");
      expect(inbound?.senderName).toBe("testuser");
    });
  });

  describe("DiscordAdapter", () => {
    it("handles interaction ping by returning null for routing", () => {
      const adapter = new DiscordAdapter({ enabled: true });
      const parsed = adapter.parseInbound({ type: 1 });
      expect(parsed).toBeNull();
    });

    it("chunks messages to under 2000 characters", () => {
      const adapter = new DiscordAdapter({ enabled: true });
      const longText = "x".repeat(4500);
      const chunks = adapter.chunkMessage(longText, 1900);
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBeLessThanOrEqual(1900);
    });
  });

  describe("SlackAdapter", () => {
    it("handles url_verification challenge", () => {
      const adapter = new SlackAdapter({ enabled: true });
      const res = adapter.handleUrlVerification({
        type: "url_verification",
        challenge: "challenge_code_123"
      });
      expect(res).toEqual({ challenge: "challenge_code_123" });
    });

    it("ignores bot messages to prevent echo loops", () => {
      const adapter = new SlackAdapter({ enabled: true });
      const parsed = adapter.parseInbound({
        type: "event_callback",
        event: {
          type: "message",
          bot_id: "B12345",
          text: "Echo"
        }
      });
      expect(parsed).toBeNull();
    });
  });

  describe("End-to-End Processing & Session Persistence", () => {
    it("routes inbound message, creates session mapping, and returns response", async () => {
      const inbound = {
        channel: "webhook" as const,
        channelMessageId: "msg_1",
        senderId: "dev_user_1",
        text: "Analyze repository"
      };

      let runnerCalled = false;
      const runner = async (msg: any, session: any) => {
        runnerCalled = true;
        expect(session.sessionId).toBeDefined();
        return `Processed: ${msg.text}`;
      };

      const outbound = await manager.processInbound(inbound, runner);
      expect(runnerCalled).toBe(true);
      expect(outbound.status).toBe("success");
      expect(outbound.text).toBe("Processed: Analyze repository");

      // Verify session reuse for the same user
      const session1 = manager.getOrCreateSession("webhook", "dev_user_1");
      expect(session1.sessionId).toBe(outbound.sessionId);

      // Verify stats
      const status = manager.getStatus();
      expect(status.totalMessagesReceived).toBe(1);
      expect(status.totalMessagesSent).toBe(1);
      expect(status.totalErrors).toBe(0);
    });

    it("blocks unauthorized user when whitelist is configured", async () => {
      manager.updateConfig({
        channels: {
          telegram: { enabled: true, allowedUserIds: ["authorized_user"] },
          webhook: { enabled: true },
          discord: { enabled: false },
          slack: { enabled: false }
        }
      });

      const inbound = {
        channel: "telegram" as const,
        channelMessageId: "msg_blocked",
        senderId: "unauthorized_user",
        text: "Secret command"
      };

      const outbound = await manager.processInbound(inbound, async () => "Should not run");
      expect(outbound.status).toBe("error");
      expect(outbound.text).toContain("Access denied");

      const status = manager.getStatus();
      expect(status.totalErrors).toBe(1);
    });
  });
});
