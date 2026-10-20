import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { readMotionAsset } from "../src/core/motion/assets/motionAssets.js";
import { readMotionAudio } from "../src/core/motion/assets/motionAudio.js";
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
  it("exposes all twelve tools with classification and explicit project capabilities", async () => {
    const server = createSuperagentMcpServer();
    const list = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const names = (await list({ method: "tools/list", params: {} })).tools.map((entry: any) => entry.name);
    expect(names.filter((name: string) => name.startsWith("superagent_motion_"))).toHaveLength(12);
    expect(getProjectCapabilityForTool("superagent_motion_create")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_motion_edit")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_motion_import_image")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_motion_import_audio")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_motion_render")).toBe("execute");
    expect(getProjectCapabilityForTool("superagent_motion_cancel")).toBe("execute");
    expect(getProjectCapabilityForTool("superagent_motion_status")).toBe("read");
    expect(getProjectCapabilityForTool("superagent_motion_storage")).toBe("read");
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

  it("imports canonical image assets through a write-scoped tool, rejecting malformed data and foreign workspace paths", async () => {
    const root = await fixture();
    const other = await fixture();
    const server = createSuperagentMcpServer({ workspace: root, allowDangerous: true });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const canvas = createCanvas(4, 4);
    canvas.getContext("2d").fillRect(0, 0, 4, 4);
    const base64 = canvas.toBuffer("image/png").toString("base64");
    const imported = await invoke(call, "superagent_motion_import_image", { base64 });
    expect(imported.isError, imported.content?.[0]?.text).toBeFalsy();
    const asset = JSON.parse(imported.content[0].text);
    expect(asset.id).toMatch(/^asset-[0-9a-f]{64}$/);
    expect(await readMotionAsset(root, asset.id)).toHaveLength(asset.bytes);
    const invalid = await invoke(call, "superagent_motion_import_image", { base64: "../invalid" });
    expect(invalid.isError).toBe(true);
    const invalidAudio = await invoke(call, "superagent_motion_import_audio", { base64 });
    expect(invalidAudio.isError).toBe(true);
    const wav = Buffer.alloc(44 + 1600 * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    const acceptedAudio = await invoke(call, "superagent_motion_import_audio", { base64: wav.toString("base64") });
    expect(acceptedAudio.isError, acceptedAudio.content?.[0]?.text).toBeFalsy();
    const clip = JSON.parse(acceptedAudio.content[0].text);
    expect(clip.id).toMatch(/^audio-[0-9a-f]{64}$/);
    expect(await readMotionAudio(root, clip.id)).toEqual(wav);
    await expect(invoke(call, "superagent_motion_import_image", { base64, workspace: other }))
      .rejects.toThrow(/scope|outside|not authorized/i);
    await expect(readMotionAsset(other, asset.id)).rejects.toThrow();
  });

  it("exposes only read-only job storage stats to unprivileged MCP clients", async () => {
    const root = await fixture();
    const server = createSuperagentMcpServer({ workspace: root });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const result = await invoke(call, "superagent_motion_storage", { minAgeDays: 12 });
    expect(result.isError, result.content?.[0]?.text).toBeFalsy();
    const state = JSON.parse(result.content[0].text);
    expect(state.maintenance.minAgeDays).toBe(12);
    expect(state.jobs.total).toBe(0);
    expect(state).not.toHaveProperty("deletedJobIds");
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
