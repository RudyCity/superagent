import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_AGENT_PROMPT_MAX_CHARS,
  getMcpAgentPromptPath,
  readMcpAgentPrompt,
  sanitizeMcpAgentPrompt,
  saveMcpAgentPrompt,
} from "../src/core/mcp/mcpAgentPrompt.js";
import { composeMcpSessionInstructions, getSuperagentMcpInstructions } from "../src/core/mcp/resourcesAndPrompts.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { applyMcpAgentPromptToRunningOwners, listManagedMcpTunnelOwnerPorts } from "../src/core/runtime/mcpManagedTunnelOwner.js";

let tempDir: string;
let priorConfigDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-prompt-"));
  priorConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  process.env.SUPERAGENT_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = priorConfigDir;
  fs.rmSync(tempDir, { force: true, recursive: true });
});

const initialize = (server: ReturnType<typeof createSuperagentMcpServer>): Promise<any> =>
  (server as any)._requestHandlers.get("initialize")({
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prompt-test-client", version: "1.0.0" },
    },
  });

describe("MCP agent knowledge prompt", () => {
  it("normalizes operator input and rejects oversized prompts", () => {
    expect(sanitizeMcpAgentPrompt("  line one \r\nline two\u0007  ")).toBe("line one\nline two");
    expect(() => sanitizeMcpAgentPrompt(null)).toThrow("MCP_AGENT_PROMPT_INVALID");
    expect(() => sanitizeMcpAgentPrompt(42)).toThrow("MCP_AGENT_PROMPT_INVALID");
    expect(sanitizeMcpAgentPrompt("x".repeat(MCP_AGENT_PROMPT_MAX_CHARS))).toHaveLength(MCP_AGENT_PROMPT_MAX_CHARS);
    expect(() => sanitizeMcpAgentPrompt("x".repeat(MCP_AGENT_PROMPT_MAX_CHARS + 1)))
      .toThrow("MCP_AGENT_PROMPT_TOO_LONG");
  });

  it("persists the prompt privately and reads it back", () => {
    expect(readMcpAgentPrompt()).toEqual({ prompt: "", updatedAt: null });
    const saved = saveMcpAgentPrompt("## Context\nUse the workspace inspection tool first.");
    expect(saved.prompt).toContain("workspace inspection tool");
    expect(saved.updatedAt).toBeGreaterThan(0);

    const restored = readMcpAgentPrompt();
    expect(restored.prompt).toBe(saved.prompt);
    expect(restored.updatedAt).toBe(saved.updatedAt);

    const record = JSON.parse(fs.readFileSync(getMcpAgentPromptPath(), "utf8"));
    expect(record).toMatchObject({ version: 1, prompt: saved.prompt });
    if (process.platform !== "win32") {
      expect(fs.statSync(getMcpAgentPromptPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("ignores corrupt or unset state instead of failing a session", () => {
    saveMcpAgentPrompt("temporary value");
    fs.writeFileSync(getMcpAgentPromptPath(), "{ not json");
    expect(readMcpAgentPrompt()).toEqual({ prompt: "", updatedAt: null });
    fs.writeFileSync(getMcpAgentPromptPath(), JSON.stringify({ version: 2, prompt: "future" }));
    expect(readMcpAgentPrompt()).toEqual({ prompt: "", updatedAt: null });
    saveMcpAgentPrompt("");
    expect(readMcpAgentPrompt().prompt).toBe("");
  });

  it("composes the operator section without dropping the canonical protocol", () => {
    const canonical = getSuperagentMcpInstructions();
    expect(composeMcpSessionInstructions()).toBe(canonical);
    expect(composeMcpSessionInstructions("   ")).toBe(canonical);
    const composed = composeMcpSessionInstructions("Inspect superagent://workspace/info first.");
    expect(composed.startsWith(canonical)).toBe(true);
    expect(composed).toContain("## OPERATOR SESSION PROMPT");
    expect(composed).toContain("Inspect superagent://workspace/info first.");
    expect(composed).toContain("never grants permissions");
  });

  it("advertises the saved prompt during the initialize handshake", async () => {
    saveMcpAgentPrompt("Before writing files, read the workspace status tool.");
    const result = await initialize(createSuperagentMcpServer());
    expect(result.instructions).toContain("SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL");
    expect(result.instructions).toContain("## OPERATOR SESSION PROMPT");
    expect(result.instructions).toContain("Before writing files, read the workspace status tool.");

    // Explicit call-site instructions still win over the saved global prompt.
    const explicit = await initialize(createSuperagentMcpServer({
      instructions: "Explicit owner prompt only.",
    }));
    expect(explicit.instructions).toBe("Explicit owner prompt only.");
  });

  it("reports no managed owners instead of inventing an apply result", async () => {
    expect(listManagedMcpTunnelOwnerPorts()).toEqual([]);
    expect(await applyMcpAgentPromptToRunningOwners()).toEqual({ applied: [], skipped: [] });
  });
});
