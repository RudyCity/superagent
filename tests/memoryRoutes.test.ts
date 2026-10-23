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
  searchAtomic: vi.fn(), exportAtomic: vi.fn(), updateAtomic: vi.fn(), deleteAtomicScoped: vi.fn(),
  previewAtomicRevision: vi.fn(), reviseAtomic: vi.fn(), listAtomicRevisions: vi.fn(), restoreAtomicRevision: vi.fn(),
  inspectAtomic: vi.fn(), reviewAtomic: vi.fn(), reviewAtomicConflictPair: vi.fn(), resolveAtomicConflictPair: vi.fn(),
  previewLegacyAtomicMapping: vi.fn(), mapLegacyAtomicMemory: vi.fn(), markAtomicStale: vi.fn(),
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
    client.previewAtomicRevision.mockReset().mockResolvedValue({ id: "a", scope: "project", currentContent: "before", proposedContent: `[project:${projectAId}] after`, expectedUpdatedAt: "2026-10-18T00:00:00.000Z", revisionNumber: 1, metadata: { scope: "project", projectId: projectAId } });
    client.reviseAtomic.mockReset().mockResolvedValue({ status: "revised", id: "a", updatedAt: "2026-10-18T01:00:00.000Z" });
    client.listAtomicRevisions.mockReset().mockResolvedValue([]);
    client.restoreAtomicRevision.mockReset().mockResolvedValue({ status: "revised", id: "a" });
    client.inspectAtomic.mockReset().mockImplementation(async ({ id, scope }: any) => {
      const record = records.find((item: any) => item.id === id && (scope === "global" ? item.metadata.scope === "global" : item.metadata.projectId === projectAId));
      return record ? { id: record.id, content: record.content, scope, metadata: { ...record.metadata, updatedAt: "2026-10-18T00:00:00.000Z" } } : null;
    });
    client.reviewAtomic.mockReset().mockResolvedValue({ status: "updated" });
    client.reviewAtomicConflictPair.mockReset().mockResolvedValue({ status: "marked_conflicted" });
    client.resolveAtomicConflictPair.mockReset().mockResolvedValue({ status: "resolved" });
    client.previewLegacyAtomicMapping.mockReset().mockResolvedValue({ sourceId: "legacy-row", targetId: "mapped-row", scope: "project", projectId: projectAId, expectedSourceFingerprint: "fingerprint-1", targetExists: false, sourceContent: "old", proposedContent: `[project:${projectAId}] old`, originalPreserved: true });
    client.mapLegacyAtomicMemory.mockReset().mockResolvedValue({ status: "mapped", originalPreserved: true });
    client.markAtomicStale.mockReset().mockResolvedValue({ status: "marked_stale" });
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
    // Use distinct real directories: on Linux a Windows drive path is relative
    // to this repository and resolves to the same enclosing .git project.
    const projectA = path.join(testConfigDir, "project-a");
    const projectB = path.join(testConfigDir, "project-b");
    fs.mkdirSync(projectA);fs.mkdirSync(projectB);
    await invoke("POST", "/api/memory", { key: "same-key", value: "Private fact from project A", scope: "project" }, "", projectA);
    await invoke("POST", "/api/memory", { key: "same-key", value: "Private fact from project B", scope: "project" }, "", projectB);
    await invoke("POST", "/api/memory", { key: "global-key", value: "Global preference", scope: "global" }, "", projectA);

    const sharedFile = path.join(testConfigDir, "shared-memory.json");
    const saved = JSON.parse(fs.readFileSync(sharedFile, "utf8"));
    saved.push({ key: "legacy-unknown", value: "Must not leak into all projects", source: "legacy", timestamp: Date.now(), scope: "project" });
    fs.writeFileSync(sharedFile, JSON.stringify(saved, null, 2));

    const resultA = await invoke("GET", "/api/memory", {}, "", projectA);
    const resultB = await invoke("GET", "/api/memory", {}, "", projectB);
    expect(resultA.response.body.sharedMemory.map((item: any) => item.value)).toContain("Private fact from project A");
    expect(resultA.response.body.sharedMemory.map((item: any) => item.value)).not.toContain("Private fact from project B");
    expect(resultA.response.body.sharedMemory.map((item: any) => item.key)).not.toContain("legacy-unknown");
    expect(resultA.response.body.sharedMemory.map((item: any) => item.key)).toContain("global-key");
    expect(resultB.response.body.sharedMemory.map((item: any) => item.value)).toContain("Private fact from project B");
    expect(resultB.response.body.sharedMemory.map((item: any) => item.value)).not.toContain("Private fact from project A");
  });

  it("uses preview, confirmation and updatedAt for HTTP revision writes", async () => {
    const preview = await invoke("POST", "/api/memory/revise", { action: "preview", id: "a", content: "after" });
    expect(preview.response.status).toBe(200);
    expect(preview.response.body).toMatchObject({ mode: "preview_only", before: "before", expectedUpdatedAt: "2026-10-18T00:00:00.000Z" });
    expect(client.reviseAtomic).not.toHaveBeenCalled();
    const unconfirmed = await invoke("POST", "/api/memory/revise", { action: "apply", id: "a", content: "after", expectedUpdatedAt: "2026-10-18T00:00:00.000Z" });
    expect(unconfirmed.response.status).toBe(400);
    expect(client.reviseAtomic).not.toHaveBeenCalled();
    const stale = await invoke("POST", "/api/memory/revise", { action: "apply", id: "a", content: "after", expectedUpdatedAt: "2026-10-17T00:00:00.000Z", confirm: true });
    expect(stale.response.status).toBe(409);
    expect(client.reviseAtomic).not.toHaveBeenCalled();
    const applied = await invoke("POST", "/api/memory/revise", { action: "apply", id: "a", content: "after", expectedUpdatedAt: "2026-10-18T00:00:00.000Z", confirm: true });
    expect(applied.response.status).toBe(200);
    expect(client.reviseAtomic).toHaveBeenCalledWith(expect.objectContaining({ id: "a", scope: "project", projectId: projectAId, expectedUpdatedAt: "2026-10-18T00:00:00.000Z" }));
  });

  it("requires explicit scope and confirmation for legacy mapping over HTTP", async () => {
    const noScope = await invoke("POST", "/api/memory/review", { action: "preview_legacy_mapping", sourceId: "legacy-row", id: "mapped-row" });
    expect(noScope.response.status).toBe(400);
    expect(client.previewLegacyAtomicMapping).not.toHaveBeenCalled();
    const preview = await invoke("POST", "/api/memory/review", { action: "preview_legacy_mapping", sourceId: "legacy-row", id: "mapped-row", scope: "project" });
    expect(preview.response.status).toBe(200);
    expect(preview.response.body).toMatchObject({ mode: "preview_only", expectedSourceFingerprint: "fingerprint-1", originalPreserved: true });
    const unconfirmed = await invoke("POST", "/api/memory/review", { action: "map_legacy", sourceId: "legacy-row", id: "mapped-row", scope: "project", expectedSourceFingerprint: "fingerprint-1" });
    expect(unconfirmed.response.status).toBe(400);
    expect(client.mapLegacyAtomicMemory).not.toHaveBeenCalled();
    const mapped = await invoke("POST", "/api/memory/review", { action: "map_legacy", sourceId: "legacy-row", id: "mapped-row", scope: "project", expectedSourceFingerprint: "fingerprint-1", confirm: true });
    expect(mapped.response.status).toBe(200);
    expect(client.mapLegacyAtomicMemory).toHaveBeenCalledWith(expect.objectContaining({ scope: "project", projectId: projectAId, expectedSourceFingerprint: "fingerprint-1" }));
  });

  it("keeps retention HTTP preview read-only and requires confirmation before marking stale", async () => {
    const preview = await invoke("POST", "/api/memory/retention-review", { action: "preview" });
    expect(preview.response.status).toBe(200);
    expect(preview.response.body.mode).toBe("preview_only");
    expect(client.markAtomicStale).not.toHaveBeenCalled();
    const unconfirmed = await invoke("POST", "/api/memory/retention-review", { action: "mark_stale", id: "a", scope: "project", expectedUpdatedAt: "2026-10-18T00:00:00.000Z" });
    expect(unconfirmed.response.status).toBe(400);
    expect(client.markAtomicStale).not.toHaveBeenCalled();
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
