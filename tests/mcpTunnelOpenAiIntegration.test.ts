import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  startOpenAiTunnel: vi.fn(),
  stopOpenAiTunnel: vi.fn(),
  getOpenAiTunnelStatus: vi.fn(),
  startMcpHttpServer: vi.fn(),
  generateMcpBearerToken: vi.fn(() => "mock-bearer-token-1234"),
  getDefaultSafeTools: vi.fn(() => [{ name: "read_file" }, { name: "list_files" }]),
}));

vi.mock("../src/core/mcp/openaiTunnelClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mcp/openaiTunnelClient.js")>();
  return {
    ...actual,
    startOpenAiTunnel: mocks.startOpenAiTunnel,
    stopOpenAiTunnel: mocks.stopOpenAiTunnel,
    getOpenAiTunnelStatus: mocks.getOpenAiTunnelStatus,
  };
});

vi.mock("../src/core/mcp/mcpHttpTransport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mcp/mcpHttpTransport.js")>();
  return {
    ...actual,
    startMcpHttpServer: mocks.startMcpHttpServer,
    generateMcpBearerToken: mocks.generateMcpBearerToken,
    getDefaultSafeTools: mocks.getDefaultSafeTools,
  };
});

import {
  startMcpTunnel,
  stopMcpTunnel,
  listActiveMcpServers,
  formatActiveMcpServers,
  getMcpStateFile,
  readMcpStateFile,
} from "../src/core/mcp/mcpTunnel.js";

describe("MCP Tunnel with OpenAI Secure MCP Tunnel Provider", () => {
  let tempHome: string;
  let homedirSpy: { mockRestore(): void };
  let closeServerMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-openai-tunnel-integration-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    closeServerMock = vi.fn().mockResolvedValue(undefined);
    mocks.startMcpHttpServer.mockResolvedValue({
      server: {},
      url: "http://127.0.0.1:19427/mcp",
      port: 19427,
      close: closeServerMock,
    });

    mocks.startOpenAiTunnel.mockResolvedValue({
      isRunning: true,
      pid: process.pid,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      mcpPort: 19427,
      localUrl: "http://127.0.0.1:19427/mcp",
      adminUrl: "http://127.0.0.1:20427/ui",
      healthUrl: "http://127.0.0.1:20427/healthz",
      readyUrl: "http://127.0.0.1:20427/readyz",
      healthy: true,
      ready: true,
      startedAt: Date.now(),
      uptimeSeconds: 0,
      profile: "superagent-mcp",
    });

    mocks.stopOpenAiTunnel.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    homedirSpy?.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("fails if tunnelProvider is openai but no tunnelId is provided", async () => {
    await expect(
      startMcpTunnel({
        port: 19427,
        tunnelProvider: "openai",
      })
    ).rejects.toThrow("OpenAI Secure MCP Tunnel requires a tunnel ID");
  });

  it("successfully starts local MCP server and OpenAI tunnel client", async () => {
    const info = await startMcpTunnel({
      port: 19427,
      tunnelProvider: "openai",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      openAiApiKey: "sk-test-key",
      openAiProfile: "my-test-profile",
    });

    expect(info.tunnelProvider).toBe("openai");
    expect(info.openAiTunnelId).toBe("tunnel_0123456789abcdef0123456789abcdef");
    expect(info.publicUrl).toBe("openai-tunnel://tunnel_0123456789abcdef0123456789abcdef");
    expect(info.localUrl).toBe("http://127.0.0.1:19427/mcp");
    expect(info.adminUrl).toBe("http://127.0.0.1:20427/ui");
    expect(info.ready).toBe(true);

    expect(mocks.startMcpHttpServer).toHaveBeenCalled();
    expect(mocks.startOpenAiTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        mcpPort: 19427,
        apiKey: "sk-test-key",
        profile: "my-test-profile",
      })
    );

    // State file verification
    const state = readMcpStateFile(getMcpStateFile(19427));
    expect(state).not.toBeNull();
    expect(state?.tunnelProvider).toBe("openai");
    expect(state?.openAiTunnelId).toBe("tunnel_0123456789abcdef0123456789abcdef");
    expect(state?.adminUrl).toBe("http://127.0.0.1:20427/ui");

    // Format active servers
    const active = listActiveMcpServers();
    expect(active.length).toBe(1);
    const formatted = formatActiveMcpServers(active);
    expect(formatted).toContain("OpenAI Secure MCP Tunnel");
    expect(formatted).toContain("tunnel_0123456789abcdef0123456789abcdef");
    expect(formatted).toContain("http://127.0.0.1:20427/ui");
  });

  it("rolls back local MCP server if startOpenAiTunnel fails", async () => {
    mocks.startOpenAiTunnel.mockRejectedValue(new Error("tunnel-client failed to bind"));

    await expect(
      startMcpTunnel({
        port: 19428,
        tunnelProvider: "openai",
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      })
    ).rejects.toThrow("tunnel-client failed to bind");

    expect(closeServerMock).toHaveBeenCalled();
  });

  it("stops OpenAI tunnel and local MCP server on stopMcpTunnel", async () => {
    await startMcpTunnel({
      port: 19429,
      tunnelProvider: "openai",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    await stopMcpTunnel(19429);

    expect(mocks.stopOpenAiTunnel).toHaveBeenCalledWith(19429);
    expect(closeServerMock).toHaveBeenCalled();
  });

  it("refuses to switch an active OpenAI MCP server to Cloudflare on the same port", async () => {
    const port = 19430;
    await startMcpTunnel({
      port,
      tunnelProvider: "openai",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    await expect(startMcpTunnel({ port, tunnelProvider: "cloudflare" }))
      .rejects.toThrow("already running with the openai tunnel provider");

    expect(mocks.startOpenAiTunnel).toHaveBeenCalledOnce();
    await stopMcpTunnel(port);
  });
});
