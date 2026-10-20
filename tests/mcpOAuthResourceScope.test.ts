import { describe, expect, it } from "vitest";
import {
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";

const req = (method: string, params: Record<string, unknown> = {}) => ({ method, params });

describe("Hermes Phase 5 OAuth resource/prompt scope boundary", () => {
  it("denies resource/prompt discovery and direct access without OAuth read grant", async () => {
    const server = createSuperagentMcpServer({
      authMode: "oauth", getIdentity: () => ({
        mode: "oauth", subject: "no-grant", scopes: [],
      }),
    });
    const handlers = (server as any)._requestHandlers;
    await expect(handlers.get(ListResourcesRequestSchema.shape.method.value)(
      req("resources/list"), {},
    )).rejects.toThrow(/mcp:tools/);
    await expect(handlers.get(ReadResourceRequestSchema.shape.method.value)(
      req("resources/read", { uri: "superagent://history/sessions" }), {},
    )).rejects.toThrow(/mcp:tools/);
    await expect(handlers.get(ListPromptsRequestSchema.shape.method.value)(
      req("prompts/list"), {},
    )).rejects.toThrow(/mcp:tools/);
    await expect(handlers.get(GetPromptRequestSchema.shape.method.value)(
      req("prompts/get", { name: "superagent_debug" }), {},
    )).rejects.toThrow(/mcp:tools/);
    await server.close();
  });

  it("read-only OAuth hides sensitive resources and denies direct URI reads", async () => {
    const server = createSuperagentMcpServer({
      authMode: "oauth", getIdentity: () => ({
        mode: "oauth", subject: "reader", scopes: ["mcp:tools"],
      }),
    });
    const handlers = (server as any)._requestHandlers;
    const list = handlers.get(ListResourcesRequestSchema.shape.method.value);
    const read = handlers.get(ReadResourceRequestSchema.shape.method.value);
    const listed = await list(req("resources/list"), {});
    expect(listed.resources.map((r: any) => r.uri)).toContain("superagent://instructions/agentic-mcp");
    for (const uri of ["superagent://status/live", "superagent://config/current",
      "superagent://history/sessions", "superagent://memory/pinned"]) {
      expect(listed.resources.map((r: any) => r.uri)).not.toContain(uri);
      await expect(read(req("resources/read", { uri }), {})).rejects.toThrow(/mcp:tools:admin/);
    }
    const safe = await read(req("resources/read", { uri: "superagent://instructions/agentic-mcp" }), {});
    expect(safe.contents[0].text).toContain("SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL");
    const prompts = await handlers.get(ListPromptsRequestSchema.shape.method.value)(req("prompts/list"), {});
    expect(prompts.prompts.map((p: any) => p.name)).toContain("superagent_debug");
    await server.close();
  });

  it("admin consent and write grant permit sensitive resources; revocation applies immediately", async () => {
    let scopes = ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"];
    const server = createSuperagentMcpServer({
      authMode: "oauth", getIdentity: () => ({
        mode: "oauth", subject: "admin", scopes,
      }),
    });
    const handlers = (server as any)._requestHandlers;
    const list = handlers.get(ListResourcesRequestSchema.shape.method.value);
    const read = handlers.get(ReadResourceRequestSchema.shape.method.value);
    const allowed = await list(req("resources/list"), {});
    expect(allowed.resources.map((r: any) => r.uri)).toContain("superagent://memory/pinned");
    scopes = ["mcp:tools", "mcp:tools:write"];
    const revoked = await list(req("resources/list"), {});
    expect(revoked.resources.map((r: any) => r.uri)).not.toContain("superagent://memory/pinned");
    await expect(read(req("resources/read", { uri: "superagent://memory/pinned" }), {}))
      .rejects.toThrow(/mcp:tools:admin/);
    await server.close();
  });

  it("local static-bearer/stdio resource compatibility remains unchanged", async () => {
    const server = createSuperagentMcpServer();
    const handlers = (server as any)._requestHandlers;
    const result = await handlers.get(ListResourcesRequestSchema.shape.method.value)(req("resources/list"), {});
    expect(result.resources.map((r: any) => r.uri)).toContain("superagent://history/sessions");
    await server.close();
  });
});
