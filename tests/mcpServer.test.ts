import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import {
  superagentInstances,
  subagentInstances,
} from "../src/core/tools/state.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("Superagent Complete 3-Pillar MCP Server Suite (Tools, Resources, Prompts)", () => {
  const testDir = path.join(os.tmpdir(), `superagent_mcp_test_${Date.now()}`);

  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("lists and reads MCP Resources", async () => {
    const server = createSuperagentMcpServer();
    const listHandler = (server as any)._requestHandlers.get(ListResourcesRequestSchema.shape.method.value);
    const readHandler = (server as any)._requestHandlers.get(ReadResourceRequestSchema.shape.method.value);

    expect(listHandler).toBeDefined();
    expect(readHandler).toBeDefined();

    const listRes = await listHandler({ method: "resources/list", params: {} });
    expect(listRes.resources.length).toBeGreaterThanOrEqual(5);

    const uris = listRes.resources.map((r: any) => r.uri);
    expect(uris).toContain("superagent://status/live");
    expect(uris).toContain("superagent://config/current");
    expect(uris).toContain("superagent://workspace/info");
    expect(uris).toContain("superagent://history/sessions");
    expect(uris).toContain("superagent://memory/pinned");

    const statusRead = await readHandler({
      method: "resources/read",
      params: { uri: "superagent://status/live" },
    });
    expect(statusRead.contents[0].text).toContain("masterAgent");
  });

  it("lists and renders MCP Prompts", async () => {
    const server = createSuperagentMcpServer();
    const listHandler = (server as any)._requestHandlers.get(ListPromptsRequestSchema.shape.method.value);
    const getHandler = (server as any)._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    expect(listHandler).toBeDefined();
    expect(getHandler).toBeDefined();

    const listRes = await listHandler({ method: "prompts/list", params: {} });
    expect(listRes.prompts.length).toBeGreaterThanOrEqual(3);

    const promptNames = listRes.prompts.map((p: any) => p.name);
    expect(promptNames).toContain("superagent_orchestrate");
    expect(promptNames).toContain("superagent_debug");
    expect(promptNames).toContain("superagent_review");

    const promptGet = await getHandler({
      method: "prompts/get",
      params: {
        name: "superagent_orchestrate",
        arguments: { feature: "Add WebSocket Streaming", acceptanceCriteria: "Latency < 50ms" },
      },
    });
    expect(promptGet.messages[0].content.text).toContain("Feature Implementation Goal");
    expect(promptGet.messages[0].content.text).toContain("Add WebSocket Streaming");
  });

  it("lists all 36 MCP tools and executes context compaction", async () => {
    const server = createSuperagentMcpServer();
    const listHandler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const listRes = await listHandler({ method: "tools/list", params: {} });
    expect(listRes.tools.length).toBe(36);

    const toolNames = listRes.tools.map((t: any) => t.name);
    expect(toolNames).toContain("superagent_compact_context");

    const compactRes = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_compact_context",
        arguments: { strategy: "summarization", maxTokens: 8000 },
      },
    });
    expect(compactRes.content[0].text).toContain("Context Compaction Execution");
  });
});
