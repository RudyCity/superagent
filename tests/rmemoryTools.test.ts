import { describe, it, expect, vi, beforeEach, mock, afterAll } from "vitest";
import path from "path";
import os from "os";
import {
  rmemoryStatusTool,
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
  rmemoryInspectTool,
  rmemoryExportTool,
  rmemoryDeleteTool,
  rmemoryMigrateLegacyTool,
  rmemoryReviseTool,
  rmemoryMemoryReviewTool,
  rmemoryRetentionReviewTool,
  rmemoryTaskSummaryTool,
} from "../src/core/tools/rmemoryTools.js";

const mockAddConversation = vi.fn();
const mockSearchAtomic = vi.fn();
const mockSearchConversation = vi.fn();
const mockReadFile = vi.fn();
const mockUpdateAtomic = vi.fn();
const mockReadScenario = vi.fn();
const mockInspectAtomic = vi.fn();
const mockExportAtomic = vi.fn();
const mockDeleteAtomicScoped = vi.fn();
const mockMigrateLegacyAtomicMemories = vi.fn();
const mockPreviewAtomicRevision = vi.fn();
const mockReviseAtomic = vi.fn();
const mockListAtomicRevisions = vi.fn();
const mockRestoreAtomicRevision = vi.fn();
const mockReviewAtomic = vi.fn();
const mockMarkAtomicStale = vi.fn();
const mockPreviewLegacyAtomicMapping = vi.fn();
const mockMapLegacyAtomicMemory = vi.fn();
const mockReviewAtomicConflictPair = vi.fn();
const mockResolveAtomicConflictPair = vi.fn();

import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";

