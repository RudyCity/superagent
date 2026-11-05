#!/usr/bin/env bun
/**
 * Optional local-only PDF MCP stdio server.
 * 
 * Read tools by default:
 *   bun scripts/pdf-mcp.ts
 * Enable output mutations after operator decision:
 *   bun scripts/pdf-mcp.ts --allow-write
 *
 * Run from the intended local project root. This process does NOT register
 * tools into the live primary SuperAgent MCP owner. Do not treat --allow-write
 * as permission to bypass the owner's OAuth/project/YOLO controls.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PDF_MCP_MUTATING_NAMES, PDF_MCP_TOOL_DEFS, dispatchPdfMcpTool } from "../src/core/mcp/tools/pdfMcpTools.js";

const allowWrite = process.argv.includes("--allow-write");
const server = new Server(
  { name: "superagent-pdf-stdio", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: PDF_MCP_TOOL_DEFS.filter(tool => allowWrite || !PDF_MCP_MUTATING_NAMES.has(tool.name)),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  return dispatchPdfMcpTool(name, args, process.cwd(), { allowWrite });
});
await server.connect(new StdioServerTransport());
