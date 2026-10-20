import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { getProjectCapabilityForTool } from "../src/core/project/projectAccessPolicy.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";
import { getMotionProject } from "../src/core/motion/motionService.js";

const dirs: string[] = [];
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "motion-mcp-"));
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  dirs.push(parent);
  return root;
}
afterEach(async () => {
  setFullYoloMode(false); setYoloMode(false);
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const invoke = async (handler: any, name: string, args: Record<string, unknown> = {}) =>
  handler({ method: "tools/call", params: { name, arguments: args } });

describe("Motion MCP integration", () => {
  it("exposes all nine tools with classification and explicit project capabilities", async () => {
    const server = createSuperagentMcpServer();
    const list = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const names = (await list({ method: "tools/list", params: {} })).tools.map((entry: any) => entry.name);
    expect(names.filter((name: string) => name.startsWith("superagent_motion_"))).toHaveLength(9);
    expect(getProjectCapabilityForTool("superagent_motion_create")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_motion_edit")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_motion_render")).toBe("execute");
    expect(getProjectCapabilityForTool("superagent_motion_cancel")).toBe("execute");
    expect(getProjectCapabilityForTool("superagent_motion_status")).toBe("read");
  });

  it("creates and edits using the authorized workspace without losing revision guards", async () => {
    const root = await fixture();
    const server = createSuperagentMcpServer({ workspace: root, allowDangerous: true });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const created = await invoke(call, "superagent_motion_create", { name: "Demo Studio" });
    expect(created.isError, created.content?.[0]?.text).toBeFalsy();
    const project = JSON.parse(created.content[0].text);
    expect(project.workspaceRoot).toBe(await fs.realpath(root));
    const inspect = await invoke(call, "superagent_motion_inspect", { motionId: project.id });
    expect(JSON.parse(inspect.content[0].text).revision).toBe(1);
    const edit = await invoke(call, "superagent_motion_edit", {
      motionId: project.id, baseRevision: 1,
      edits: [{ type: "set-text", layerId: "title", text: "Updated Title" }],
    });
    expect(edit.isError, edit.content?.[0]?.text).toBeFalsy();
    const updated = await getMotionProject(root, project.id);
    expect(updated.revision).toBe(2);
    const stale = await invoke(call, "superagent_motion_edit", {
      motionId: project.id, baseRevision: 1,
      edits: [{ type: "set-text", layerId: "title", text: "Stale" }],
    });
    expect(stale.isError).toBe(true);
  });

  it("rejects out-of-workspace routing through an explicit unauthorized path", async () => {
    const root = await fixture();
    const other = await fixture();
    const server = createSuperagentMcpServer({ workspace: root });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const response = await invoke(call, "superagent_motion_list", { workspace: other });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/outside|not authorized|scope/i);
  });
});
