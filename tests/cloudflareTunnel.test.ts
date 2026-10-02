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
});
