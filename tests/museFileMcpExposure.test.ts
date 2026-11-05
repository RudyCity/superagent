import { describe, expect, it } from "vitest";
import {
  REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS,
  REMOTE_AGENT_MCP_TOOL_DEFS,
} from "../src/core/mcp/tools/remoteAgentMcpTools.js";

describe("Muse and Telegram file MCP exposure", () => {
  it("exposes separate, dangerous file tools without mutating text tool schemas", () => {
    const byName = new Map(REMOTE_AGENT_MCP_TOOL_DEFS.map((definition) => [definition.name, definition]));
    for (const name of ["superagent_telegram_send_file", "superagent_muse_send_file"]) {
      expect(byName.has(name)).toBe(true);
      expect(REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS[name]).toBe("dangerous");
      const def = byName.get(name)!;
      expect(def.inputSchema.required).toContain("filePath");
    }
    expect(byName.has("superagent_muse_file_status")).toBe(true);
    expect(byName.has("superagent_muse_file_cancel")).toBe(true);
    expect(REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS.superagent_muse_file_status).toBe("safe");
    expect(REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS.superagent_muse_file_cancel).toBe("dangerous");
    expect(byName.get("superagent_telegram_send_to_muse")?.inputSchema.required).toEqual(["text"]);
    expect(byName.get("superagent_muse_chat")?.inputSchema.required).toEqual(["text"]);
  });
});
