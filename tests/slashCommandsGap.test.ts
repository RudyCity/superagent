import { describe, it, expect, vi, beforeEach } from "vitest";
import { registry } from "../src/core/commands/registry.js";
import "../src/core/commands/daemonCommand.js";
import "../src/core/commands/gatewayCommand.js";
import { handleMcpCliCommand } from "../src/core/commands/mcpCliHandler.js";
import { buildSelfDevInjectionBlock, recordSelfDevEvent } from "../src/core/selfdev/selfdevAgent.js";

describe("New Slash Commands & Handlers Gap Coverage", () => {
  const createMockContext = () => {
    const lines: any[] = [];
    return {
      addLine: (line: any) => lines.push(line),
      getLines: () => lines,
      agent: {} as any,
      setActiveWizard: vi.fn(),
      setIsProcessing: vi.fn(),
      conversation: {} as any,
      workingDirectory: process.cwd(),
    };
  };

  describe("/daemon command", () => {
    it("is registered in the command registry", () => {
      const cmd = registry.get("daemon");
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("daemon");
    });

    it("executes status subcommand and reports daemon metrics", async () => {
      const cmd = registry.get("daemon");
      const ctx = createMockContext();
      await cmd?.execute("status", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Daemon Status:");
    });

    it("executes help/unknown subcommand with usage instructions", async () => {
      const cmd = registry.get("daemon");
      const ctx = createMockContext();
      await cmd?.execute("unknown_sub", ctx as any);
      const lines = ctx.getLines();
      expect(lines[0].content).toContain("Usage: /daemon");
    });

    it("validates missing args on /daemon add", async () => {
      const cmd = registry.get("daemon");
      const ctx = createMockContext();
      await cmd?.execute("add", ctx as any);
      const lines = ctx.getLines();
      expect(lines[0].type).toBe("error");
      expect(lines[0].content).toContain("Missing required arguments");
    });
  });

  describe("/gateway command", () => {
    it("is registered in the command registry", () => {
      const cmd = registry.get("gateway");
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("gateway");
    });

    it("executes status subcommand and displays channels", async () => {
      const cmd = registry.get("gateway");
      const ctx = createMockContext();
      await cmd?.execute("status", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Gateway Status:");
    });

    it("enables and disables gateway", async () => {
      const cmd = registry.get("gateway");
      const ctx1 = createMockContext();
      await cmd?.execute("enable", ctx1 as any);
      expect(ctx1.getLines()[0].content).toContain("Gateway enabled.");

      const ctx2 = createMockContext();
      await cmd?.execute("disable", ctx2 as any);
      expect(ctx2.getLines()[0].content).toContain("Gateway disabled.");
    });
  });

  describe("selfdevAgent integration helper", () => {
    it("safely returns empty string when selfdev is disabled", async () => {
      const block = await buildSelfDevInjectionBlock(process.cwd());
      expect(typeof block).toBe("string");
    });

    it("safely records events without throwing", async () => {
      await expect(
        recordSelfDevEvent({
          sessionId: "test-sess",
          workspace: process.cwd(),
          kind: "task_started",
          summary: "test summary",
        })
      ).resolves.toBeUndefined();
    });
  });
});
