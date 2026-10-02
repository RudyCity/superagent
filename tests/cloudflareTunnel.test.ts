import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import {
  findCloudflaredBinary,
  saveTunnelState,
  readTunnelState,
  clearTunnelState,
  isProcessRunning,
  getTunnelStatus,
  CloudflareTunnelManager,
} from "../src/core/remoteAgent/cloudflareTunnel.js";
import { handleMuseCliCommand } from "../src/core/remoteAgent/museCli.js";
import { museCommand } from "../src/core/commands/museCommand.js";
import { getDashboardSuggestions, getSuggestionDescriptions } from "../src/utils/dashboardSuggestions.js";

describe("Cloudflare Quick Ephemeral Tunnel Suite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tunnel-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    clearTunnelState();
  });

  describe("Binary Detection & State File Persistence", () => {
    it("should find the cloudflared binary on the host system", async () => {
      const binary = await findCloudflaredBinary();
      expect(binary).toBeDefined();
      expect(typeof binary).toBe("string");
      expect(binary).toMatch(/cloudflared/i);
    });

    it("should persist and read tunnel metadata safely", () => {
      const sampleMeta = {
        pid: process.pid,
        publicUrl: "https://test-subdomain.trycloudflare.com",
        wssUrl: "wss://test-subdomain.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now(),
      };

      saveTunnelState(sampleMeta);
      const read = readTunnelState();
      expect(read).toBeDefined();
      expect(read?.pid).toBe(process.pid);
      expect(read?.publicUrl).toBe(sampleMeta.publicUrl);
      expect(read?.wssUrl).toBe(sampleMeta.wssUrl);

      clearTunnelState();
      expect(readTunnelState()).toBeNull();
    });

    it("should detect whether a process is running by PID", () => {
      expect(isProcessRunning(process.pid)).toBe(true);
      expect(isProcessRunning(999999999)).toBe(false);
      expect(isProcessRunning(0)).toBe(false);
    });

    it("should report inactive tunnel status when no tunnel is active", () => {
      clearTunnelState();
      const status = getTunnelStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe("CLI Subcommand: superagent muse tunnel", () => {
    it("should handle status command when tunnel is inactive", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await handleMuseCliCommand(["tunnel", "status"]);
      expect(logs.some((l) => l.includes("INACTIVE"))).toBe(true);

      spy.mockRestore();
    });

    it("should handle stop command when no tunnel is running", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await handleMuseCliCommand(["tunnel", "stop"]);
      expect(logs.some((l) => l.includes("No quick tunnel is currently running"))).toBe(true);

      spy.mockRestore();
    });

    it("should show subcommands and setup guide for superagent muse tunnel", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await handleMuseCliCommand(["tunnel"]);
      expect(logs.some((l) => l.includes("superagent muse tunnel start"))).toBe(true);
      expect(logs.some((l) => l.includes("superagent muse tunnel stop"))).toBe(true);
      expect(logs.some((l) => l.includes("superagent muse tunnel status"))).toBe(true);

      spy.mockRestore();
    });
  });

  describe("Slash Command: /muse tunnel", () => {
    it("should return tunnel status via /muse tunnel status", async () => {
      const lines: any[] = [];
      await museCommand.execute("tunnel status", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Cloudflare Quick Tunnel Status: INACTIVE");
    });

    it("should report when stopping an inactive tunnel via /muse tunnel stop", async () => {
      const lines: any[] = [];
      await museCommand.execute("tunnel stop", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("No quick tunnel is currently running");
    });

    it("should display subcommands and guide on /muse tunnel", async () => {
      const lines: any[] = [];
      await museCommand.execute("tunnel", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("/muse tunnel start");
      expect(lines[0].content).toContain("/muse tunnel stop");
      expect(lines[0].content).toContain("/muse tunnel status");
      expect(lines[0].content).toContain("/muse watch --tunnel");
    });
  });

  describe("Interactive Autocomplete Suggestions for Tunnels", () => {
    it("should suggest tunnel subcommands", () => {
      const tunnelSuggestions = getDashboardSuggestions("/muse tunnel ");
      expect(tunnelSuggestions).toContain("/muse tunnel start");
      expect(tunnelSuggestions).toContain("/muse tunnel stop");
      expect(tunnelSuggestions).toContain("/muse tunnel status");
      expect(tunnelSuggestions).toContain("/muse tunnel guide");

      const watchSuggestions = getDashboardSuggestions("/muse watch ");
      expect(watchSuggestions).toContain("/muse watch --tunnel");
      expect(watchSuggestions).toContain("/muse watch --ws");

      const descriptions = getSuggestionDescriptions();
      expect(descriptions["/muse tunnel start"]).toBeDefined();
      expect(descriptions["/muse tunnel stop"]).toBeDefined();
      expect(descriptions["/muse watch --tunnel"]).toBeDefined();
    });
  });

  describe("Integration: /muse status and /help reporting", () => {
    it("should include quick tunnel status in /muse status output", async () => {
      const { updateRemoteAgentConfig } = await import("../src/core/remoteAgent/config.js");
      updateRemoteAgentConfig({ transport: "websocket" });

      const lines: any[] = [];
      await museCommand.execute("status", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines[0].content;
      expect(text).toContain("Quick Tunnel");
      expect(text).toContain("/muse tunnel start");
    });

    it("should include quick tunnel status in superagent muse status output", async () => {
      const { updateRemoteAgentConfig } = await import("../src/core/remoteAgent/config.js");
      updateRemoteAgentConfig({ transport: "websocket" });

      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await handleMuseCliCommand(["status"]);
      expect(logs.some((l) => l.includes("Quick Tunnel"))).toBe(true);
      expect(logs.some((l) => l.includes("superagent muse tunnel start"))).toBe(true);

      spy.mockRestore();
    });

    it("should list /muse in main /help output", async () => {
      const { helpCommand } = await import("../src/core/commands/coreCommands.js");
      const lines: any[] = [];
      await helpCommand.execute("", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const helpText = String(lines[0].content);
      expect(helpText).toContain("/muse");
      expect(helpText).toContain("/muse tunnel");
      expect(helpText).toContain("/muse watch");
    });
  });

  describe("Muse Connection Prompt Generation", () => {
    it("should format connection prompt with endpoint and bearer token", async () => {
      const { buildMuseConnectionPrompt } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const prompt = buildMuseConnectionPrompt({
        wssUrl: "wss://test-subdomain.trycloudflare.com/muse",
        token: "sec_token_12345",
      });

      expect(prompt).toContain("Connect to my local Superagent workstation via WebSocket:");
      expect(prompt).toContain("- Endpoint: wss://test-subdomain.trycloudflare.com/muse");
      expect(prompt).toContain("- Bearer Token: sec_token_12345");
      expect(prompt).toContain("Please connect to the WebSocket endpoint");
    });

    it("should format prompt with initial task and workspaces", async () => {
      const { buildMuseConnectionPrompt } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const prompt = buildMuseConnectionPrompt({
        wssUrl: "wss://test-subdomain.trycloudflare.com/muse",
        token: "sec_token_12345",
        workspaces: ["/path/to/my-project"],
        cfClientId: "cf-client-id",
        cfClientSecret: "cf-client-secret",
        task: "Implement OAuth2 login flow",
      });

      expect(prompt).toContain("- Endpoint: wss://test-subdomain.trycloudflare.com/muse");
      expect(prompt).toContain("- CF-Access-Client-Id: cf-client-id");
      expect(prompt).toContain("- CF-Access-Client-Secret: cf-client-secret");
      expect(prompt).toContain("- Watched Projects: my-project");
      expect(prompt).toContain("Task:\nImplement OAuth2 login flow");
      expect(prompt).toContain("execute the task above");
    });

    it("should output ready-to-use prompt when tunnel is already active via /muse tunnel start", async () => {
      const { saveTunnelState, clearTunnelState } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      saveTunnelState({
        pid: process.pid,
        publicUrl: "https://test.trycloudflare.com",
        wssUrl: "wss://test.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now(),
      });

      const lines: any[] = [];
      await museCommand.execute("tunnel start", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines[0].content;
      expect(text).toContain("Prompt for Muse");
      expect(text).toContain("wss://test.trycloudflare.com/muse");

      clearTunnelState();
    });

    it("should output ready-to-use prompt when tunnel is already active via superagent muse tunnel start", async () => {
      const { saveTunnelState, clearTunnelState } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      saveTunnelState({
        pid: process.pid,
        publicUrl: "https://test.trycloudflare.com",
        wssUrl: "wss://test.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now(),
      });

      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await handleMuseCliCommand(["tunnel", "start", "--prompt", "Run database migration"]);
      expect(logs.some((l) => l.includes("Prompt for Muse"))).toBe(true);
      expect(logs.some((l) => l.includes("Run database migration"))).toBe(true);

      spy.mockRestore();
      clearTunnelState();
    });

    it("should isolate multiple tunnels on different ports without state collisions", async () => {
      const {
        saveTunnelState,
        readTunnelState,
        clearTunnelState,
        getTunnelStatus,
      } = await import("../src/core/remoteAgent/cloudflareTunnel.js");

      const tunnelA = {
        pid: process.pid,
        publicUrl: "https://project-a.trycloudflare.com",
        wssUrl: "wss://project-a.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now(),
      };

      const tunnelB = {
        pid: process.pid,
        publicUrl: "https://project-b.trycloudflare.com",
        wssUrl: "wss://project-b.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9226",
        port: 9226,
        startedAt: Date.now(),
      };

      saveTunnelState(tunnelA, 9225);
      saveTunnelState(tunnelB, 9226);

      const statusA = getTunnelStatus(9225);
      const statusB = getTunnelStatus(9226);

      expect(statusA.isRunning).toBe(true);
      expect(statusA.publicUrl).toBe("https://project-a.trycloudflare.com");
      expect(statusA.port).toBe(9225);

      expect(statusB.isRunning).toBe(true);
      expect(statusB.publicUrl).toBe("https://project-b.trycloudflare.com");
      expect(statusB.port).toBe(9226);

      clearTunnelState(9225);
      expect(getTunnelStatus(9225).isRunning).toBe(false);
      expect(getTunnelStatus(9226).isRunning).toBe(true);

      clearTunnelState(9226);
      expect(getTunnelStatus(9226).isRunning).toBe(false);
    });

    it("should list all active tunnels and format them correctly", async () => {
      const {
        saveTunnelState,
        clearTunnelState,
        listActiveTunnels,
        formatActiveTunnels,
        stopAllQuickTunnels,
      } = await import("../src/core/remoteAgent/cloudflareTunnel.js");

      clearTunnelState();
      expect(listActiveTunnels()).toEqual([]);
      expect(formatActiveTunnels([])).toContain("NONE ACTIVE");

      const tunnel1 = {
        pid: process.pid,
        publicUrl: "https://site-1.trycloudflare.com",
        wssUrl: "wss://site-1.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now() - 5000,
      };

      const tunnel2 = {
        pid: process.pid,
        publicUrl: "https://site-2.trycloudflare.com",
        wssUrl: "wss://site-2.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9226",
        port: 9226,
        startedAt: Date.now() - 2000,
      };

      saveTunnelState(tunnel1, 9225);
      saveTunnelState(tunnel2, 9226);

      const active = listActiveTunnels();
      expect(active.length).toBe(2);
      expect(active[0].port).toBe(9225);
      expect(active[1].port).toBe(9226);

      const formatted = formatActiveTunnels(active);
      expect(formatted).toContain("Active Cloudflare Quick Tunnels (2)");
      expect(formatted).toContain("Port 9225");
      expect(formatted).toContain("Port 9226");
      expect(formatted).toContain("https://site-1.trycloudflare.com");
      expect(formatted).toContain("https://site-2.trycloudflare.com");

      // Test CLI listing
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });
      await handleMuseCliCommand(["tunnel", "list"]);
      expect(logs.some((l) => l.includes("Active Cloudflare Quick Tunnels (2)"))).toBe(true);
      expect(logs.some((l) => l.includes("Port 9225"))).toBe(true);
      expect(logs.some((l) => l.includes("Port 9226"))).toBe(true);
      spy.mockRestore();

      // Test slash command /muse tunnel list
      const lines: any[] = [];
      await museCommand.execute("tunnel list", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);
      expect(lines.some((l) => l.content.includes("Active Cloudflare Quick Tunnels (2)"))).toBe(true);

      // Test slash command /tunnel list
      const { tunnelCommand } = await import("../src/core/commands/museCommand.js");
      const tunnelLines: any[] = [];
      await tunnelCommand.execute("list", {
        addLine: (line) => tunnelLines.push(line),
        exit: () => {},
      } as any);
      expect(tunnelLines.some((l) => l.content.includes("Active Cloudflare Quick Tunnels (2)"))).toBe(true);

      // Test stop all with mocked process kill
      const { cloudflareTunnel } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const stopSpy = vi.spyOn(cloudflareTunnel, "stopQuickTunnel").mockImplementation(async (p) => {
        clearTunnelState(typeof p === "number" ? p : undefined);
        return true;
      });

      const stopLines: any[] = [];
      await museCommand.execute("tunnel stop all", {
        addLine: (line) => stopLines.push(line),
        exit: () => {},
      } as any);
      expect(stopLines.some((l) => l.content.includes("Stopped"))).toBe(true);
      stopSpy.mockRestore();

      clearTunnelState();
      expect(listActiveTunnels()).toEqual([]);
    });

    it("should provide suggestions for /muse tunnel list and /tunnel list", () => {
      const suggestions = getDashboardSuggestions("/muse tunnel l");
      expect(suggestions).toContain("/muse tunnel list");

      const tunnelSuggestions = getDashboardSuggestions("/tunnel ");
      expect(tunnelSuggestions).toContain("/tunnel list");
      expect(tunnelSuggestions).toContain("/tunnel status");
      expect(tunnelSuggestions).toContain("/tunnel start");
      expect(tunnelSuggestions).toContain("/tunnel stop");
    });
  });
});

