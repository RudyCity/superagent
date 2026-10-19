import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import {
  findTunnelClientBinary,
  getTunnelClientInstallGuide,
  resolveOpenAiControlPlaneKey,
  isValidTunnelId,
  generateResponsesApiSnippet,
  generateChatGptInstructions,
  generateCodexVerificationPrompt,
  startOpenAiTunnel,
  stopOpenAiTunnel,
  getOpenAiTunnelStatus,
  listActiveOpenAiTunnels,
  runTunnelClientDoctor,
} from "../src/core/mcp/openaiTunnelClient.js";

describe("OpenAI Secure MCP Tunnel Client", () => {
  let tempHome: string;
  let homedirSpy: { mockRestore(): void };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openai-tunnel-test-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
  });

  afterEach(() => {
    homedirSpy?.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("Validation & Resolution", () => {
    it("validates tunnel ID formats", () => {
      expect(isValidTunnelId("tunnel_0123456789abcdef0123456789abcdef")).toBe(true);
      expect(isValidTunnelId("tunnel-test-1234")).toBe(true);
      expect(isValidTunnelId("")).toBe(false);
      expect(isValidTunnelId("short")).toBe(false);
      expect(isValidTunnelId("bad ID with spaces")).toBe(false);
    });

    it("resolves explicit API key first", () => {
      const key = resolveOpenAiControlPlaneKey("sk-explicit-test-key");
      expect(key).toBe("sk-explicit-test-key");
    });

    it("resolves API key from CONTROL_PLANE_API_KEY environment variable", () => {
      const orig = process.env.CONTROL_PLANE_API_KEY;
      try {
        process.env.CONTROL_PLANE_API_KEY = "sk-control-plane-env-key";
        expect(resolveOpenAiControlPlaneKey()).toBe("sk-control-plane-env-key");
      } finally {
        if (orig !== undefined) process.env.CONTROL_PLANE_API_KEY = orig;
        else delete process.env.CONTROL_PLANE_API_KEY;
      }
    });

    it("finds binary from custom path if file exists", () => {
      const fakeBin = path.join(tempHome, "fake-tunnel-client.exe");
      fs.writeFileSync(fakeBin, "echo fake binary", "utf-8");
      expect(findTunnelClientBinary(fakeBin)).toBe(fakeBin);
    });

    it("finds binary in ~/.superagent-r/bin/", () => {
      const binDir = path.join(tempHome, ".superagent-r", "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const binName = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
      const binPath = path.join(binDir, binName);
      fs.writeFileSync(binPath, "echo test", "utf-8");

      expect(findTunnelClientBinary()).toBe(binPath);
    });

    it("returns null and provides comprehensive install guide when binary is missing", () => {
      const guide = getTunnelClientInstallGuide();
      expect(guide).toContain("OpenAI Secure MCP Tunnel Client (tunnel-client) is required");
      expect(guide).toContain("https://github.com/openai/tunnel-client/releases/latest");
      expect(guide).toContain("https://platform.openai.com/settings/organization/tunnels");
    });
  });

  describe("Snippet Generators", () => {
    it("generates correct Responses API curl snippet with tunnel_id", () => {
      const snippet = generateResponsesApiSnippet("tunnel_1234567890abcdef", "gpt-4o");
      expect(snippet).toContain("https://api.openai.com/v1/responses");
      expect(snippet).toContain("tunnel_1234567890abcdef");
      expect(snippet).toContain("superagent_mcp");
      expect(snippet).toContain("gpt-4o");
    });

    it("generates clear step-by-step instructions for ChatGPT", () => {
      const steps = generateChatGptInstructions("tunnel_abcdef123456");
      const fullText = steps.join("\n");
      expect(fullText).toContain("ChatGPT Custom MCP Server Setup:");
      expect(fullText).toContain("Tunnel");
      expect(fullText).toContain("tunnel_abcdef123456");
    });

    it("generates Codex verification prompt", () => {
      const prompt = generateCodexVerificationPrompt("tunnel_abcdef123456", "test-profile");
      expect(prompt).toContain("tunnel_abcdef123456");
      expect(prompt).toContain("test-profile");
      expect(prompt).toContain("tunnel-client doctor");
    });
  });

  describe("Lifecycle & Supervision", () => {
    it("throws helpful error if starting without valid tunnel ID", async () => {
      await expect(
        startOpenAiTunnel({
          tunnelId: "invalid",
          mcpPort: 19227,
        })
      ).rejects.toThrow("Invalid tunnel ID");
    });

    it("throws install guide error if binary is missing", async () => {
      await expect(
        startOpenAiTunnel({
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
          mcpPort: 19227,
          apiKey: "sk-test",
          binaryPath: path.join(tempHome, "nonexistent-binary.exe"),
        })
      ).rejects.toThrow("OpenAI Secure MCP Tunnel Client (tunnel-client) is required");
    });

    it("returns false from doctor check when binary is missing", async () => {
      const doc = await runTunnelClientDoctor({
        binaryPath: path.join(tempHome, "nonexistent-binary.exe"),
      });
      expect(doc.success).toBe(false);
      expect(doc.output).toContain("OpenAI Secure MCP Tunnel Client (tunnel-client) is required");
    });

    it("reads and lists active tunnels from state files", async () => {
      const stateDir = path.join(tempHome, ".superagent-r");
      fs.mkdirSync(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, "openai-tunnel-19227.json");
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          isRunning: true,
          pid: process.pid,
          tunnelId: "tunnel_test_1234567890",
          mcpPort: 19227,
          localUrl: "http://127.0.0.1:19227/mcp",
          adminUrl: "http://127.0.0.1:20227/ui",
          healthy: true,
          ready: true,
          startedAt: Date.now() - 5000,
        }),
        "utf-8"
      );

      const status = getOpenAiTunnelStatus(19227);
      expect(status.isRunning).toBe(true);
      expect(status.tunnelId).toBe("tunnel_test_1234567890");
      expect(status.adminUrl).toBe("http://127.0.0.1:20227/ui");

      const all = listActiveOpenAiTunnels();
      expect(all.length).toBe(1);
      expect(all[0].mcpPort).toBe(19227);

      // Stop tunnel removes state
      await stopOpenAiTunnel(19227);
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(getOpenAiTunnelStatus(19227).isRunning).toBe(false);
    });
  });
});
