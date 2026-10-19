import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  clearOpenAiMcpTunnelConfigField,
  getOpenAiMcpTunnelConfig,
  getOpenAiMcpTunnelConfigStatus,
  setOpenAiMcpTunnelApiKey,
  setOpenAiMcpTunnelId,
} from "../src/core/mcp/openaiMcpTunnelConfig.js";
import { runOpenAiMcpTunnelConfigCommand } from "../src/core/mcp/openaiMcpTunnelConfigCommand.js";
import { _resetSecretStoreForTests } from "../src/core/config/secretStore.js";
import { resolveOpenAiControlPlaneKey } from "../src/core/mcp/openaiTunnelClient.js";

describe("OpenAI MCP Tunnel configuration", () => {
  let tempConfigDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-openai-mcp-config-"));
    process.env.SUPERAGENT_CONFIG_DIR = tempConfigDir;
    delete process.env.CONTROL_PLANE_API_KEY;
    delete process.env.OPENAI_MCP_TUNNEL_ID;
    delete process.env.CONTROL_PLANE_TUNNEL_ID;
    _resetSecretStoreForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
    _resetSecretStoreForTests();
  });

  it("persists Tunnel ID and encrypts the runtime API key at rest", () => {
    const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
    const apiKey = "runtime-tunnel-key-test-123456789";

    setOpenAiMcpTunnelId(tunnelId);
    setOpenAiMcpTunnelApiKey(apiKey);

    const filePath = path.join(tempConfigDir, "openai-mcp-tunnel.json");
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain(tunnelId);
    expect(raw).not.toContain(apiKey);
    expect(raw).toContain("enc:v1:");
    expect(getOpenAiMcpTunnelConfig()).toEqual({ tunnelId, apiKey });
    expect(resolveOpenAiControlPlaneKey()).toBe(apiKey);
    process.env.CONTROL_PLANE_API_KEY = "runtime-api-key-from-env-123456789";
    expect(resolveOpenAiControlPlaneKey()).toBe("runtime-api-key-from-env-123456789");
    delete process.env.CONTROL_PLANE_API_KEY;
    expect(getOpenAiMcpTunnelConfigStatus()).toMatchObject({
      tunnelId,
      apiKeyConfigured: true,
      apiKeyHint: "••••6789",
    });
  });

  it("validates required values without persisting invalid input", () => {
    expect(() => setOpenAiMcpTunnelId("bad id")).toThrow(/Invalid OpenAI tunnel ID/i);
    expect(() => setOpenAiMcpTunnelApiKey("short")).toThrow(/Invalid OpenAI runtime API key/i);
    expect(fs.existsSync(path.join(tempConfigDir, "openai-mcp-tunnel.json"))).toBe(false);
  });

  it("resolves config subcommands without echoing a key", () => {
    const apiKey = "runtime-tunnel-key-test-123456789";
    const idResult = runOpenAiMcpTunnelConfigCommand(["set-id", "tunnel_test_123456"]);
    const keyResult = runOpenAiMcpTunnelConfigCommand(["set-key", apiKey]);
    const statusResult = runOpenAiMcpTunnelConfigCommand(["status"]);

    expect(idResult.success).toBe(true);
    expect(keyResult.success).toBe(true);
    expect(keyResult.message).not.toContain(apiKey);
    expect(statusResult.success).toBe(true);
    expect(statusResult.message).toContain("tunnel_test_123456");
    expect(statusResult.message).not.toContain(apiKey);
    expect(statusResult.message).toContain("saved encrypted key is configured");
  });

  it("imports the runtime key from environment without echoing it", () => {
    const apiKey = "runtime-api-key-from-env-123456789";
    process.env.CONTROL_PLANE_API_KEY = apiKey;
    const result = runOpenAiMcpTunnelConfigCommand(["set-key-env"]);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain(apiKey);
    expect(getOpenAiMcpTunnelConfig().apiKey).toBe(apiKey);
    const diskContent = fs.readFileSync(path.join(tempConfigDir, "openai-mcp-tunnel.json"), "utf8");
    expect(diskContent).not.toContain(apiKey);
    delete process.env.CONTROL_PLANE_API_KEY;
  });

  it("clears one setting without removing the other setting", () => {
    setOpenAiMcpTunnelId("tunnel_test_123456");
    setOpenAiMcpTunnelApiKey("runtime-tunnel-key-test-123456789");

    clearOpenAiMcpTunnelConfigField("apiKey");
    expect(getOpenAiMcpTunnelConfig()).toEqual({ tunnelId: "tunnel_test_123456" });

    clearOpenAiMcpTunnelConfigField("tunnelId");
    expect(getOpenAiMcpTunnelConfig()).toEqual({});
    expect(fs.existsSync(path.join(tempConfigDir, "openai-mcp-tunnel.json"))).toBe(false);
  });
});
