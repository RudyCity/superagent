import { describe, expect, it, vi } from "vitest";
import { getDashboardSuggestions } from "../src/utils/dashboardSuggestions.js";
import { handleMuseTunnelSubcommand } from "../src/core/commands/museTunnelSubcommand.js";
import { mcpCommand } from "../src/core/commands/mcpCommand.js";
import { serverCommand } from "../src/core/commands/serverCommand.js";
import { getMcpTunnelProvidersHelp } from "../src/core/commands/commandCatalog.js";

function makeContext() {
  const lines: { type: string; content: string }[] = [];
  return {
    lines,
    ctx: { addLine: (line: { type: string; content: string }) => lines.push(line) } as any,
  };
}

describe("command domain separation", () => {
  it("keeps Muse tunnel suggestions free of MCP and REST/SSE options", () => {
    const query = "/muse tunnel";
    const suggestions = getDashboardSuggestions(query, query.length);
    expect(suggestions).toContain("/muse tunnel start");
    expect(suggestions.some((item) => /--mcp|--provider|--tunnel-id|--mcp-auth|--https/.test(item))).toBe(false);
  });

  it("keeps Telegram suggestions within the Telegram domain", () => {
    const query = "/telegram send";
    const suggestions = getDashboardSuggestions(query, query.length);
    expect(suggestions).toContain("/telegram send");
    expect(suggestions.every((item) => item.startsWith("/telegram"))).toBe(true);
  });

  it("exposes tunnel providers only under MCP suggestions", () => {
    const query = "/mcp tunnel";
    const suggestions = getDashboardSuggestions(query, query.length);
    expect(suggestions).toContain("/mcp tunnel providers");
    expect(suggestions).toContain("/mcp tunnel start --provider cloudflare");
    expect(suggestions).toContain("/mcp tunnel start --provider openai --tunnel-id");
  });

  it("keeps REST/SSE tunnel suggestions under /server", () => {
    const query = "/server tunnel";
    const suggestions = getDashboardSuggestions(query, query.length);
    expect(suggestions).toContain("/server tunnel start");
    expect(suggestions.every((item) => item.startsWith("/server tunnel"))).toBe(true);
  });

  it("suggests aggregate status and shutdown commands", () => {
    expect(getDashboardSuggestions("/status", "/status".length)).toContain("/status all");
    expect(getDashboardSuggestions("/stop", "/stop".length)).toContain("/stop all");
  });

  it("rejects MCP flags from the Muse tunnel handler without starting services", async () => {
    const { ctx, lines } = makeContext();
    await handleMuseTunnelSubcommand(["tunnel", "start", "--mcp", "--provider", "openai"], ctx, Date.now());
    expect(lines.at(-1)?.type).toBe("error");
    expect(lines.at(-1)?.content).toContain("Use /mcp tunnel");
  });

  it("redirects REST/SSE tunnel operations away from Muse", async () => {
    const { ctx, lines } = makeContext();
    await handleMuseTunnelSubcommand(["tunnel", "start", "--https"], ctx, Date.now());
    expect(lines.at(-1)?.type).toBe("error");
    expect(lines.at(-1)?.content).toContain("/server tunnel");
  });

  it("rejects MCP tunnel flags under /server", async () => {
    const { ctx, lines } = makeContext();
    await serverCommand.execute("tunnel start --provider openai", ctx);
    expect(lines.at(-1)?.type).toBe("error");
    expect(lines.at(-1)?.content).toContain("/mcp tunnel");
  });

  it("rejects unsupported MCP tunnel providers instead of silently defaulting", async () => {
    const { ctx, lines } = makeContext();
    await mcpCommand.execute("tunnel start --provider not-a-provider", ctx);
    expect(lines.at(-1)?.type).toBe("error");
    expect(lines.at(-1)?.content).toContain("Supported providers: cloudflare, openai");
  });

  it("documents Cloudflare and OpenAI as explicit MCP tunnel providers", () => {
    const help = getMcpTunnelProvidersHelp();
    expect(help).toContain("cloudflare: Cloudflare Quick Tunnel");
    expect(help).toContain("openai: OpenAI Secure MCP Tunnel");
    expect(help).toContain("/mcp tunnel start --provider openai --tunnel-id <id>");
  });

  it("rejects invalid --mcp-auth values under /mcp tunnel", async () => {
    const { ctx, lines } = makeContext();
    await mcpCommand.execute("tunnel start --mcp-auth invalid-mode", ctx);
    expect(lines.at(-1)?.type).toBe("error");
    expect(lines.at(-1)?.content).toContain("Invalid --mcp-auth value");
  });

  it("passes an explicit OpenAI OAuth public issuer from the MCP command only", async () => {
    const { ctx } = makeContext();
    const spy = vi.spyOn(await import("../src/core/mcp/mcpTunnel.js"), "startMcpTunnel")
      .mockResolvedValueOnce({
        publicUrl: "openai-tunnel://tunnel_123456789abcdef0",
        bearerToken: "", localUrl: "http://127.0.0.1:9227/mcp",
        auditLogPath: "/tmp/audit.log", dangerous: false, toolCount: 4,
        authMode: "oauth", tunnelProvider: "openai",
        openAiTunnelId: "tunnel_123456789abcdef0", bootstrapCode: "mock-code",
        oauthDiscoveryUrl: "https://issuer.example.test/.well-known/oauth-authorization-server",
      });
    await mcpCommand.execute(
      "tunnel start --provider openai --tunnel-id tunnel_123456789abcdef0 --mcp-auth oauth --oauth-public-url https://issuer.example.test",
      ctx,
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      tunnelProvider: "openai", authMode: "oauth",
      oauthPublicBaseUrl: "https://issuer.example.test",
    }));
    spy.mockRestore();
  });

  it("forwards --mcp-auth oauth to startMcpTunnel and displays the bootstrap approval code", async () => {
    const { ctx, lines } = makeContext();
    const spy = vi.spyOn(await import("../src/core/mcp/mcpTunnel.js"), "startMcpTunnel").mockResolvedValueOnce({
      publicUrl: "https://example.trycloudflare.com/mcp",
      bearerToken: "",
      localUrl: "http://127.0.0.1:9227/mcp",
      auditLogPath: "/tmp/audit.log",
      dangerous: false,
      toolCount: 15,
      authMode: "oauth",
      bootstrapCode: "mock-bootstrap-code-12345",
      oauthDiscoveryUrl: "https://example.trycloudflare.com/.well-known/oauth-authorization-server",
      tunnelProvider: "cloudflare",
    });

    await mcpCommand.execute("tunnel start --mcp-auth oauth", ctx);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      authMode: "oauth",
    }));
    const output = lines.map((l) => l.content).join("\n");
    expect(output).toContain("mock-bootstrap-code-12345");
    expect(output).toContain("One-time bootstrap approval code");
    expect(output).toContain("Auth Mode    : oauth");
  });
});
