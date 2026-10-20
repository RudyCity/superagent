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
import { setOpenAiMcpTunnelId } from "../src/core/mcp/openaiMcpTunnelConfig.js";

describe("MCP Tunnel with OpenAI Secure MCP Tunnel Provider", () => {
  let tempHome: string;
  let homedirSpy: { mockRestore(): void };
  let closeServerMock: any;
  let originalOpenAiTunnelId: string | undefined;
  let originalControlPlaneTunnelId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalOpenAiTunnelId = process.env.OPENAI_MCP_TUNNEL_ID;
    originalControlPlaneTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID;
    delete process.env.OPENAI_MCP_TUNNEL_ID;
    delete process.env.CONTROL_PLANE_TUNNEL_ID;
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
    vi.restoreAllMocks();
    homedirSpy?.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
    if (originalOpenAiTunnelId === undefined) delete process.env.OPENAI_MCP_TUNNEL_ID;
    else process.env.OPENAI_MCP_TUNNEL_ID = originalOpenAiTunnelId;
    if (originalControlPlaneTunnelId === undefined) delete process.env.CONTROL_PLANE_TUNNEL_ID;
    else process.env.CONTROL_PLANE_TUNNEL_ID = originalControlPlaneTunnelId;
  });

  it("fails if tunnelProvider is openai but no tunnelId is provided", async () => {
    await expect(
      startMcpTunnel({
        port: 19427,
        tunnelProvider: "openai",
      })
    ).rejects.toThrow("OpenAI Secure MCP Tunnel requires a tunnel ID");
    expect(mocks.startOpenAiTunnel).not.toHaveBeenCalled();
    expect(mocks.startMcpHttpServer).not.toHaveBeenCalled();
  });

  it("uses OPENAI_MCP_TUNNEL_ID when OpenAI is selected without an explicit tunnel ID", async () => {
    const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
    process.env.OPENAI_MCP_TUNNEL_ID = tunnelId;

    const info = await startMcpTunnel({ port: 19431, tunnelProvider: "openai" });

    expect(info.tunnelProvider).toBe("openai");
    expect(info.openAiTunnelId).toBe(tunnelId);
    expect(mocks.startOpenAiTunnel).toHaveBeenCalledWith(expect.objectContaining({ tunnelId }));
    await stopMcpTunnel(19431);
  });

  it("selects OpenAI from saved Tunnel ID config when no provider was explicitly selected", async () => {
    const previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = tempHome;
    try {
      const tunnelId = "tunnel_saved_0123456789";
      setOpenAiMcpTunnelId(tunnelId);

      const info = await startMcpTunnel({ port: 19436 });

      expect(info.tunnelProvider).toBe("openai");
      expect(info.openAiTunnelId).toBe(tunnelId);
      expect(mocks.startOpenAiTunnel).toHaveBeenCalledWith(expect.objectContaining({ tunnelId }));
      await stopMcpTunnel(19436);
    } finally {
      if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
    }
  });

  it("selects OpenAI from OPENAI_MCP_TUNNEL_ID when no provider was explicitly selected", async () => {
    const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
    process.env.OPENAI_MCP_TUNNEL_ID = tunnelId;

    const info = await startMcpTunnel({ port: 19432 });

    expect(info.tunnelProvider).toBe("openai");
    expect(info.openAiTunnelId).toBe(tunnelId);
    expect(mocks.startOpenAiTunnel).toHaveBeenCalledOnce();
    await stopMcpTunnel(19432);
  });

  it("fails clearly for an invalid OpenAI tunnel ID instead of switching providers", async () => {
    await expect(startMcpTunnel({
      port: 19433,
      tunnelProvider: "openai",
      tunnelId: "not a valid tunnel id",
    })).rejects.toThrow("Invalid OpenAI Secure MCP Tunnel ID");

    expect(mocks.startOpenAiTunnel).not.toHaveBeenCalled();
    expect(mocks.startMcpHttpServer).not.toHaveBeenCalled();
  });

  it("rejects an unsupported provider instead of defaulting to Cloudflare", async () => {
    await expect(startMcpTunnel({
      port: 19434,
      tunnelProvider: "invalid-provider" as any,
    })).rejects.toThrow('Unsupported MCP tunnel provider "invalid-provider"');

    expect(mocks.startOpenAiTunnel).not.toHaveBeenCalled();
    expect(mocks.startMcpHttpServer).not.toHaveBeenCalled();
  });

  it("honors explicit Cloudflare selection even when an OpenAI tunnel ID is configured", async () => {
    process.env.OPENAI_MCP_TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";
    const startQuickTunnel = vi.spyOn(await import("../src/core/remoteAgent/cloudflareTunnel.js"), "startQuickTunnel")
      .mockResolvedValueOnce({ publicUrl: "https://test.trycloudflare.com" } as any);
    const getTunnelStatus = vi.spyOn(await import("../src/core/remoteAgent/cloudflareTunnel.js"), "getTunnelStatus")
      .mockReturnValue({ isRunning: false } as any);
    const claimTunnelServiceKind = vi.spyOn(await import("../src/core/remoteAgent/cloudflareTunnel.js"), "claimTunnelServiceKind")
      .mockReturnValue(true);
    const startMcpHttp = mocks.startMcpHttpServer.mockResolvedValueOnce({
      server: {}, url: "http://127.0.0.1:19435/mcp", port: 19435, close: closeServerMock,
    });

    const info = await startMcpTunnel({ port: 19435, tunnelProvider: "cloudflare" });
    expect(info.tunnelProvider).toBe("cloudflare");
    expect(startQuickTunnel).toHaveBeenCalledOnce();
    expect(mocks.startOpenAiTunnel).not.toHaveBeenCalled();
    await stopMcpTunnel(19435);
    startQuickTunnel.mockRestore();
    getTunnelStatus.mockRestore();
    claimTunnelServiceKind.mockRestore();
    expect(startMcpHttp).toHaveBeenCalled();
  });

  it("fails closed if OpenAI OAuth has no public HTTPS issuer", async () => {
    const oldEnv = process.env.OPENAI_MCP_OAUTH_PUBLIC_URL;
    delete process.env.OPENAI_MCP_OAUTH_PUBLIC_URL;
    try {
      await expect(startMcpTunnel({
        port: 19500, tunnelProvider: "openai", authMode: "oauth",
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      })).rejects.toThrow(/HTTPS public issuer/i);
      for (const bad of [
        "http://127.0.0.1:19500", "http://remote.example.com",
        "https://localhost", "https://public.example.com/path",
        "https://user:secret@public.example.com",
        "https://public.example.com?token=secret",
      ]) {
        await expect(startMcpTunnel({
          port: 19500, tunnelProvider: "openai", authMode: "oauth",
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
          oauthPublicBaseUrl: bad,
        })).rejects.toThrow(/public HTTPS|HTTPS origin/i);
      }
      expect(mocks.startMcpHttpServer).not.toHaveBeenCalled();
      expect(mocks.startOpenAiTunnel).not.toHaveBeenCalled();
    } finally {
      if (oldEnv === undefined) delete process.env.OPENAI_MCP_OAUTH_PUBLIC_URL;
      else process.env.OPENAI_MCP_OAUTH_PUBLIC_URL = oldEnv;
    }
  });

  it("advertises the public HTTPS issuer and discovery for OpenAI OAuth", async () => {
    const publicIssuer = "https://oauth-demo.example.com";
    const info = await startMcpTunnel({
      port: 19501, tunnelProvider: "openai", authMode: "oauth",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      oauthPublicBaseUrl: publicIssuer,
    });
    expect(mocks.startMcpHttpServer).toHaveBeenCalledWith(expect.objectContaining({
      authMode: "oauth",
      oauth: expect.objectContaining({ publicBaseUrl: publicIssuer }),
      publicBaseUrl: publicIssuer,
    }));
    expect(info.oauthDiscoveryUrl).toBe(publicIssuer + "/.well-known/oauth-authorization-server");
    expect(info.oauthDiscoveryUrl).not.toContain("127.0.0.1");
    expect(readMcpStateFile(getMcpStateFile(19501))?.oauthPublicBaseUrl).toBe(publicIssuer);
    await expect(startMcpTunnel({
      port: 19501, tunnelProvider: "openai", authMode: "oauth",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      oauthPublicBaseUrl: "https://different.example.com",
    })).rejects.toThrow(/issuer differs/i);
    await stopMcpTunnel(19501);
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
