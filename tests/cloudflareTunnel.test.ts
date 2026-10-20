import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
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

const tunnelFixtureChildren: ChildProcess[] = [];

async function spawnTunnelFixture(port: number): Promise<number> {
  const target = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    "-e",
    `const identity = ${JSON.stringify(`cloudflared tunnel --url ${target}`)}; setInterval(() => {}, 1000);`,
  ], { stdio: "ignore", windowsHide: true });
  tunnelFixtureChildren.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => setTimeout(resolve, 75));
    child.once("error", reject);
  });
  if (!child.pid) throw new Error(`Failed to start tunnel fixture for port ${port}`);
  return child.pid;
}

describe("Cloudflare Quick Ephemeral Tunnel Suite", () => {
  let tmpDir: string;
  let homedirSpy: { mockRestore(): void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tunnel-test-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    clearTunnelState("all");
  });

  afterEach(() => {
    try {
      clearTunnelState("all");
    } catch {}
    try {
      homedirSpy?.mockRestore?.();
    } catch {}
    for (const child of tunnelFixtureChildren.splice(0)) {
      try { child.kill(); } catch {}
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
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
    it("stopping Muse tunnel does not stop an independent MCP-only server", async () => {
      const { getMcpStateFile } = await import("../src/core/mcp/mcpTunnel.js");
      const mcpPort = 9227;
      const mcpStateFile = getMcpStateFile(mcpPort);
      fs.writeFileSync(mcpStateFile, JSON.stringify({
        port: mcpPort,
        pid: process.pid,
        publicUrl: "https://mcp-only.trycloudflare.com/mcp",
        localUrl: `http://127.0.0.1:${mcpPort}/mcp`,
        toolMode: "safe",
        startedAt: Date.now(),
        workspace: process.cwd(),
        authMode: "oauth",
      }), "utf-8");
      saveTunnelState({
        pid: await spawnTunnelFixture(9225),
        port: 9225,
        serviceKind: "muse-websocket",
        publicUrl: "https://muse-only.trycloudflare.com",
        wssUrl: "wss://muse-only.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        startedAt: Date.now(),
      }, 9225);

      try {
        const lines: any[] = [];
        await museCommand.execute("tunnel stop", {
          addLine: (line) => lines.push(line),
          exit: () => {},
        } as any);
        expect(fs.existsSync(mcpStateFile), `Command output: ${lines.map((line) => line.content).join(" | ")}; file: ${mcpStateFile}`).toBe(true);
      } finally {
        try { fs.unlinkSync(mcpStateFile); } catch {}
      }
    });
    it("legacy MCP flags are rejected by Muse without changing Muse config", async () => {
      const { loadRemoteAgentConfig } = await import("../src/core/remoteAgent/config.js");
      const before = loadRemoteAgentConfig();
      const lines: any[] = [];
      await museCommand.execute("tunnel start --mcp --mcp-auth invalid", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);
      const after = loadRemoteAgentConfig();

      expect(after.wsToken).toBe(before.wsToken);
      expect(after.transport).toBe(before.transport);
      expect(lines.some((line) => String(line.content).includes("Use /mcp tunnel"))).toBe(true);
    });

    it("MCP-only CLI command does not generate a Muse token or change transport", async () => {
      const { loadRemoteAgentConfig } = await import("../src/core/remoteAgent/config.js");
      const { handleMuseCliCommand } = await import("../src/core/remoteAgent/museCli.js");
      const before = loadRemoteAgentConfig();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await handleMuseCliCommand(["tunnel", "start", "--mcp", "--mcp-auth", "invalid"]);
      } finally {
        errorSpy.mockRestore();
      }
      const after = loadRemoteAgentConfig();

      expect(after.wsToken).toBe(before.wsToken);
      expect(after.transport).toBe(before.transport);
    });

    it("should return Muse WebSocket tunnel status via /muse tunnel status", async () => {
      const lines: any[] = [];
      await museCommand.execute("tunnel status", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Muse WebSocket Tunnel Status: INACTIVE");
    });

    it("should report when stopping an inactive tunnel via /muse tunnel stop", async () => {
      const lines: any[] = [];
      await museCommand.execute("tunnel stop", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("No owned Muse tunnel is currently running");
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

    it("should show separate Muse, MCP, Telegram, and REST/SSE domains in main /help", async () => {
      const { helpCommand } = await import("../src/core/commands/coreCommands.js");
      const lines: any[] = [];
      await helpCommand.execute("", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const helpText = String(lines[0].content);
      expect(helpText).toContain("/muse tunnel");
      expect(helpText).toContain("/mcp");
      expect(helpText).toContain("/telegram");
      expect(helpText).toContain("/server tunnel");
      expect(helpText).toContain("Deprecated Muse-only alias");
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
        pid: await spawnTunnelFixture(9225),
        serviceKind: "muse-websocket",
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
      const text = lines.map((line) => String(line.content)).join("\n");
      expect(text).toContain("Prompt for Muse");
      expect(text).toContain("wss://test.trycloudflare.com/muse");

      clearTunnelState();
    });

    it("should output ready-to-use prompt when tunnel is already active via superagent muse tunnel start", async () => {
      const { saveTunnelState, clearTunnelState } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      saveTunnelState({
        pid: await spawnTunnelFixture(9225),
        serviceKind: "muse-websocket",
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
        pid: await spawnTunnelFixture(9225),
        serviceKind: "muse-websocket" as const,
        publicUrl: "https://project-a.trycloudflare.com",
        wssUrl: "wss://project-a.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now(),
      };

      const tunnelB = {
        pid: await spawnTunnelFixture(9226),
        serviceKind: "muse-websocket" as const,
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
        pid: await spawnTunnelFixture(9225),
        serviceKind: "muse-websocket" as const,
        publicUrl: "https://site-1.trycloudflare.com",
        wssUrl: "wss://site-1.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        startedAt: Date.now() - 5000,
      };

      const tunnel2 = {
        pid: await spawnTunnelFixture(9226),
        serviceKind: "muse-websocket" as const,
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
      expect(stopLines.some((l) => l.content.includes("Muse WebSocket tunnel(s)"))).toBe(true);
      expect(stopLines.some((l) => l.content.includes("MCP and Telegram services were not changed"))).toBe(true);
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
      expect(tunnelSuggestions).toContain("/tunnel guide");

      const tunnelStopSuggestions = getDashboardSuggestions("/tunnel stop ");
      expect(tunnelStopSuggestions).toContain("/tunnel stop all");
      expect(tunnelStopSuggestions).toContain("/tunnel stop --port");

      const tunnelStartSuggestions = getDashboardSuggestions("/tunnel start ");
      expect(tunnelStartSuggestions).toContain("/tunnel start --port");

      const museTunnelStopSuggestions = getDashboardSuggestions("/muse tunnel stop ");
      expect(museTunnelStopSuggestions).toContain("/muse tunnel stop all");
      expect(museTunnelStopSuggestions).toContain("/muse tunnel stop --port");

      const descriptions = getSuggestionDescriptions();
      expect(descriptions["/tunnel list"]).toBeDefined();
      expect(descriptions["/tunnel stop all"]).toBeDefined();
      expect(descriptions["/muse tunnel stop all"]).toBeDefined();
    });

    it("keeps REST/SSE tunnel suggestions under /server instead of Muse aliases", () => {
      const tunnelSuggestions = getDashboardSuggestions("/tunnel ");
      expect(tunnelSuggestions.some((item) => /--https|--mcp|--provider|--tunnel-id/.test(item))).toBe(false);

      const museStartSuggestions = getDashboardSuggestions("/muse tunnel start ");
      expect(museStartSuggestions).toContain("/muse tunnel start");
      expect(museStartSuggestions.some((item) => /--https|--mcp|--provider|--tunnel-id/.test(item))).toBe(false);

      const serverSuggestions = getDashboardSuggestions("/server tunnel");
      expect(serverSuggestions).toContain("/server tunnel start");

      const descriptions = getSuggestionDescriptions();
      expect(descriptions["/tunnel"]).toContain("Deprecated Muse-only alias");
      expect(descriptions["/tunnel start --https"]).toContain("/server tunnel");
      expect(descriptions["/muse tunnel --https"]).toContain("/server tunnel");
    });

    it("suggests MCP tunnel flags only under /mcp tunnel", () => {
      const legacyTunnelSuggestions = getDashboardSuggestions("/tunnel ");
      expect(legacyTunnelSuggestions.some((item) => /--mcp|--provider|--tunnel-id|--mcp-auth/.test(item))).toBe(false);

      const museTunnelSuggestions = getDashboardSuggestions("/muse tunnel ");
      expect(museTunnelSuggestions.some((item) => /--mcp|--provider|--tunnel-id|--mcp-auth|--https/.test(item))).toBe(false);

      const museStartSuggestions = getDashboardSuggestions("/muse tunnel start ");
      expect(museStartSuggestions.some((item) => /--mcp|--provider|--tunnel-id|--mcp-auth|--https/.test(item))).toBe(false);

      const mcpTunnelSuggestions = getDashboardSuggestions("/mcp tunnel");
      expect(mcpTunnelSuggestions).toContain("/mcp tunnel providers");
      expect(mcpTunnelSuggestions).toContain("/mcp tunnel start --provider cloudflare");
      expect(mcpTunnelSuggestions).toContain("/mcp tunnel start --provider openai --tunnel-id");

      const mcpAuthSuggestions = getDashboardSuggestions("/mcp tunnel start --mcp-auth ");
      expect(mcpAuthSuggestions).toContain("/mcp tunnel start --mcp-auth oauth");
      expect(mcpAuthSuggestions).toContain("/mcp tunnel start --mcp-auth static-bearer");

      const descriptions = getSuggestionDescriptions();
      expect(descriptions["/muse tunnel"]).not.toContain("--mcp");
      expect(descriptions["/muse tunnel --mcp"]).toContain("/mcp tunnel");
      expect(descriptions["/tunnel"]).toContain("Deprecated Muse-only alias");
      expect(descriptions["/mcp tunnel providers"]).toBeDefined();
    });

    it("should permit trycloudflare.com and localhost origins in resolveCorsOrigin for HTTPS tunnel", async () => {
      const { resolveCorsOrigin } = await import("../src/core/utils/serverSecurity.js");
      expect(resolveCorsOrigin("https://random-subdomain.trycloudflare.com")).toBe("https://random-subdomain.trycloudflare.com");
      expect(resolveCorsOrigin("http://localhost:7888")).toBe("http://localhost:7888");
      expect(resolveCorsOrigin("http://127.0.0.1:7888")).toBe("http://127.0.0.1:7888");
      expect(resolveCorsOrigin("https://evil-hacker.com")).toBeUndefined();
    });

    it("redirects REST/SSE exposure from /muse tunnel to the server domain", async () => {
      const { saveTunnelState, clearTunnelState } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      saveTunnelState({
        pid: await spawnTunnelFixture(7888),
        serviceKind: "superagent-http",
        publicUrl: "https://my-https-agent.trycloudflare.com",
        localUrl: "http://127.0.0.1:7888",
        port: 7888,
        startedAt: Date.now() - 5000,
      }, 7888);

      const lines: any[] = [];
      await museCommand.execute("tunnel start --https", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      const text = lines.map((l) => l.content).join("\n");
      expect(text).toContain("/server tunnel start");
      expect(text).not.toContain("curl -H");

      clearTunnelState(7888);
    });

    it("manages REST/SSE tunnel status and stop via /server tunnel", async () => {
      const { saveTunnelState, clearTunnelState, cloudflareTunnel } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const { serverCommand } = await import("../src/core/commands/serverCommand.js");

      saveTunnelState({
        pid: await spawnTunnelFixture(7888),
        serviceKind: "superagent-http",
        publicUrl: "https://my-status-tunnel.trycloudflare.com",
        localUrl: "http://127.0.0.1:7888",
        port: 7888,
        startedAt: Date.now() - 3000,
      }, 7888);

      const statusLines: any[] = [];
      await serverCommand.execute("tunnel status", {
        addLine: (line) => statusLines.push(line),
        exit: () => {},
      } as any);

      const statusText = statusLines.map((l) => l.content).join("\n");
      expect(statusText).toContain("ACTIVE");
      expect(statusText).toContain("https://my-status-tunnel.trycloudflare.com");

      const stopSpy = vi.spyOn(cloudflareTunnel, "stopQuickTunnel").mockResolvedValue(true);
      const stopLines: any[] = [];
      await serverCommand.execute("tunnel stop", {
        addLine: (line) => stopLines.push(line),
        exit: () => {},
      } as any);

      expect(stopSpy).toHaveBeenCalledWith(7888, "superagent-http");
      stopSpy.mockRestore();
      clearTunnelState(7888);
    });

    it("redirects legacy Muse CLI REST/SSE flags to the dedicated server tunnel command", async () => {
      const { saveTunnelState, clearTunnelState } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const { handleMuseCliCommand } = await import("../src/core/remoteAgent/museCli.js");

      saveTunnelState({
        pid: await spawnTunnelFixture(7888),
        serviceKind: "superagent-http",
        publicUrl: "https://cli-test-https.trycloudflare.com",
        localUrl: "http://127.0.0.1:7888",
        port: 7888,
        startedAt: Date.now() - 4000,
      }, 7888);

      const logs: string[] = [];
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      console.error = (...args: any[]) => logs.push(args.join(" "));

      try {
        await handleMuseCliCommand(["tunnel", "status", "--https"]);
      } finally {
        console.log = origLog;
        console.error = origError;
        clearTunnelState(7888);
      }

      const logText = logs.join("\n");
      expect(logText).toContain("/server tunnel status");
      expect(logText).not.toContain("https://cli-test-https.trycloudflare.com");
    });

    it("does not report REST/SSE tunnel state as Muse watch state", async () => {
      const { saveTunnelState, clearTunnelState } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const { museCommand } = await import("../src/core/commands/museCommand.js");

      saveTunnelState({
        pid: await spawnTunnelFixture(7888),
        serviceKind: "superagent-http",
        publicUrl: "https://watch-https-test.trycloudflare.com",
        localUrl: "http://127.0.0.1:7888",
        port: 7888,
        startedAt: Date.now() - 2000,
      }, 7888);

      const lines: any[] = [];
      await museCommand.execute("watch status", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      const text = lines.map((l) => l.content).join("\n");
      expect(text).toContain("INACTIVE");
      expect(text).not.toContain("https://watch-https-test.trycloudflare.com");
      expect(text).not.toContain("Muse Watch Mode: ACTIVE");

      clearTunnelState(7888);
    });

    it("does not suggest REST/SSE options in Muse watch and does not stop server tunnels", async () => {
      const { saveTunnelState, clearTunnelState, cloudflareTunnel, getTunnelStatus } = await import("../src/core/remoteAgent/cloudflareTunnel.js");
      const { museCommand } = await import("../src/core/commands/museCommand.js");

      const watchSuggestions = getDashboardSuggestions("/muse watch ");
      expect(watchSuggestions).not.toContain("/muse watch --https");
      expect(watchSuggestions).not.toContain("/muse watch --ws --tg-fallback");
      expect(getSuggestionDescriptions()["/muse watch --https"]).toContain("/server tunnel");

      saveTunnelState({
        pid: await spawnTunnelFixture(7888),
        serviceKind: "superagent-http",
        publicUrl: "https://watch-stop-test.trycloudflare.com",
        localUrl: "http://127.0.0.1:7888",
        port: 7888,
        startedAt: Date.now() - 1000,
      }, 7888);

      const stopSpy = vi.spyOn(cloudflareTunnel, "stopQuickTunnel").mockResolvedValue(true);
      const lines: any[] = [];
      await museCommand.execute("watch stop", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(stopSpy).not.toHaveBeenCalled();
      expect(getTunnelStatus(7888).isRunning).toBe(true);
      expect(lines.some((l) => l.content.includes("REST/SSE services were not changed"))).toBe(true);

      stopSpy.mockRestore();
      clearTunnelState(7888);
    });
  });

  describe("Multi-Project Multi-Port Tunnel Isolation", () => {
    const wsA = path.join(os.tmpdir(), "project-alpha");
    const wsB = path.join(os.tmpdir(), "project-beta");

    afterEach(() => {
      clearTunnelState(9225);
      clearTunnelState(9226);
      clearTunnelState(7888);
      clearTunnelState(7889);
    });

    it("should store and retrieve isolated state for distinct projects on distinct ports", () => {
      const metaA = {
        pid: process.pid,
        publicUrl: "https://project-a.trycloudflare.com",
        wssUrl: "wss://project-a.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        workspace: wsA,
        workspaces: [wsA],
        startedAt: Date.now() - 5000,
      };

      const metaB = {
        pid: process.pid,
        publicUrl: "https://project-b.trycloudflare.com",
        wssUrl: "wss://project-b.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9226",
        port: 9226,
        workspace: wsB,
        workspaces: [wsB],
        startedAt: Date.now() - 3000,
      };

      saveTunnelState(metaA, 9225);
      saveTunnelState(metaB, 9226);

      // Lookup by port
      const retrievedA = readTunnelState(9225);
      const retrievedB = readTunnelState(9226);

      expect(retrievedA).toBeDefined();
      expect(retrievedA?.port).toBe(9225);
      expect(retrievedA?.workspace).toBe(wsA);
      expect(retrievedA?.publicUrl).toBe("https://project-a.trycloudflare.com");

      expect(retrievedB).toBeDefined();
      expect(retrievedB?.port).toBe(9226);
      expect(retrievedB?.workspace).toBe(wsB);
      expect(retrievedB?.publicUrl).toBe("https://project-b.trycloudflare.com");

      // Lookup by workspace path
      const lookupWsA = readTunnelState(wsA);
      const lookupWsB = readTunnelState(wsB);

      expect(lookupWsA).toBeDefined();
      expect(lookupWsA?.port).toBe(9225);
      expect(lookupWsB).toBeDefined();
      expect(lookupWsB?.port).toBe(9226);
    });

    it("should clear tunnel state for only the specified port without affecting other projects", () => {
      const metaA = {
        pid: process.pid,
        publicUrl: "https://project-a.trycloudflare.com",
        wssUrl: "wss://project-a.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9225",
        port: 9225,
        workspace: wsA,
        startedAt: Date.now(),
      };

      const metaB = {
        pid: process.pid,
        publicUrl: "https://project-b.trycloudflare.com",
        wssUrl: "wss://project-b.trycloudflare.com/muse",
        localUrl: "http://127.0.0.1:9226",
        port: 9226,
        workspace: wsB,
        startedAt: Date.now(),
      };

      saveTunnelState(metaA, 9225);
      saveTunnelState(metaB, 9226);

      // Clear only port 9225
      clearTunnelState(9225);

      expect(readTunnelState(9225)).toBeNull();
      const preservedB = readTunnelState(9226);
      expect(preservedB).toBeDefined();
      expect(preservedB?.port).toBe(9226);
      expect(preservedB?.publicUrl).toBe("https://project-b.trycloudflare.com");
    });

    it("should format active tunnels displaying workspaces for multiple concurrent projects", async () => {
      const { formatActiveTunnels } = await import("../src/core/remoteAgent/cloudflareTunnel.js");

      const activeList = [
        {
          port: 9225,
          pid: process.pid,
          publicUrl: "https://alpha.trycloudflare.com",
          wssUrl: "wss://alpha.trycloudflare.com/muse",
          localUrl: "http://127.0.0.1:9225",
          workspace: wsA,
          startedAt: Date.now(),
          uptimeSeconds: 120,
        },
        {
          port: 9226,
          pid: process.pid,
          publicUrl: "https://beta.trycloudflare.com",
          wssUrl: "wss://beta.trycloudflare.com/muse",
          localUrl: "http://127.0.0.1:9226",
          workspace: wsB,
          startedAt: Date.now(),
          uptimeSeconds: 60,
        },
      ];

      const formatted = formatActiveTunnels(activeList);
      expect(formatted).toContain("Active Cloudflare Quick Tunnels (2):");
      expect(formatted).toContain("Port 9225");
      expect(formatted).toContain("Port 9226");
      expect(formatted).toContain(wsA);
      expect(formatted).toContain(wsB);
    });

    it("should isolate server tokens across multiple server ports", async () => {
      const { getServerAuthToken } = await import("../src/core/utils/serverSecurity.js");
      const dir = path.join(os.homedir(), ".superagent-r");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const file7888 = path.join(dir, "server-info-7888.json");
      const file7889 = path.join(dir, "server-info-7889.json");

      fs.writeFileSync(file7888, JSON.stringify({ port: 7888, authToken: "token-7888", pid: process.pid }), "utf-8");
      fs.writeFileSync(file7889, JSON.stringify({ port: 7889, authToken: "token-7889", pid: process.pid }), "utf-8");

      try {
        const tokenA = getServerAuthToken(7888);
        const tokenB = getServerAuthToken(7889);

        expect(tokenA).toBe("token-7888");
        expect(tokenB).toBe("token-7889");
      } finally {
        try { fs.unlinkSync(file7888); } catch {}
        try { fs.unlinkSync(file7889); } catch {}
      }
    });

    it("should manage separate Muse watchers per port without terminating each other", async () => {
      const { startMuseWatcher, stopMuseWatcher, isMuseWatcherActive } = await import("../src/core/remoteAgent/museWatcher.js");

      // Mock transport to avoid real network/telegram calls
      const mockTransportA = {
        type: "websocket" as const,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendEnvelope: vi.fn().mockResolvedValue(undefined),
        getTransportInfo: vi.fn().mockReturnValue({ type: "websocket", details: "Mock A" }),
      };

      const mockTransportB = {
        type: "websocket" as const,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendEnvelope: vi.fn().mockResolvedValue(undefined),
        getTransportInfo: vi.fn().mockReturnValue({ type: "websocket", details: "Mock B" }),
      };

      const watcherA = await startMuseWatcher({
        wsPort: 9225,
        transport: mockTransportA as any,
        announce: false,
        workspace: wsA,
      });

      const watcherB = await startMuseWatcher({
        wsPort: 9226,
        transport: mockTransportB as any,
        announce: false,
        workspace: wsB,
      });

      expect(isMuseWatcherActive(9225)).toBe(true);
      expect(isMuseWatcherActive(9226)).toBe(true);

      // Stopping watcher A on 9225 should NOT stop watcher B on 9226
      await stopMuseWatcher(9225);

      expect(isMuseWatcherActive(9225)).toBe(false);
      expect(isMuseWatcherActive(9226)).toBe(true);

      await stopMuseWatcher(9226);
      expect(isMuseWatcherActive(9226)).toBe(false);
    });
  });

  describe("Comprehensive Muse & Tunnel Subcommands & Help Output Suite", () => {
    it("should display Muse-only commands and direct users to separate domains", async () => {
      const lines: any[] = [];
      await museCommand.execute("", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines[0].content;
      expect(text).toContain("Usage: /muse <task description>");
      expect(text).toContain("/muse status");
      expect(text).toContain("/muse tunnel list");
      expect(text).toContain("/muse tunnel start");
      expect(text).toContain("/muse tunnel stop");
      expect(text).toContain("/muse tunnel stop all");
      expect(text).toContain("/muse tunnel restart");
      expect(text).toContain("/muse tunnel status");
      expect(text).toContain("/muse tunnel prompt");
      expect(text).toContain("/muse watch");
      expect(text).toContain("/muse watch stop");
      expect(text).toContain("/muse watch status");
      expect(text).toContain("/muse doctor");
      expect(text).toContain("/muse connect");
      expect(text).toContain("/muse stop");
      expect(text).toContain("/muse cancel");
      expect(text).toContain("/muse new");
      expect(text).toContain("/muse reset");
      expect(text).toContain("/muse config");
      expect(text).toContain("/telegram help");
      expect(text).toContain("/mcp tunnel providers");
      expect(text).toContain("/server tunnel");
      expect(text).not.toContain("/muse tunnel start --mcp");
    });

    it("should display full subcommands on /muse help and /muse -h", async () => {
      const linesHelp: any[] = [];
      await museCommand.execute("help", {
        addLine: (line) => linesHelp.push(line),
        exit: () => {},
      } as any);

      expect(linesHelp.length).toBeGreaterThan(0);
      expect(linesHelp[0].content).toContain("/muse tunnel");
      expect(linesHelp[0].content).toContain("/muse doctor");

      const linesDashH: any[] = [];
      await museCommand.execute("-h", {
        addLine: (line) => linesDashH.push(line),
        exit: () => {},
      } as any);
      expect(linesDashH.length).toBeGreaterThan(0);
      expect(linesDashH[0].content).toContain("/muse tunnel");
    });

    it("should display Muse-specific WebSocket settings and exclude Telegram credentials", async () => {
      const lines: any[] = [];
      await museCommand.execute("config", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines[0].content;
      ["Muse Configuration:", "transport", "wsPort", "wsHost", "wsToken", "wsMode", "cfAccessClientId", "autoTokenRefresh", "defaultWorkspace"].forEach((k) => expect(text).toContain(k));
      expect(text).toContain("/telegram config");
      expect(text).not.toContain("botToken");
      expect(text).not.toContain("groupId");
      expect(text).not.toContain("museBotId");
    });

    it("should run diagnostic checks on /muse doctor", async () => {
      // This assertion specifically covers the WebSocket adapter; the full
      // suite may otherwise inherit Telegram transport from another fixture.
      const { updateRemoteAgentConfig } = await import("../src/core/remoteAgent/config.js");
      updateRemoteAgentConfig({ transport: "websocket" });
      const lines: any[] = [];
      await museCommand.execute("doctor", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines.map((l) => l.content).join("\n");
      ["Muse Health & Diagnostics (Doctor)", "Cloudflare Binary", "Active Transport"].forEach((k) => expect(text).toContain(k));
    });

    it("should run connectivity check on /muse connect", async () => {
      const lines: any[] = [];
      await museCommand.execute("connect", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines.map((l) => l.content).join("\n");
      expect(text).toContain("[Muse Connect]");
    });

    it("should output connection prompt info on /muse tunnel prompt", async () => {
      // Avoid the first-run token generation log preceding the actual prompt.
      const { updateRemoteAgentConfig } = await import("../src/core/remoteAgent/config.js");
      updateRemoteAgentConfig({ transport: "websocket", wsToken: "synthetic-test-websocket-token" });
      const lines: any[] = [];
      await museCommand.execute("tunnel prompt", {
        addLine: (line) => lines.push(line),
        exit: () => {},
      } as any);

      expect(lines.length).toBeGreaterThan(0);
      const text = lines[0].content;
      expect(text).toContain("No quick tunnel is currently active");
      expect(text).toContain("/muse tunnel start");
    });

    it("should provide suggestions for restart, prompt, doctor, connect", () => {
      const suggestions = getDashboardSuggestions("/muse ");
      ["/muse tunnel restart", "/muse tunnel prompt", "/muse doctor", "/muse connect", "/muse start", "/muse restart"].forEach((s) => expect(suggestions).toContain(s));
      const tunnelSubs = getDashboardSuggestions("/muse tunnel ");
      ["/muse tunnel restart", "/muse tunnel prompt"].forEach((s) => expect(tunnelSubs).toContain(s));
    });
  });
});
