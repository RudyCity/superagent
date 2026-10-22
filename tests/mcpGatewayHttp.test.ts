import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, generateMcpBearerToken } from "../src/core/mcp/mcpHttpTransport.js";
import { MCP_GATEWAY_TOOL_NAMES } from "../src/core/mcp/mcpToolGateway.js";

describe("MCP gateway Streamable HTTP integration", () => {
  it("advertises compact catalog, searches authorized capabilities and does not bypass execute permission", async () => {
    const token = generateMcpBearerToken();
    const server = await startMcpHttpServer({
      port: 0, bearerToken: token, allowDangerous: false, toolExposure: "gateway",
    });
    const client = new Client({ name: "mcp-gateway-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        MCP_GATEWAY_TOOL_NAMES.search,
        MCP_GATEWAY_TOOL_NAMES.describe,
        MCP_GATEWAY_TOOL_NAMES.status,
      ].sort());
      const search = await client.callTool({
        name: MCP_GATEWAY_TOOL_NAMES.search,
        arguments: { query: "workspace", limit: 6 },
      });
      expect(search.isError).not.toBe(true);
      const parsed = JSON.parse((search.content as any[]).find((entry) => entry.type === "text").text);
      expect(parsed.tools.map((entry: any) => entry.name)).toContain("superagent_get_workspace");
      expect(parsed.tools.map((entry: any) => entry.name)).not.toContain("superagent_switch_workspace");

      const description = await client.callTool({
        name: MCP_GATEWAY_TOOL_NAMES.describe,
        arguments: { name: "superagent_get_workspace" },
      });
      expect(JSON.stringify(description.content)).toContain("inputSchema");
      await expect(client.callTool({
        name: MCP_GATEWAY_TOOL_NAMES.execute,
        arguments: { name: "superagent_get_workspace", arguments: {} },
      })).rejects.toThrow(/allowlist/i);
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  }, 30000);

  it("exposes exactly four gateway tools with explicit dangerous opt-in and dispatches authorized targets", async () => {
    const token = generateMcpBearerToken();
    const server = await startMcpHttpServer({
      port: 0, bearerToken: token, allowDangerous: true, toolExposure: "gateway",
    });
    const client = new Client({ name: "mcp-gateway-write-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(MCP_GATEWAY_TOOL_NAMES).sort());

      const dispatched = await client.callTool({
        name: MCP_GATEWAY_TOOL_NAMES.execute,
        arguments: { name: "superagent_server_health", arguments: {} },
      });
      expect(dispatched.isError).not.toBe(true);
      expect((dispatched.content as any[]).some((part) => part.type === "text")).toBe(true);

      const forbidden = await client.callTool({
        name: MCP_GATEWAY_TOOL_NAMES.execute,
        arguments: { name: "superagent_read_file", arguments: { path: ".env" } },
      });
      expect(forbidden.isError).toBe(true);
      const status = await client.callTool({ name: MCP_GATEWAY_TOOL_NAMES.status, arguments: {} });
      expect(JSON.stringify(status.content)).toContain("visibleToolCount");
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  }, 30000);
});
