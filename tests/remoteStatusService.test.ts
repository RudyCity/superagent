import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getRemoteServiceStatus,
  formatRemoteServiceStatus,
  formatDynamicRemoteNotice,
  type RemoteServiceStatusResult,
} from "../src/core/remoteAgent/remoteStatusService.js";
import { getRemoteServiceStatusTool } from "../src/core/tools/remoteServiceTools.js";
import {
  saveTunnelState,
  clearTunnelState,
  type TunnelMetadata,
} from "../src/core/remoteAgent/cloudflareTunnel.js";
import { getMcpStateFile } from "../src/core/mcp/mcpTunnel.js";
import { gatewayManager } from "../src/core/gateway/gatewayManager.js";
import { allTools } from "../src/core/tools/index.js";
import { masterToolset, superagentToolset } from "../src/core/tools/toolsets.js";

describe("Remote Status Service (/muse tunnel, MCP, Telegram)", () => {
  const TEST_TUNNEL_PORT = 9981;
  const TEST_MCP_PORT = 9982;

  beforeEach(() => {
    clearTunnelState(TEST_TUNNEL_PORT);
    const mcpFile = getMcpStateFile(TEST_MCP_PORT);
    if (fs.existsSync(mcpFile)) {
      try {
        fs.unlinkSync(mcpFile);
      } catch {}
    }
  });

  afterEach(() => {
    clearTunnelState(TEST_TUNNEL_PORT);
    const mcpFile = getMcpStateFile(TEST_MCP_PORT);
    if (fs.existsSync(mcpFile)) {
      try {
        fs.unlinkSync(mcpFile);
      } catch {}
    }
  });

  it("should return valid inactive structure when no services are running", async () => {
    const status = await getRemoteServiceStatus("all");
    expect(status).toBeDefined();
    expect(typeof status.timestamp).toBe("number");
    expect(status.tunnel).toBeDefined();
    expect(status.mcp).toBeDefined();
    expect(status.telegram).toBeDefined();
    expect(Array.isArray(status.tunnel.tunnels)).toBe(true);
    expect(Array.isArray(status.mcp.tunnelServers)).toBe(true);
  });

  it("should detect active Cloudflare quick tunnels", async () => {
    const meta: TunnelMetadata = {
      pid: process.pid,
      port: TEST_TUNNEL_PORT,
      publicUrl: "https://test-tunnel-active.trycloudflare.com",
      wssUrl: "wss://test-tunnel-active.trycloudflare.com/muse",
      localUrl: `http://127.0.0.1:${TEST_TUNNEL_PORT}`,
      startedAt: Date.now() - 5000,
      workspace: process.cwd(),
    };
    saveTunnelState(meta, TEST_TUNNEL_PORT);

    const status = await getRemoteServiceStatus("tunnel");
    expect(status.tunnel.active).toBe(true);
    expect(status.tunnel.count).toBeGreaterThanOrEqual(1);
    const found = status.tunnel.tunnels.find((t) => t.port === TEST_TUNNEL_PORT);
    expect(found).toBeDefined();
    expect(found?.publicUrl).toBe("https://test-tunnel-active.trycloudflare.com");
    expect(found?.wssUrl).toBe("wss://test-tunnel-active.trycloudflare.com/muse");
  });

  it("should detect active MCP tunnel servers from disk state", async () => {
    const mcpState = {
      port: TEST_MCP_PORT,
      pid: process.pid,
      publicUrl: "https://test-mcp-active.trycloudflare.com/mcp",
      localUrl: `http://127.0.0.1:${TEST_MCP_PORT}/mcp`,
      toolMode: "safe",
      startedAt: Date.now() - 10000,
      workspace: process.cwd(),
      authMode: "static-bearer",
    };
    fs.writeFileSync(getMcpStateFile(TEST_MCP_PORT), JSON.stringify(mcpState, null, 2), "utf-8");

    const status = await getRemoteServiceStatus("mcp");
    expect(status.mcp.active).toBe(true);
    expect(status.mcp.tunnelServerCount).toBeGreaterThanOrEqual(1);
    const found = status.mcp.tunnelServers.find((s) => s.port === TEST_MCP_PORT);
    expect(found).toBeDefined();
    expect(found?.publicUrl).toBe("https://test-mcp-active.trycloudflare.com/mcp");
    expect(found?.toolMode).toBe("safe");
  });

  it("should format detailed and filtered output correctly", async () => {
    const meta: TunnelMetadata = {
      pid: process.pid,
      port: TEST_TUNNEL_PORT,
      publicUrl: "https://format-test.trycloudflare.com",
      wssUrl: "wss://format-test.trycloudflare.com/muse",
      localUrl: `http://127.0.0.1:${TEST_TUNNEL_PORT}`,
      startedAt: Date.now() - 2000,
      workspace: process.cwd(),
    };
    saveTunnelState(meta, TEST_TUNNEL_PORT);

    const status = await getRemoteServiceStatus("all");
    const formatted = formatRemoteServiceStatus(status, "all", true);

    expect(formatted).toContain("Remote Services Status Overview:");
    expect(formatted).toContain("[1] Muse Tunnel (/muse tunnel):");
    expect(formatted).toContain("https://format-test.trycloudflare.com");
    expect(formatted).toContain("[2] MCP (Model Context Protocol):");
    expect(formatted).toContain("[3] Telegram:");

    const tunnelOnly = formatRemoteServiceStatus(status, "tunnel", false);
    expect(tunnelOnly).toContain("[1] Muse Tunnel (/muse tunnel):");
    expect(tunnelOnly).not.toContain("[2] MCP (Model Context Protocol):");
    expect(tunnelOnly).not.toContain("[3] Telegram:");
  });

  it("should format dynamic prompt notice only when services are active", () => {
    const inactiveStatus: RemoteServiceStatusResult = {
      timestamp: Date.now(),
      anyActive: false,
      tunnel: { active: false, count: 0, tunnels: [], watcherActive: false },
      mcp: { active: false, tunnelServerCount: 0, tunnelServers: [], clientServerCount: 0, clientServers: [] },
      telegram: {
        active: false,
        museWatcherActive: false,
        telegramFallbackActive: false,
        gatewayEnabled: false,
        gatewayConfigured: false,
        gatewayStats: { messagesReceived: 0, messagesSent: 0, errors: 0 },
      },
    };
    expect(formatDynamicRemoteNotice(inactiveStatus)).toBeNull();

    const activeStatus: RemoteServiceStatusResult = {
      ...inactiveStatus,
      anyActive: true,
      tunnel: {
        active: true,
        count: 1,
        tunnels: [
          {
            port: 9225,
            pid: 1234,
            publicUrl: "https://active-notice.trycloudflare.com",
            wssUrl: "wss://active-notice.trycloudflare.com/muse",
            localUrl: "http://127.0.0.1:9225",
            uptimeSeconds: 60,
          },
        ],
        watcherActive: true,
        museConnected: true,
      },
    };
    const notice = formatDynamicRemoteNotice(activeStatus);
    expect(notice).not.toBeNull();
    expect(notice).toContain("# ACTIVE REMOTE SERVICES (TUNNELS / MCP / TELEGRAM)");
    expect(notice).toContain("Muse Tunnel: ACTIVE");
    expect(notice).toContain("https://active-notice.trycloudflare.com");
    expect(notice).toContain("get_remote_service_status");
  });

  it("should execute get_remote_service_status tool successfully", async () => {
    const res = await getRemoteServiceStatusTool.execute({ service: "all", detailed: true }, process.cwd());
    expect(typeof res).toBe("string");
    expect(res).toContain("Remote Services Status Overview:");
    expect(res).toContain("[1] Muse Tunnel (/muse tunnel):");
    expect(res).toContain("[2] MCP (Model Context Protocol):");
    expect(res).toContain("[3] Telegram:");
  });

  it("should be included in master, superagent, and allTools toolsets", () => {
    const foundMaster = masterToolset.find((t) => t.name === "get_remote_service_status");
    expect(foundMaster).toBeDefined();

    const foundSuper = superagentToolset.find((t) => t.name === "get_remote_service_status");
    expect(foundSuper).toBeDefined();

    const foundAll = allTools.find((t) => t.name === "get_remote_service_status");
    expect(foundAll).toBeDefined();
  });
});