describe("RMemory Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue({
      addConversation: (...args: any[]) => mockAddConversation(...args),
      searchAtomic: (...args: any[]) => mockSearchAtomic(...args),
      searchConversation: (...args: any[]) => mockSearchConversation(...args),
      readFile: (...args: any[]) => mockReadFile(...args),
      updateAtomic: (...args: any[]) => mockUpdateAtomic(...args),
      readScenario: (...args: any[]) => mockReadScenario(...args),
      inspectAtomic: (...args: any[]) => mockInspectAtomic(...args),
      exportAtomic: (...args: any[]) => mockExportAtomic(...args),
      deleteAtomicScoped: (...args: any[]) => mockDeleteAtomicScoped(...args),
      migrateLegacyAtomicMemories: (...args: any[]) => mockMigrateLegacyAtomicMemories(...args),
      previewAtomicRevision: (...args: any[]) => mockPreviewAtomicRevision(...args),
      reviseAtomic: (...args: any[]) => mockReviseAtomic(...args),
      listAtomicRevisions: (...args: any[]) => mockListAtomicRevisions(...args),
      restoreAtomicRevision: (...args: any[]) => mockRestoreAtomicRevision(...args),
      reviewAtomic: (...args: any[]) => mockReviewAtomic(...args),
      reviewAtomicConflictPair: (...args: any[]) => mockReviewAtomicConflictPair(...args),
      resolveAtomicConflictPair: (...args: any[]) => mockResolveAtomicConflictPair(...args),
      markAtomicStale: (...args: any[]) => mockMarkAtomicStale(...args),
      previewLegacyAtomicMapping: (...args: any[]) => mockPreviewLegacyAtomicMapping(...args),
      mapLegacyAtomicMemory: (...args: any[]) => mockMapLegacyAtomicMemory(...args),
    } as any);
    vi.spyOn(rmemoryUtilModule, "getRMemorySessionKey").mockReturnValue("test-sess");
    vi.spyOn(rmemoryUtilModule, "isRmemoryActive").mockResolvedValue(true);
  });
  it("should define tool metadata", () => {
    expect(rmemoryStatusTool.name).toBe("rmemory_status");
    expect(rmemorySearchTool.name).toBe("rmemory_search");
    expect(rmemoryConversationSearchTool.name).toBe("rmemory_conversation_search");
    expect(rmemoryReadCosTool.name).toBe("rmemory_read_cos");
    expect(rmemoryMigrateLegacyTool.name).toBe("rmemory_migrate_legacy");
    expect(rmemoryReviseTool.name).toBe("rmemory_revise");
    expect(rmemoryMemoryReviewTool.name).toBe("rmemory_review");
    expect(rmemoryRetentionReviewTool.name).toBe("rmemory_retention_review");
    expect(rmemoryTaskSummaryTool.name).toBe("rmemory_task_summary");
  });

  it("returns only safe read-only RMemory diagnostics", async () => {
    vi.spyOn(rmemoryUtilModule, "getRMemoryDiagnostics").mockReturnValue({
      enabled: true, provider: "local", modelName: "Xenova/all-MiniLM-L6-v2", dimensions: 384,
      indexReady: false, initializationState: "degraded", migrationStatus: "failed",
      degraded: true, retryAvailable: true, error: "Embedding model health check failed.",
    });
    const result = JSON.parse(await rmemoryStatusTool.execute({}, process.cwd()) as string);
    expect(result.initializationState).toBe("degraded");
    expect(result.retryAvailable).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/api.?key|Bearer|C:\\\\|\/home\//i);
  });

  it("defaults legacy memory migration to a read-only preview for an authorized agent", async () => {
    const { agentLocalStorage } = await import("../src/core/agent.js");
    mockMigrateLegacyAtomicMemories.mockResolvedValue({ dryRun: true, scanned: 4, candidates: 1, migrated: 0, skipped: 0, failed: 0, items: [{ id: "legacy-note", scope: "project", status: "would_migrate" }] });
    const agent = { tier: "master" } as any;
    const result = await agentLocalStorage.run(agent, () => rmemoryMigrateLegacyTool.execute({}, process.cwd()));

    expect(JSON.parse(result as string).mode).toBe("preview_only");
    expect(mockMigrateLegacyAtomicMemories).toHaveBeenCalledWith({
      projectId: rmemoryUtilModule.getRMemoryProjectId(process.cwd()),
      includeGlobal: true,
      limit: 100,
      dryRun: true,
    });
  });

  it("fails closed on requested migration when interactive owner confirmation is unavailable", async () => {
    const { agentLocalStorage } = await import("../src/core/agent.js");
    mockMigrateLegacyAtomicMemories.mockResolvedValue({ dryRun: true, scanned: 3, candidates: 1, migrated: 0, skipped: 0, failed: 0, items: [{ id: "legacy-note", scope: "project", status: "would_migrate" }] });
    const agent = { tier: "master" } as any;
    const result = await agentLocalStorage.run(agent, () => rmemoryMigrateLegacyTool.execute({ dryRun: false }, process.cwd()));

    expect(result).toContain("interactive owner confirmation");
    expect(mockMigrateLegacyAtomicMemories).toHaveBeenCalledTimes(1);
    expect(mockMigrateLegacyAtomicMemories).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  describe("memory lifecycle tools", () => {
    it("inspects one scoped memory and filters metadata to the documented safe fields", async () => {
      mockInspectAtomic.mockResolvedValue({
        id: "architecture-decision",
        content: "Use TypeScript for the service",
        scope: "project",
        metadata: {
          schemaVersion: 1, memoryId: "architecture-decision", memoryType: "decision", scope: "project", projectId: "p_test",
          sessionId: "session-safe", taskId: "task-safe", validationStatus: "unverified", updatedAt: "2026-10-18T08:00:00.000Z",
          evidence: [{ id: "test-7", kind: "test", status: "passed", reference: "private-secret-file.txt" }],
          provenance: { source: "rmemory_save", agentTier: "master", accessToken: "must-not-leak" },
          accessToken: "must-not-leak",
        },
      });

      const result = JSON.parse(await rmemoryInspectTool.execute({ id: "architecture-decision" }, ".") as string);
      expect(result.content).toBe("Use TypeScript for the service");
      expect(result.metadata.scope).toBe("project");
      expect(result.metadata.memoryId).toBe("architecture-decision");
      expect(result.metadata.taskId).toBe("task-safe");
      expect(result.metadata.evidence).toEqual([{ id: "test-7", kind: "test", status: "passed" }]);
      expect(result.metadata.provenance.source).toBe("rmemory_save");
      expect(JSON.stringify(result)).not.toContain("private-secret-file.txt");
      expect(JSON.stringify(result)).not.toContain("must-not-leak");
      expect(mockInspectAtomic).toHaveBeenCalledWith({ id: "architecture-decision", scope: "project", projectId: expect.any(String) });
    });

    it("exports only safe metadata and passes active-project scope and the caller's limit", async () => {
      mockExportAtomic.mockResolvedValue({
        total: 2,
        truncated: false,
        items: [{
          id: "decision", content: "[project:p_test] Decision", scope: "project",
          metadata: { scope: "project", projectId: "p_test", schemaVersion: 1, provenance: { source: "rmemory_save", apiKey: "must-not-leak" }, apiKey: "must-not-leak" },
        }],
      });
      const { agentLocalStorage } = await import("../src/core/agent.js");
      const fakeAgent = { tier: "master" } as any;
      const result = await agentLocalStorage.run(fakeAgent, () => rmemoryExportTool.execute({ limit: 25 }, "."));
      const payload = JSON.parse(result as string);
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0].metadata.provenance.source).toBe("rmemory_save");
      expect(JSON.stringify(payload)).not.toContain("must-not-leak");
      expect(mockExportAtomic).toHaveBeenCalledWith({ projectId: expect.any(String), includeGlobal: true, limit: 25 });
    });

    it("requires interactive confirmation before deleting a scoped memory", async () => {
      const { agentLocalStorage } = await import("../src/core/agent.js");
      const deniedAgent = { tier: "master", onQuestion: vi.fn().mockResolvedValue("No") } as any;
      const cancelled = await agentLocalStorage.run(deniedAgent, () => rmemoryDeleteTool.execute({ id: "do-not-delete" }, "."));
      expect(cancelled).toContain("cancelled");
      expect(mockDeleteAtomicScoped).not.toHaveBeenCalled();

      const approvedAgent = { tier: "master", onQuestion: vi.fn().mockResolvedValue("Yes") } as any;
      mockDeleteAtomicScoped.mockResolvedValue(true);
      const deleted = await agentLocalStorage.run(approvedAgent, () => rmemoryDeleteTool.execute({ id: "delete-me", scope: "global" }, "."));
      expect(deleted).toContain("Deleted global-scope memory");
      expect(mockDeleteAtomicScoped).toHaveBeenCalledWith({ id: "delete-me", scope: "global", projectId: expect.any(String) });
    });
  });

  describe("memory review and recoverable revision", () => {
    it("previews revisions without writes and requires fresh owner confirmation before apply", async () => {
      const { agentLocalStorage } = await import("../src/core/agent.js");
      mockPreviewAtomicRevision.mockResolvedValue({ id: "deploy-target", scope: "project", currentContent: "old target", proposedContent: "new target", expectedUpdatedAt: "2026-10-18T08:00:00.000Z", revisionNumber: 1, metadata: { scope: "project", projectId: "p_test", validationStatus: "verified" } });
      const previewAgent = { tier: "master" } as any;
      const preview = await agentLocalStorage.run(previewAgent, () => rmemoryReviseTool.execute({ action: "preview", id: "deploy-target", content: "new target" }, "."));
      expect(JSON.parse(preview as string)).toMatchObject({ mode: "preview_only", before: "old target", after: "new target" });
      expect(mockReviseAtomic).not.toHaveBeenCalled();

      const approvedAgent = { tier: "master", onQuestion: vi.fn().mockResolvedValue("Yes") } as any;
      mockReviseAtomic.mockResolvedValue({ status: "revised", id: "deploy-target", revisionNumber: 2 });
      const applied = await agentLocalStorage.run(approvedAgent, () => rmemoryReviseTool.execute({ action: "apply", id: "deploy-target", content: "new target", expectedUpdatedAt: "2026-10-18T08:00:00.000Z" }, "."));
      expect(JSON.parse(applied as string).status).toBe("revised");
      expect(approvedAgent.onQuestion).toHaveBeenCalledOnce();
      expect(mockReviseAtomic).toHaveBeenCalledWith(expect.objectContaining({ id: "deploy-target", expectedUpdatedAt: "2026-10-18T08:00:00.000Z", content: "new target" }));
    });

    it("fails closed when there is no persisted matching completed task event", async () => {
      const { agentLocalStorage } = await import("../src/core/agent.js");
      const agent = { tier: "master" } as any;
      const result = await agentLocalStorage.run(agent, () => rmemoryTaskSummaryTool.execute({ action: "save", taskId: "missing-task-for-memory-summary", terminalEventId: "missing-terminal-event" }, process.cwd()));
      expect(result).toContain("No matching persisted task_completed event");
      expect(mockUpdateAtomic).not.toHaveBeenCalled();
    });

    it("retention preview is read-only and does not propose durable memories for age-only expiry", async () => {
      const { agentLocalStorage } = await import("../src/core/agent.js");
      mockExportAtomic.mockResolvedValue({ total: 2, truncated: false, items: [
        { id: "expired-incident", content: "incident", scope: "project", metadata: { scope: "project", projectId: "p_test", retentionClass: "temporary", updatedAt: "2026-01-01T00:00:00.000Z" } },
        { id: "durable-pref", content: "pref", scope: "global", metadata: { scope: "global", retentionClass: "durable", validationStatus: "verified", updatedAt: "2026-01-01T00:00:00.000Z" } },
      ] });
      const agent = { tier: "master" } as any;
      const result = JSON.parse(await agentLocalStorage.run(agent, () => rmemoryRetentionReviewTool.execute({ action: "preview" }, ".") as Promise<string>));
      expect(result.mode).toBe("preview_only");
      expect(result.items.map((item: any) => item.id)).toEqual(["expired-incident"]);
      expect(mockMarkAtomicStale).not.toHaveBeenCalled();
    });

    it("requires explicit scope when previewing ambiguous legacy mapping and confirms before applying", async () => {
      const { agentLocalStorage } = await import("../src/core/agent.js");
      mockPreviewLegacyAtomicMapping.mockResolvedValue({ sourceId: "legacy-1", targetId: "mapped-1", scope: "project", projectId: rmemoryUtilModule.getRMemoryProjectId("."), sourceContent: "[project] old note", proposedContent: `[project:${rmemoryUtilModule.getRMemoryProjectId(".")}] old note`, expectedSourceFingerprint: "fingerprint-1", targetExists: false, originalPreserved: true });
      const agent = { tier: "master" } as any;
      const missingScope = await agentLocalStorage.run(agent, () => rmemoryMemoryReviewTool.execute({ action: "preview_legacy_mapping", sourceId: "legacy-1" }, "."));
      expect(missingScope).toContain("explicitly choose project or global scope");
      expect(mockPreviewLegacyAtomicMapping).not.toHaveBeenCalled();

      const preview = await agentLocalStorage.run(agent, () => rmemoryMemoryReviewTool.execute({ action: "preview_legacy_mapping", sourceId: "legacy-1", id: "mapped-1", scope: "project" }, "."));
      expect(JSON.parse(preview as string)).toMatchObject({ mode: "preview_only", expectedSourceFingerprint: "fingerprint-1", originalPreserved: true });
      expect(mockMapLegacyAtomicMemory).not.toHaveBeenCalled();

      const approved = { tier: "master", onQuestion: vi.fn().mockResolvedValue("Yes") } as any;
      mockMapLegacyAtomicMemory.mockResolvedValue({ status: "mapped", sourceId: "legacy-1", targetId: "mapped-1", originalPreserved: true });
      const mapped = await agentLocalStorage.run(approved, () => rmemoryMemoryReviewTool.execute({ action: "map_legacy", sourceId: "legacy-1", id: "mapped-1", scope: "project", expectedSourceFingerprint: "fingerprint-1" }, "."));
      expect(JSON.parse(mapped as string)).toMatchObject({ status: "mapped", originalPreserved: true });
      expect(approved.onQuestion).toHaveBeenCalledOnce();
      expect(mockMapLegacyAtomicMemory).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "legacy-1", targetId: "mapped-1", scope: "project", expectedSourceFingerprint: "fingerprint-1" }));
    });

    it("shows same-scope keyed conflicts as review candidates only", async () => {
      const { agentLocalStorage } = await import("../src/core/agent.js");
      mockExportAtomic.mockResolvedValue({ total: 2, truncated: false, items: [
        { id: "runtime-a", content: "Node 20", scope: "project", metadata: { scope: "project", projectId: "p-a", assertionKey: "node-version" } },
        { id: "runtime-b", content: "Node 22", scope: "project", metadata: { scope: "project", projectId: "p-a", assertionKey: "node-version" } },
      ] });
      const agent = { tier: "master" } as any;
      const result = JSON.parse(await agentLocalStorage.run(agent, () => rmemoryMemoryReviewTool.execute({ action: "conflicts" }, ".") as Promise<string>));
      expect(result.mode).toBe("review_preview_only");
      expect(result.conflicts).toHaveLength(1);
      expect(mockReviewAtomic).not.toHaveBeenCalled();
    });
  });

  describe("rmemory_search", () => {
    it("should successfully search structured memories", async () => {
      mockSearchAtomic.mockResolvedValue({
        items: [
          {
            id: "1",
            content: "[global] User likes dark mode",
            type: "persona",
            metadata: {
              scope: "global", schemaVersion: 1, validationStatus: "unverified",
              updatedAt: "2026-10-18T08:00:00.000Z", provenance: { source: "rmemory_save" },
            },
          }
        ]
      });

      const result = await rmemorySearchTool.execute({ query: "preferences" }, ".");
      expect(result).toContain("- [persona] [global] User likes dark mode");
      expect(result).toContain("scope=global");
      expect(result).toContain("schemaVersion=1");
      expect(result).toContain("validation=unverified");
      expect(result).toContain("source=rmemory_save");
      expect(mockSearchAtomic).toHaveBeenCalledWith(expect.objectContaining({
        query: "preferences",
        limit: 10,
        projectId: expect.any(String),
      }));
    });

    it("withholds explicit same-key conflicts and cross-project matches from memory search", async () => {
      const projectId = rmemoryUtilModule.getRMemoryProjectId(".");
      mockSearchAtomic.mockResolvedValue({ items: [
        { id: "runtime-a", content: `[project:${projectId}] Runtime is Node 20`, type: "decision", metadata: { scope: "project", projectId, assertionKey: "runtime-node-version", validationStatus: "verified" } },
        { id: "runtime-b", content: `[project:${projectId}] Runtime is Node 22`, type: "decision", metadata: { scope: "project", projectId, assertionKey: "runtime-node-version", validationStatus: "verified" } },
        { id: "foreign", content: "Other project secret", type: "decision", metadata: { scope: "project", projectId: "p_other_project", validationStatus: "verified" } },
      ] });
      const result = await rmemorySearchTool.execute({ query: "runtime" }, ".");
      expect(result).not.toContain("Runtime is Node 20");
      expect(result).not.toContain("Runtime is Node 22");
      expect(result).not.toContain("Other project secret");
      expect(result).toContain("2 scoped record(s) were withheld");
      expect(result).toContain("1 explicit same-key conflict pair");
    });

    it("should return fallback message if no memories found", async () => {
      mockSearchAtomic.mockResolvedValue({ items: [] });
      const result = await rmemorySearchTool.execute({ query: "preferences" }, ".");
      expect(result).toBe("No memories found matching the query.");
    });

    it("should handle error when gateway fails", async () => {
      mockSearchAtomic.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemorySearchTool.execute({ query: "preferences" }, ".");
      expect(result).toContain("Memory search failed");
    });
  });

  describe("rmemory_conversation_search", () => {
    it("should successfully search conversation history", async () => {
      mockSearchConversation.mockResolvedValue({
        messages: [
          { role: "user", content: "hello world", timestamp: "2026-06-24T00:00:00.000Z", project_id: rmemoryUtilModule.getRMemoryProjectId(".") },
          { role: "user", content: "other project secret", timestamp: "2026-06-24T00:00:00.000Z", project_id: "p_other_project" },
        ]
      });

      const result = await rmemoryConversationSearchTool.execute({ query: "hello" }, ".");
      expect(result).toContain("user: hello world");
      expect(result).not.toContain("other project secret");
      expect(mockSearchConversation).toHaveBeenCalledWith(expect.objectContaining({ query: "hello", limit: 10, projectId: rmemoryUtilModule.getRMemoryProjectId(".") }));
    });

    it("should handle error when gateway fails", async () => {
      mockSearchConversation.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemoryConversationSearchTool.execute({ query: "hello" }, ".");
      expect(result).toContain("Conversation search failed");
    });
  });

  describe("rmemory_read_cos", () => {
    it("should successfully read scenario file content", async () => {
      mockReadScenario.mockResolvedValue({
        path: "scene_blocks/style.md",
        content: "Coding style: use tabs instead of spaces",
        created_at: "2026-06-26T10:00:00.000Z",
        updated_at: "2026-06-26T10:00:00.000Z"
      });
      const result = await rmemoryReadCosTool.execute({ path: "scene_blocks/style.md" }, ".");
      expect(result).toContain("SCENARIO BLOCK FILE: scene_blocks/style.md");
      expect(result).toContain("use tabs instead of spaces");
      expect(mockReadScenario).toHaveBeenCalledWith({ path: "scene_blocks/style.md" });
    });

    it("should return error message when file is not found (content is null)", async () => {
      mockReadScenario.mockResolvedValue({
        path: "scene_blocks/style.md",
        content: null,
        created_at: null,
        updated_at: null
      });
      const result = await rmemoryReadCosTool.execute({ path: "scene_blocks/style.md" }, ".");
      expect(result).toContain("Failed to read scenario block file: File not found");
    });

    it("should handle error when file read fails", async () => {
      mockReadScenario.mockRejectedValue(new Error("Network error"));
      const result = await rmemoryReadCosTool.execute({ path: "scene_blocks/style.md" }, ".");
      expect(result).toContain("Failed to read scenario block file");
    });
  });

  describe("rmemory_save", () => {
    it("should successfully save memory with upsert and default project scope", async () => {
      mockUpdateAtomic.mockResolvedValue({
        id: "user-identity",
        updated_at: "2026-06-26T10:00:00.000Z",
      });

      const result = await rmemorySaveTool.execute(
        { id: "user-identity", content: "User name is Rudy", type: "identity" },
        "."
      );
      expect(result).toContain("Memory saved successfully");
      expect(result).toContain("user-identity");
      const payload = mockUpdateAtomic.mock.calls[0][0];
      expect(payload.id).toBe("user-identity");
      expect(payload.content).toMatch(/^\[project:p_[a-f0-9]{16}\] User name is Rudy$/);
      expect(payload.metadata).toMatchObject({
        schemaVersion: 1,
        type: "memory",
        memoryType: "identity",
        scope: "project",
        projectId: expect.stringMatching(/^p_[a-f0-9]{16}$/),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        validationStatus: "unverified",
        provenance: { source: "rmemory_save", agentTier: "unknown" },
      });
    });

    it("should save memory with explicit global scope", async () => {
      mockUpdateAtomic.mockResolvedValue({
        id: "global-pref",
        updated_at: "2026-06-26T10:00:00.000Z",
      });

      const result = await rmemorySaveTool.execute(
        { id: "global-pref", content: "Prefer dark mode", scope: "global" },
        "."
      );
      expect(result).toContain("Memory saved successfully (global scope)");
      const payload = mockUpdateAtomic.mock.calls[0][0];
      expect(payload).toMatchObject({
        id: "global-pref",
        content: "[global] Prefer dark mode",
        metadata: {
          schemaVersion: 1,
          type: "memory",
          memoryType: "fact",
          scope: "global",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          validationStatus: "unverified",
          provenance: { source: "rmemory_save", agentTier: "unknown" },
        },
      });
    });

    it("should save memory without type", async () => {
      mockUpdateAtomic.mockResolvedValue({
        id: "simple-note",
        updated_at: "2026-06-26T10:00:00.000Z",
      });

      const result = await rmemorySaveTool.execute(
        { id: "simple-note", content: "A simple note" },
        "."
      );
      expect(result).toContain("Memory saved successfully");
      const payload = mockUpdateAtomic.mock.calls[0][0];
      expect(payload.id).toBe("simple-note");
      expect(payload.content).toMatch(/^\[project:p_[a-f0-9]{16}\] A simple note$/);
      expect(payload.metadata.scope).toBe("project");
    });

    it("should handle error when gateway fails", async () => {
      mockUpdateAtomic.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemorySaveTool.execute({ id: "test", content: "test" }, ".");
      expect(result).toContain("Failed to save memory");
    });
  });

  it("isolates project memories for repositories with identical basenames", async () => {
    const fixtureRoot = path.join(os.tmpdir(), `rmemory-scope-${Date.now()}`);
    const projectA = path.join(fixtureRoot, "tenant-a", "same-project");
    const projectB = path.join(fixtureRoot, "tenant-b", "same-project");

    mockUpdateAtomic.mockResolvedValue({ id: "saved", updated_at: new Date().toISOString() });
    await rmemorySaveTool.execute({ id: "private-a", content: "Project A private implementation detail" }, projectA);
    const savedA = mockUpdateAtomic.mock.calls[0][0];
    await rmemorySaveTool.execute({ id: "private-b", content: "Project B private implementation detail" }, projectB);
    const savedB = mockUpdateAtomic.mock.calls[1][0];

    expect(savedA.metadata.projectId).not.toBe(savedB.metadata.projectId);
    mockSearchAtomic.mockResolvedValue({ items: [
      { id: "a", content: savedA.content, metadata: savedA.metadata, type: "memory" },
      { id: "b", content: savedB.content, metadata: savedB.metadata, type: "memory" },
      { id: "global", content: "[global] User prefers concise reports", metadata: { scope: "global" }, type: "memory" },
      { id: "legacy", content: "[project] legacy project-only record", metadata: { type: "memory" }, type: "memory" },
    ] });

    const result = await rmemorySearchTool.execute({ query: "implementation detail", projectOnly: true }, projectA);
    expect(result).toContain("Project A private implementation detail");
    expect(result).toContain("User prefers concise reports");
    expect(result).not.toContain("Project B private implementation detail");
    expect(result).not.toContain("legacy project-only record");
    expect(mockSearchAtomic).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: savedA.metadata.projectId,
    }));
  });

  describe("rmemory_conversation_add", () => {
    it("should successfully add conversation message", async () => {
      mockAddConversation.mockResolvedValue({
        accepted_ids: ["msg-1"],
        total_count: 5,
      });

      const result = await rmemoryConversationAddTool.execute(
        { session_id: "session-1", role: "user", content: "Hello" },
        "."
      );
      expect(result).toContain("Conversation message added");
      expect(result).toContain("msg-1");
      expect(mockAddConversation).toHaveBeenCalledWith({
        session_id: "session-1",
        projectId: rmemoryUtilModule.getRMemoryProjectId("."),
        messages: [{ role: "user", content: "Hello", timestamp: expect.any(String) }],
      });
    });

    it("should handle error when gateway fails", async () => {
      mockAddConversation.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemoryConversationAddTool.execute(
        { session_id: "session-1", role: "user", content: "Hello" },
        "."
      );
      expect(result).toContain("Failed to add conversation message");
    });
  });

  afterAll(() => {});
});
