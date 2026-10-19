import { describe, expect, it } from "vitest";
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
});
