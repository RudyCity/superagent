import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandContext } from "../src/core/commands/types.js";
import { statusCommand, stopAllManagedServices } from "../src/core/commands/serviceStatusCommand.js";

const mocks = vi.hoisted(() => ({
  loadRemoteAgentConfig: vi.fn(),
  loadModelConfig: vi.fn(),
  connectedServers: new Map<string, any>(),
  getMeInfo: vi.fn(),
  isMuseWatcherActive: vi.fn(),
  stopAllMuseWatchers: vi.fn(),
  closeMcpServers: vi.fn(),
  listActiveMcpServers: vi.fn(),
  stopMcpTunnel: vi.fn(),
  listActiveTunnels: vi.fn(),
  stopQuickTunnel: vi.fn(),
  stopOwnedMuseTunnel: vi.fn(),
  readManagedMcpTunnelLease: vi.fn(),
  stopManagedMcpTunnelOwner: vi.fn(),
}));

vi.mock("../src/core/remoteAgent/config.js", () => ({
  loadRemoteAgentConfig: mocks.loadRemoteAgentConfig,
}));
vi.mock("../src/core/remoteAgent/museClient.js", () => ({
  MuseClient: class {
    getMeInfo() {
      return mocks.getMeInfo();
    }
  },
}));
vi.mock("../src/core/remoteAgent/museWatcher.js", () => ({
  isMuseWatcherActive: mocks.isMuseWatcherActive,
  TELEGRAM_FALLBACK_KEY: -1,
  stopAllMuseWatchers: mocks.stopAllMuseWatchers,
}));
vi.mock("../src/core/config/jsonConfig.js", () => ({
  loadModelConfig: mocks.loadModelConfig,
}));
vi.mock("../src/core/mcp/McpManager.js", () => ({
  connectedServers: mocks.connectedServers,
  closeMcpServers: mocks.closeMcpServers,
}));
vi.mock("../src/core/mcp/mcpTunnel.js", () => ({
  listActiveMcpServers: mocks.listActiveMcpServers,
  stopMcpTunnel: mocks.stopMcpTunnel,
}));
vi.mock("../src/core/remoteAgent/cloudflareTunnel.js", () => ({
  listActiveTunnels: mocks.listActiveTunnels,
  stopQuickTunnel: mocks.stopQuickTunnel,
}));
vi.mock("../src/core/remoteAgent/museWatcherTunnel.js", () => ({
  stopOwnedMuseTunnel: mocks.stopOwnedMuseTunnel,
}));
vi.mock("../src/core/runtime/mcpManagedTunnelOwner.js", () => ({
  readManagedMcpTunnelLease: mocks.readManagedMcpTunnelLease,
  stopManagedMcpTunnelOwner: mocks.stopManagedMcpTunnelOwner,
}));

function context() {
  const lines: Array<{ type: string; content: string }> = [];
  const ctx = { addLine: (line: { type: string; content: string }) => lines.push(line) } as unknown as SlashCommandContext;
  return { ctx, lines };
}

