import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stopCommand, steerCommand } from "../src/core/commands/coreCommands.js";
import { MuseWatcher, getMuseWatcher, isMuseWatcherActive, abortActiveMuseBatch, sendMuseSteerMessage } from "../src/core/remoteAgent/museWatcher.js";
import { bashTool, runCommandTool } from "../src/core/tools/shellTools.js";

describe("Process Cancellation & Steering Suite (/stop, /steer, Muse Watch abort)", () => {
  describe("Slash Commands: /stop and /steer", () => {
    it("should abort running agents and clear output when /stop is called", async () => {
      const mockAgent = {
        abort: vi.fn(),
        queueMessage: vi.fn(),
      };
      const lines: any[] = [];
      const ctx: any = {
        agent: mockAgent,
        addLine: (line: any) => lines.push(line),
        setIsProcessing: vi.fn(),
      };

      await stopCommand.execute("", ctx);

      expect(mockAgent.abort).toHaveBeenCalled();
      expect(ctx.setIsProcessing).toHaveBeenCalledWith(false);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("[Stop] Execution stopped by user.");
    });

    it("should queue steering note when /stop is called with arguments", async () => {
      const mockAgent = {
        abort: vi.fn(),
        queueMessage: vi.fn(),
      };
      const lines: any[] = [];
      const ctx: any = {
        agent: mockAgent,
        addLine: (line: any) => lines.push(line),
        setIsProcessing: vi.fn(),
      };

      await stopCommand.execute("Jangan pakai grep di root, pakai ripgrep di src", ctx);

      expect(mockAgent.abort).toHaveBeenCalled();
      expect(mockAgent.queueMessage).toHaveBeenCalledWith(
        expect.stringContaining("Jangan pakai grep di root")
      );
      expect(lines[0].content).toContain("Steering note:");
    });

    it("should require feedback text when /steer is called", async () => {
      const lines: any[] = [];
      const ctx: any = {
        addLine: (line: any) => lines.push(line),
      };

      await steerCommand.execute("", ctx);

      expect(lines.length).toBe(1);
      expect(lines[0].type).toBe("error");
      expect(lines[0].content).toContain("Usage: /steer");
    });

    it("should abort current run and queue feedback when /steer has text", async () => {
      const mockAgent = {
        abort: vi.fn(),
        queueMessage: vi.fn(),
      };
      const lines: any[] = [];
      const handleSubmit = vi.fn();
      const ctx: any = {
        agent: mockAgent,
        addLine: (line: any) => lines.push(line),
        setIsProcessing: vi.fn(),
        handleSubmit,
      };

      await steerCommand.execute("Ganti pendekatan ke AST parsing", ctx);

      expect(mockAgent.abort).toHaveBeenCalled();
      expect(mockAgent.queueMessage).toHaveBeenCalledWith(
        expect.stringContaining("Ganti pendekatan ke AST parsing")
      );
      expect(handleSubmit).toHaveBeenCalledWith("Ganti pendekatan ke AST parsing");
      expect(lines[0].content).toContain("[Steer] Intervened");
    });
  });

  describe("MuseWatcher abortActiveBatch and sendSteeringMessage", () => {
    it("should abort in-flight batch and send envelope to Muse", async () => {
      const sentEnvelopes: any[] = [];
      const mockTransport: any = {
        type: "websocket",
        getTransportInfo: () => ({ type: "websocket", details: "mock" }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendEnvelope: vi.fn().mockImplementation(async (env) => {
          sentEnvelopes.push(env);
          return true;
        }),
      };

      const watcher = new MuseWatcher({
        transport: mockTransport,
        announce: false,
      });

      // Simulate a running watcher with an active task
      (watcher as any).isRunning = true;
      (watcher as any).activeTaskId = "task_test_123";
      const batchAbort = new AbortController();
      (watcher as any).activeBatchAborts.add(batchAbort);

      expect(watcher.hasActiveBatch()).toBe(true);

      const didAbort = watcher.abortActiveBatch("User cancelled via Ctrl+C");
      expect(didAbort).toBe(true);
      expect(batchAbort.signal.aborted).toBe(true);
      expect(watcher.hasActiveBatch()).toBe(false);

      // Verify notification envelope sent to Muse
      const abortChat = sentEnvelopes.find((e) => e.kind === "chat" && e.text.includes("[Operator Abort]"));
      expect(abortChat).toBeDefined();
      expect(abortChat.text).toContain("task_test_123");
    });

    it("should send steering intervention message to Muse", async () => {
      const sentEnvelopes: any[] = [];
      const mockTransport: any = {
        type: "websocket",
        getTransportInfo: () => ({ type: "websocket", details: "mock" }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendEnvelope: vi.fn().mockImplementation(async (env) => {
          sentEnvelopes.push(env);
          return true;
        }),
      };

      const watcher = new MuseWatcher({
        transport: mockTransport,
        announce: false,
      });

      (watcher as any).isRunning = true;

      const sent = await watcher.sendSteeringMessage("Fokus hanya pada file login.ts");
      expect(sent).toBe(true);
      expect(sentEnvelopes.length).toBe(1);
      expect(sentEnvelopes[0].kind).toBe("chat");
      expect(sentEnvelopes[0].text).toContain("Fokus hanya pada file login.ts");
    });
  });

  describe("Shell Tool Cancellation & Stdin Protection", () => {
    it("should abort immediately on signal without hanging", async () => {
      const controller = new AbortController();

      // Trigger abort after 100ms
      setTimeout(() => {
        controller.abort();
      }, 100);

      const start = Date.now();
      await expect(
        bashTool.execute(
          { command: "node -e \"setTimeout(() => {}, 30000)\"" },
          process.cwd(),
          controller.signal
        )
      ).rejects.toThrow("AbortError");

      const elapsed = Date.now() - start;
      // Should terminate promptly within ~1-2 seconds, NOT wait 30 seconds
      expect(elapsed).toBeLessThan(4000);
    });

    it("should abort runCommandTool immediately on signal without hanging", async () => {
      const controller = new AbortController();

      setTimeout(() => {
        controller.abort();
      }, 100);

      const start = Date.now();
      await expect(
        runCommandTool.execute(
          { command: "node -e \"setTimeout(() => {}, 30000)\"" },
          process.cwd(),
          controller.signal
        )
      ).rejects.toThrow("AbortError");

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(4000);
    });
  });
});
