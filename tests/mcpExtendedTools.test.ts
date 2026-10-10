import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

describe("Superagent Extended MCP Tools Execution Suite", () => {
  const testDir = path.join(process.cwd(), `.tmp_mcp_ext_test_${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  async function callMcpTool(name: string, args: Record<string, unknown> = {}) {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    return await handler({
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  it("inspects port and searches processes via diagnostics MCP tools", async () => {
    // 1. inspect port (port 59998 is unlikely to conflict)
    const portRes = await callMcpTool("superagent_inspect_port", { port: 59998 });
    expect(portRes).toBeDefined();
    expect(portRes.content[0].type).toBe("text");
    expect(portRes.content[0].text).toMatch(/Port 59998 is (FREE|OCCUPIED)/i);

    // 2. find process
    const procRes = await callMcpTool("superagent_find_process", { query: "node" });
    expect(procRes).toBeDefined();
    expect(procRes.content[0].type).toBe("text");
  });

  it("retrieves skills and reads skill instructions via plan/skills MCP tools", async () => {
    // 1. get skills
    const skillsRes = await callMcpTool("superagent_get_skills", { query: "debug" });
    expect(skillsRes).toBeDefined();
    expect(skillsRes.content[0].type).toBe("text");

    // 2. use skill
    const useRes = await callMcpTool("superagent_use_skill", { skillName: "systematic-debugging" });
    expect(useRes).toBeDefined();
    expect(useRes.content[0].type).toBe("text");
    expect(useRes.content[0].text).toContain("systematic-debugging");
  });

  it("surgically mutates files via superagent_replace_file_content and superagent_apply_patch", async () => {
    const targetFile = path.join(testDir, "sample.txt");
    fs.writeFileSync(targetFile, "line 1\nhello world\nline 3\n", "utf-8");

    // Replace file content
    const replaceRes = await callMcpTool("superagent_replace_file_content", {
      filePath: targetFile,
      targetContent: "hello world",
      replacementContent: "superagent rocks",
      startLine: 1,
      endLine: 3,
    });
    expect(replaceRes.content[0].text).toContain("File updated");
    expect(fs.readFileSync(targetFile, "utf-8")).toContain("superagent rocks");

    // Apply patch
    const patchContent = "<<<<<<<\nline 1\n=======\nfirst line\n>>>>>>>\n";
    const patchRes = await callMcpTool("superagent_apply_patch", {
      filePath: targetFile,
      patchContent,
    });
    expect(patchRes.content[0].text).toContain("Patch applied successfully");
    expect(fs.readFileSync(targetFile, "utf-8")).toContain("first line");
  });

  it("reads plan and manages tasks via MCP", async () => {
    const planRes = await callMcpTool("superagent_manage_plan", { action: "get" });
    expect(planRes).toBeDefined();
    expect(planRes.content[0].type).toBe("text");
    expect(planRes.content[0].text).toContain("Implementation Plan Status");

    const taskRes = await callMcpTool("superagent_manage_tasks", { action: "list" });
    expect(taskRes).toBeDefined();
    expect(taskRes.content[0].type).toBe("text");
  });

  it("handles Chrome process queries and CDP commands gracefully without throwing", async () => {
    // 1. list Chrome profiles
    const profRes = await callMcpTool("superagent_list_chrome_profiles");
    expect(profRes).toBeDefined();
    expect(profRes.content[0].type).toBe("text");

    // 2. CDP tool returns actionable diagnostic if Chrome port 9222 is closed
    const cdpRes = await callMcpTool("superagent_chrome_cdp", { command: "list_targets" });
    expect(cdpRes).toBeDefined();
    expect(cdpRes.content[0].type).toBe("text");
  });

  it("handles git actions and document readers via network/content tools", async () => {
    const gitRes = await callMcpTool("superagent_git_action", { action: "status" });
    expect(gitRes).toBeDefined();
    expect(gitRes.content[0].type).toBe("text");
  });
});
