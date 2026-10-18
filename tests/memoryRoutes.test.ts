import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";
import { handleServerRoute } from "../src/serverRoutes.js";

const projectAId = "p_project_a";
const records = [
  { id: "a", content: `[project:${projectAId}] Project A decision`, type: "decision", score: 0.9, metadata: { type: "memory", scope: "project", projectId: projectAId } },
  { id: "b", content: "[project:p_project_b] Private project B data", type: "decision", score: 0.8, metadata: { type: "memory", scope: "project", projectId: "p_project_b" } },
  { id: "g", content: "[global] User prefers concise replies", type: "preference", score: 0.7, metadata: { type: "memory", scope: "global" } },
  { id: "legacy", content: "[project] Ambiguous legacy record", type: "memory", score: 0.6, metadata: {} },
];

const client = {
  searchAtomic: vi.fn(),
  exportAtomic: vi.fn(),
  updateAtomic: vi.fn(),
  deleteAtomicScoped: vi.fn(),
};

function makeContext(workspace = "D:/repos/project-a") {
  const response: { status?: number; body?: any } = {};
  const sendJSON = vi.fn((_res: any, status: number, body: any) => {
    response.status = status;
    response.body = body;
  });
  return {
    response,
    sendJSON,
    ctx: {
      lastActiveWorkspace: workspace,
      resolveWorkspacePath: vi.fn(() => workspace),
      sendJSON,
      readBody: vi.fn(async (req: any) => req.body || "{}"),
    } as any,
  };
}

async function invoke(method: string, pathname: string, body: unknown = {}, query = "", workspace = "D:/repos/project-a") {
  const { ctx, response, sendJSON } = makeContext(workspace);
  const req = { method, body: JSON.stringify(body) } as any;
  const handled = await handleServerRoute(
    req,
    {} as any,
    pathname,
    new URL(`http://localhost${pathname}${query}`),
    ctx,
  );
  return { handled, response, sendJSON };
}

describe("HTTP RMemory project-scope boundary", () => {
  const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  let testConfigDir = "";

  beforeEach(() => {
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-memory-routes-"));
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;
    vi.restoreAllMocks();
    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue(client as any);
    vi.spyOn(rmemoryUtilModule, "isRmemoryActive").mockResolvedValue(true);
    vi.spyOn(rmemoryUtilModule, "getRMemoryProjectId").mockReturnValue(projectAId);
    client.searchAtomic.mockReset().mockResolvedValue({ items: records });
    client.exportAtomic.mockReset().mockResolvedValue({ total: records.length, truncated: false, items: records });
    client.updateAtomic.mockReset().mockResolvedValue({ id: "saved", updated_at: "2026-10-18T00:00:00.000Z" });
    client.deleteAtomicScoped.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
  });

  it("lists only the active project's memories plus global records, excluding ambiguous legacy rows", async () => {
    const result = await invoke("GET", "/api/memory");
    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    const items = result.response.body.memory;
    expect(items.map((item: any) => item.id)).toEqual(["a", "g"]);
    expect(client.exportAtomic).toHaveBeenCalledWith({ projectId: projectAId, includeGlobal: true, limit: 50 });
  });

  it("keeps query search within the active project/global scope without substring-only post-filtering", async () => {
    client.searchAtomic.mockResolvedValue({ items: [records[0], records[1], records[2], records[3]] });
    const result = await invoke("GET", "/api/memory", {}, "?query=architecture%20pattern");
    expect(client.searchAtomic).toHaveBeenCalledWith({ query: "architecture pattern", limit: 50, projectId: projectAId });
    expect(result.response.body.memory.map((item: any) => item.id)).toEqual(["a", "g"]);
  });

  it("saves atomic memories with server-derived project scope and versioned provenance metadata", async () => {
    const result = await invoke("POST", "/api/memory/save", {
      id: "service-choice", content: "Use TypeScript", type: "decision",
      scope: "project", projectId: "client-must-not-control-this",
    });
    expect(result.response.status).toBe(200);
    const saved = client.updateAtomic.mock.calls[0][0];
    expect(saved.id).toBe("service-choice");
    expect(saved.content).toBe(`[project:${projectAId}] Use TypeScript`);
    expect(saved.metadata).toMatchObject({
      schemaVersion: 1, type: "memory", memoryType: "decision", scope: "project",
      projectId: projectAId, validationStatus: "unverified", provenance: { source: "api_memory_save" },
    });
  });


  it("keeps same-key shared memories isolated by canonical project and quarantines ambiguous legacy rows", async () => {
    await invoke("POST", "/api/memory", { key: "same-key", value: "Private fact from project A", scope: "project" }, "", "D:/repos/project-a");
    await invoke("POST", "/api/memory", { key: "same-key", value: "Private fact from project B", scope: "project" }, "", "D:/repos/project-b");
    await invoke("POST", "/api/memory", { key: "global-key", value: "Global preference", scope: "global" }, "", "D:/repos/project-a");

    const sharedFile = path.join(testConfigDir, "shared-memory.json");
    const saved = JSON.parse(fs.readFileSync(sharedFile, "utf8"));
    saved.push({ key: "legacy-unknown", value: "Must not leak into all projects", source: "legacy", timestamp: Date.now(), scope: "project" });
    fs.writeFileSync(sharedFile, JSON.stringify(saved, null, 2));

    const projectA = await invoke("GET", "/api/memory", {}, "", "D:/repos/project-a");
    const projectB = await invoke("GET", "/api/memory", {}, "", "D:/repos/project-b");
    expect(projectA.response.body.sharedMemory.map((item: any) => item.value)).toContain("Private fact from project A");
    expect(projectA.response.body.sharedMemory.map((item: any) => item.value)).not.toContain("Private fact from project B");
    expect(projectA.response.body.sharedMemory.map((item: any) => item.key)).not.toContain("legacy-unknown");
    expect(projectA.response.body.sharedMemory.map((item: any) => item.key)).toContain("global-key");
    expect(projectB.response.body.sharedMemory.map((item: any) => item.value)).toContain("Private fact from project B");
    expect(projectB.response.body.sharedMemory.map((item: any) => item.value)).not.toContain("Private fact from project A");
  });

  it("does not overwrite global or another project's memory through project-scoped delete", async () => {
    const denied = await invoke("DELETE", "/api/memory/delete", { id: "service-choice" });
    expect(denied.response.status).toBe(400);
    expect(client.deleteAtomicScoped).not.toHaveBeenCalled();

    const deleted = await invoke("DELETE", "/api/memory/delete", { id: "service-choice", confirm: true });
    expect(deleted.response.status).toBe(200);
    expect(client.deleteAtomicScoped).toHaveBeenCalledWith({ id: "service-choice", scope: "project", projectId: projectAId });
    expect(deleted.response.body.deletedIds).toEqual(["service-choice"]);

    await invoke("DELETE", "/api/memory/delete", { ids: ["global-pref"], scope: "global", confirm: true });
    expect(client.deleteAtomicScoped).toHaveBeenLastCalledWith({ id: "global-pref", scope: "global", projectId: projectAId });
  });
});