describe("aggregate service status and stop-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectedServers.clear();
    mocks.loadRemoteAgentConfig.mockReturnValue({
      botToken: "configured-token",
      groupId: "-100123",
      museBotId: "123456",
    });
    mocks.loadModelConfig.mockReturnValue({
      mcpServers: { github: { transport: "stdio", command: "node" } },
    });
    mocks.connectedServers.set("github", { status: "connected", tools: ["search"] });
    mocks.getMeInfo.mockResolvedValue({ ok: true, username: "test_bot" });
    mocks.isMuseWatcherActive.mockReturnValue(true);
    mocks.stopAllMuseWatchers.mockResolvedValue(2);
    mocks.closeMcpServers.mockResolvedValue(undefined);
    mocks.listActiveMcpServers.mockReturnValue([
      { port: 9227, pid: process.pid, tunnelProvider: "cloudflare", authMode: "static-bearer", publicUrl: "https://mcp.example/mcp" },
      { port: 9228, pid: process.pid + 100, tunnelProvider: "openai", authMode: "oauth", openAiTunnelId: "tunnel_external" },
    ]);
    mocks.stopMcpTunnel.mockResolvedValue(undefined);
    mocks.listActiveTunnels.mockReturnValue([
      { port: 9225, pid: 1001, serviceKind: "muse-websocket", publicUrl: "https://muse.example", wssUrl: "wss://muse.example/muse" },
      { port: 9227, pid: 1002, serviceKind: "mcp-http", publicUrl: "https://mcp.example" },
      { port: 7888, pid: 1003, serviceKind: "superagent-http", publicUrl: "https://rest.example" },
      { port: 8123, pid: 1004, serviceKind: "unknown", publicUrl: "https://unknown.example" },
    ]);
    mocks.stopQuickTunnel.mockResolvedValue(true);
    mocks.stopOwnedMuseTunnel.mockResolvedValue(true);
    mocks.readManagedMcpTunnelLease.mockReturnValue(null);
    mocks.stopManagedMcpTunnelOwner.mockResolvedValue({ stopped: true, draining: true, activeSessions: 0, inFlightRequests: 0 });
  });



  it("prints usage unless the user asks for all status", async () => {
    const { ctx, lines } = context();
    await statusCommand.execute("", ctx);
    expect(lines.at(-1)?.content).toContain("Usage: /status all");
    expect(mocks.getMeInfo).not.toHaveBeenCalled();
  });

  it("aggregates Telegram, MCP, REST/SSE, and Muse tunnel state without stopping anything", async () => {
    const { ctx, lines } = context();
    await statusCommand.execute("all", ctx);
    const output = lines.at(-1)?.content || "";

    expect(output).toContain("SUPERAGENT — ALL SERVICE STATUS");
    expect(output).toContain("Bot API: ONLINE (@test_bot)");
    expect(output).toContain("Telegram fallback watcher: ACTIVE");
    expect(output).toContain("github: CONNECTED");
    expect(output).toContain("MCP TUNNEL (2 active)");
    expect(output).toContain("REST/SSE PUBLIC TUNNEL (1 active)");
    expect(output).toContain("MUSE WEBSOCKET TUNNEL (1 active)");
    expect(output).toContain("UNKNOWN SERVICE KIND");
    expect(mocks.stopMcpTunnel).not.toHaveBeenCalled();
    expect(mocks.stopQuickTunnel).not.toHaveBeenCalled();
  });

  it("stops managed services, skips external-owner and unclassified tunnels, and preserves configs", async () => {
    const { ctx, lines } = context();
    await stopAllManagedServices(ctx);
    const output = lines.at(-1)?.content || "";

    expect(mocks.closeMcpServers).toHaveBeenCalledOnce();
    expect(mocks.stopMcpTunnel).toHaveBeenCalledWith(9227);
    expect(mocks.stopMcpTunnel).not.toHaveBeenCalledWith(9228);
    expect(mocks.stopOwnedMuseTunnel).toHaveBeenCalledWith(9225);
    expect(mocks.stopQuickTunnel).toHaveBeenCalledWith(9227, "mcp-http");
    expect(mocks.stopQuickTunnel).toHaveBeenCalledWith(7888, "superagent-http");
    expect(mocks.stopQuickTunnel).not.toHaveBeenCalledWith(8123, expect.anything());
    expect(mocks.stopAllMuseWatchers).toHaveBeenCalledOnce();
    expect(output).toContain("owned by PID");
    expect(output).toContain("ownership cannot be verified");
    expect(output).toContain("Saved Telegram/MCP configuration was not deleted");
  });

  it("stops independent managed MCP tunnel owners when lease matches PID", async () => {
    mocks.listActiveMcpServers.mockReturnValue([
      { port: 9229, pid: 4567, tunnelProvider: "cloudflare", authMode: "oauth" },
    ]);
    mocks.readManagedMcpTunnelLease.mockReturnValue({
      version: 1,
      kind: "managed_mcp_tunnel_owner",
      pid: 4567,
      port: 9229,
      nonce: "a".repeat(64),
      createdAt: Date.now(),
      workspace: "/test",
    });
    mocks.stopManagedMcpTunnelOwner.mockResolvedValue({ stopped: true, draining: true, activeSessions: 0, inFlightRequests: 0 });
    const { ctx, lines } = context();
    await stopAllManagedServices(ctx);
    const output = lines.at(-1)?.content || "";

    expect(mocks.stopManagedMcpTunnelOwner).toHaveBeenCalledWith(9229, { force: true });
    expect(output).toContain("STOPPED (managed owner PID 4567)");
  });
});
