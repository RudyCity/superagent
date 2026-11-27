import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleServerRoute } from "../src/serverRoutes.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";
import { readMcpAgentPrompt, saveMcpAgentPrompt } from "../src/core/mcp/mcpAgentPrompt.js";

describe("MCP agent prompt operator route boundary", () => {
  const priorConfig = process.env.SUPERAGENT_CONFIG_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mcp-prompt-route-"));

  beforeAll(() => { process.env.SUPERAGENT_CONFIG_DIR = sandbox; });
  afterAll(() => {
    if (priorConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = priorConfig;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  async function invoke(options: {
    peer?: string; host?: string; origin?: string; method?: string; body?: string;
    pathname?: string;
  } = {}) {
    const pathname = options.pathname ?? "/api/desktop/mcp-agent-prompt";
    const reply: { status?: number; body?: any } = {};
    const host = options.host ?? "localhost:7888";
    const headers: Record<string, string> = {
      host,
      authorization: "Bearer " + ensureServerAuthToken(),
    };
    if (options.origin) headers.origin = options.origin;
    const req = {
      method: options.method ?? "POST",
      headers,
      socket: { remoteAddress: options.peer ?? "127.0.0.1" },
    } as any;
    const response = { setHeader() {} } as any;
    const ctx = {
      activeSessions: new Map(),
      readBody: async () => options.body ?? "{}",
      sendJSON(_res: unknown, status: number, body: any) {
        reply.status = status;
        reply.body = body;
      },
    } as any;
    const handled = await handleServerRoute(req, response, pathname,
      new URL("http://" + host + pathname), ctx);
    return { handled, ...reply };
  }

  it("rejects remote peers, tunnel hosts and browser origins", async () => {
    for (const denied of [
      { peer: "203.0.113.10" },
      { host: "superagent.example.com" },
      { origin: "https://superagent.example.com" },
    ]) {
      const result = await invoke({ ...denied, body: JSON.stringify({ instructions: "test" }) });
      expect(result.handled).toBe(true);
      expect(result.status).toBe(403);
      expect(result.body?.error).toBe("MCP_PROMPT_LOCAL_AUTHENTICATED_ONLY");
    }
  });

  it("reads the saved prompt over GET", async () => {
    saveMcpAgentPrompt("Read the workspace status tool first.");
    const result = await invoke({ method: "GET" });
    expect(result.status).toBe(200);
    expect(result.body?.success).toBe(true);
    expect(result.body?.prompt).toBe("Read the workspace status tool first.");
    expect(result.body?.maxChars).toBe(6000);
    expect(result.body?.history).toEqual([
      { at: expect.any(Number), length: "Read the workspace status tool first.".length },
    ]);
    expect(Array.isArray(result.body?.applied)).toBe(false);
  });

  it("previews a draft with the canonical protocol without saving it", async () => {
    saveMcpAgentPrompt("saved prompt");
    const preview = await invoke({
      pathname: "/api/desktop/mcp-agent-prompt/preview",
      body: JSON.stringify({ instructions: "draft only guidance" }),
    });
    expect(preview.status).toBe(200);
    expect(preview.body?.effective).toContain("SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL");
    expect(preview.body?.effective).toContain("## OPERATOR SESSION PROMPT");
    expect(preview.body?.effective).toContain("draft only guidance");
    expect(preview.body?.length).toBe("draft only guidance".length);
    expect(preview.body?.effectiveLength).toBe(preview.body?.effective.length);
    expect(readMcpAgentPrompt().prompt).toBe("saved prompt");

    const emptyDraft = await invoke({
      pathname: "/api/desktop/mcp-agent-prompt/preview",
      body: JSON.stringify({ instructions: "   " }),
    });
    expect(emptyDraft.body?.effective).not.toContain("## OPERATOR SESSION PROMPT");
    expect(emptyDraft.body?.length).toBe(0);

    const tooLong = await invoke({
      pathname: "/api/desktop/mcp-agent-prompt/preview",
      body: JSON.stringify({ instructions: "x".repeat(6001) }),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body?.error).toBe("MCP_AGENT_PROMPT_TOO_LONG");

    const wrongMethod = await invoke({
      pathname: "/api/desktop/mcp-agent-prompt/preview", method: "GET",
    });
    expect(wrongMethod.status).toBe(405);
  });

  it("saves a prompt and reports the owner apply result", async () => {
    const result = await invoke({
      body: JSON.stringify({ instructions: "  Keep writes inside the granted project.  " }),
    });
    expect(result.status).toBe(200);
    expect(result.body?.prompt).toBe("Keep writes inside the granted project.");
    expect(readMcpAgentPrompt().prompt).toBe("Keep writes inside the granted project.");
    expect(result.body?.applied).toEqual([]);
    expect(result.body?.skipped).toEqual([]);
  });

  it("rejects malformed bodies without touching the saved prompt", async () => {
    saveMcpAgentPrompt("stable prompt");
    const unexpectedKey = await invoke({ body: JSON.stringify({ instructions: "x", port: 9227 }) });
    expect(unexpectedKey.status).toBe(400);
    expect(unexpectedKey.body?.error).toBe("MCP_PROMPT_REQUEST_INVALID");

    const nonString = await invoke({ body: JSON.stringify({ instructions: 42 }) });
    expect(nonString.status).toBe(400);
    expect(nonString.body?.error).toBe("MCP_PROMPT_REQUEST_INVALID");

    const tooLong = await invoke({ body: JSON.stringify({ instructions: "x".repeat(6001) }) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body?.error).toBe("MCP_AGENT_PROMPT_TOO_LONG");

    const oversized = await invoke({ body: JSON.stringify({ instructions: "y".repeat(30_000) }) });
    expect(oversized.status).toBe(413);
    expect(oversized.body?.error).toBe("MCP_PROMPT_REQUEST_TOO_LARGE");

    expect(readMcpAgentPrompt().prompt).toBe("stable prompt");
  });

  it("rejects unsupported methods", async () => {
    const result = await invoke({ method: "PUT" });
    expect(result.status).toBe(405);
    expect(result.body?.error).toBe("MCP_PROMPT_POST_REQUIRED");
  });
});
