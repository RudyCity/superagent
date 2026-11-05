import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectCapabilityForTool } from "../src/core/project/projectAccessPolicy.js";
import { WORKSPACE_SCOPED_MCP_TOOLS } from "../src/core/mcp/mcpWorkspacePolicy.js";
import {
  REMOTE_AGENT_FILE_MCP_TOOL_DEFS,
  REMOTE_AGENT_FILE_MCP_TOOL_CLASSIFICATIONS,
  handleMuseSendFile,
} from "../src/core/mcp/tools/remoteAgentFileMcpTools.js";
import { dispatchRemoteAgentMcpTool } from "../src/core/mcp/tools/remoteAgentMcpTools.js";

describe("Muse outbound file MCP security boundary", () => {
  it("requires workspace routing, write-grant capability and dangerous-tool authorization", () => {
    for (const name of ["superagent_telegram_send_file", "superagent_muse_send_file"]) {
      expect(WORKSPACE_SCOPED_MCP_TOOLS.has(name)).toBe(true);
      expect(getProjectCapabilityForTool(name)).toBe("write");
      expect(REMOTE_AGENT_FILE_MCP_TOOL_CLASSIFICATIONS[name]).toBe("dangerous");
      expect(REMOTE_AGENT_FILE_MCP_TOOL_DEFS.find((def) => def.name === name)?.inputSchema.properties)
        .toHaveProperty("projectId");
    }
  });

  it("rejects a missing trusted workspace before contacting a Muse socket", async () => {
    const result = await handleMuseSendFile({ filePath: "abc.csv" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("authorized local MCP workspace");
  });

  it("refuses an explicit file path escaping the authorized root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-scope-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-scope-outside-"));
    try {
      const secret = path.join(outsideRoot, "outside.csv");
      await fs.writeFile(secret, "do not upload");
      const result = await dispatchRemoteAgentMcpTool("superagent_muse_send_file", { filePath: secret }, root);
      expect(result?.isError).toBe(true);
      expect(JSON.stringify(result?.content)).toContain("outside the selected workspace");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
