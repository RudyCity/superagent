import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { ChatLine } from "../src/core/slash-commands.js";

// Mock the rmemoryUtil module
const mockClient = {
  readCore: vi.fn(),
  queryAtomic: vi.fn(),
  searchAtomic: vi.fn(),
  updateAtomic: vi.fn(),
  deleteAtomic: vi.fn(),
  deleteAtomicScoped: vi.fn(),
  listScenarios: vi.fn(),
  readScenario: vi.fn(),
  previewAtomicRevision: vi.fn(), reviseAtomic: vi.fn(), listAtomicRevisions: vi.fn(), restoreAtomicRevision: vi.fn(),
  inspectAtomic: vi.fn(), exportAtomic: vi.fn(), reviewAtomic: vi.fn(), reviewAtomicConflictPair: vi.fn(),
  resolveAtomicConflictPair: vi.fn(), previewLegacyAtomicMapping: vi.fn(), mapLegacyAtomicMemory: vi.fn(), markAtomicStale: vi.fn(),
};

import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";
const { handleSlashCommand } = await import("../src/core/slash-commands.js");
const { updateSettings, getSettings } = await import("../src/core/config/jsonConfig.js");

describe("/memory Command Suite", () => {
  const originalEnv = process.env;
  const tempConfigDir = path.join(os.tmpdir(), `superagent-memory-test-${process.pid}`);

  beforeAll(async () => {
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: tempConfigDir };
    try { fs.mkdirSync(tempConfigDir, { recursive: true }); } catch {}
  });

  afterAll(async () => {
    process.env = originalEnv;
    try { fs.rmSync(tempConfigDir, { recursive: true, force: true }); } catch {}
  });

  let addedLines: ChatLine[] = [];

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: {
      getCurrentHistoryFilePath: () => "history.json",
      getHistory: () => ({ lastCapturedTimestamp: 1700000000000 }),
      workingDirectory: process.cwd(),
      tier: "single",
      onQuestion: vi.fn().mockResolvedValue("Yes"),
    },
  };

  beforeEach(() => {
    addedLines = [];
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue(mockClient as any);
    vi.spyOn(rmemoryUtilModule, "getRMemorySessionKey").mockReturnValue("test-sess");
    const configPath = path.join(tempConfigDir, "model-config.json");
    if (fs.existsSync(configPath)) {
      try { fs.unlinkSync(configPath); } catch {}
    }
    // Enable memory in settings for testing
    updateSettings({ enableRmemory: true });
  });

  it("should print help menu when run without subcommands", async () => {
    await handleSlashCommand("/memory", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("Usage: /memory <subcommand>"))).toBe(true);
  });

  it("should check status and print configuration details", async () => {
    mockClient.readCore.mockResolvedValue({ content: "test persona" });
    await handleSlashCommand("/memory status", mockCtx as any);
    expect(addedLines.some((l) => l.content.includes("RMemory Memory Status: Active"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Session ID: test-sess"))).toBe(true);
  });

  it("should search memories", async () => {
    vi.spyOn(rmemoryUtilModule, "getRMemoryProjectId").mockReturnValue("p_test");
    mockClient.searchAtomic.mockResolvedValue({
      items: [
        {
          id: "mem1", content: "likes typescript", type: "preference", score: 0.95,
          metadata: { scope: "project", projectId: "p_test", schemaVersion: 1, validationStatus: "unverified", provenance: { source: "memory_command_add" } },
        },
      ],
    });

    await handleSlashCommand("/memory search typescript", mockCtx as any);

    expect(mockClient.searchAtomic).toHaveBeenCalledWith({ query: "typescript", limit: 50, projectId: expect.any(String) });
    expect(addedLines.some((l) => l.content.includes("MEMORY SEARCH RESULTS FOR: \"typescript\""))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Score: 0.9500"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Scope: project"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Validation: unverified"))).toBe(true);
    expect(addedLines.some((l) => l.content.includes("Source: memory_command_add"))).toBe(true);
  });

  it("should add a memory", async () => {
    mockClient.updateAtomic.mockResolvedValue({
      id: "user-name",
      updated_at: "2026-06-26T15:00:00.000Z",
    });

    await handleSlashCommand('/memory add user-name "John Doe" preference', mockCtx as any);

    const saved = mockClient.updateAtomic.mock.calls[0][0];
    expect(saved.id).toBe("user-name");
    expect(saved.content).toMatch(/^\[project:p_[a-f0-9]{16}\] John Doe$/);
    expect(saved.metadata).toMatchObject({
      schemaVersion: 1,
      type: "memory",
      memoryType: "preference",
      scope: "project",
      projectId: expect.stringMatching(/^p_[a-f0-9]{16}$/),
      validationStatus: "unverified",
      provenance: { source: "memory_command_add", agentTier: "single" },
    });
    expect(addedLines.some((l) => l.content.includes("Memory saved successfully"))).toBe(true);
  });

  it("should delete a memory", async () => {
    mockClient.deleteAtomicScoped.mockResolvedValue(true);

    const noPromptCtx = { ...mockCtx, agent: { ...mockCtx.agent, onQuestion: undefined } };
    await handleSlashCommand("/memory delete user-name", noPromptCtx as any);
    expect(mockClient.deleteAtomicScoped).not.toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("requires interactive owner confirmation"))).toBe(true);

    addedLines = [];
    await handleSlashCommand("/memory delete user-name", mockCtx as any);

    expect(mockClient.deleteAtomicScoped).toHaveBeenCalledWith({
      id: "user-name",
      scope: "project",
      projectId: expect.any(String),
    });
    expect(addedLines.some((l) => l.content.includes('project-scope memory "user-name" deleted successfully'))).toBe(true);

    mockClient.deleteAtomicScoped.mockResolvedValue(false);
    addedLines = [];
    await handleSlashCommand("/memory delete absent global", mockCtx as any);
    expect(mockClient.deleteAtomicScoped).toHaveBeenLastCalledWith({
      id: "absent",
      scope: "global",
      projectId: expect.any(String),
    });
    expect(addedLines.some((l) => l.content.includes("nothing was deleted"))).toBe(true);
  });

  it("previews revision from the CLI without changing memory", async () => {
    mockClient.previewAtomicRevision.mockResolvedValue({ id: "architecture", currentContent: "old", proposedContent: "new", expectedUpdatedAt: "2026-10-18T00:00:00.000Z", revisionNumber: 1 });
    await handleSlashCommand("/memory revise preview architecture New content", mockCtx as any);
    expect(mockClient.previewAtomicRevision).toHaveBeenCalledWith({ id: "architecture", content: "New content", scope: "project", projectId: expect.any(String) });
    expect(mockClient.reviseAtomic).not.toHaveBeenCalled();
    expect(addedLines.some(line => line.content.includes("preview_only"))).toBe(true);
  });

  it("requires matching version token and owner confirmation before CLI revision", async () => {
    mockClient.previewAtomicRevision.mockResolvedValue({ id: "architecture", currentContent: "old", proposedContent: "new", expectedUpdatedAt: "2026-10-18T00:00:00.000Z", revisionNumber: 1 });
    mockClient.reviseAtomic.mockResolvedValue({ status: "revised", id: "architecture" });
    await handleSlashCommand("/memory revise apply architecture 2026-10-18T00:00:00.000Z New content", mockCtx as any);
    expect(mockClient.reviseAtomic).toHaveBeenCalledWith(expect.objectContaining({ id: "architecture", content: "New content", expectedUpdatedAt: "2026-10-18T00:00:00.000Z" }));
    expect((mockCtx.agent.onQuestion as any)).toHaveBeenCalled();
  });

  it("keeps CLI retention preview read-only", async () => {
    mockClient.exportAtomic.mockResolvedValue({ total: 0, truncated: false, items: [] });
    await handleSlashCommand("/memory retention-review preview", mockCtx as any);
    expect(mockClient.exportAtomic).toHaveBeenCalledWith({ projectId: expect.any(String), includeGlobal: true, limit: 500 });
    expect(mockClient.markAtomicStale).not.toHaveBeenCalled();
    expect(addedLines.some(line => line.content.includes("preview_only"))).toBe(true);
  });

  it("should list scenarios", async () => {
    mockClient.listScenarios.mockResolvedValue({
      entries: [{ path: "scene_blocks/coding-style.md" }]
    });

    await handleSlashCommand("/memory list-scenes", mockCtx as any);
    expect(mockClient.listScenarios).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("scene_blocks/coding-style.md"))).toBe(true);
  });

  it("should read scenario content", async () => {
    mockClient.readScenario.mockResolvedValue({
      path: "scene_blocks/coding-style.md",
      content: "coding rules content"
    });

    await handleSlashCommand("/memory read-scene scene_blocks/coding-style.md", mockCtx as any);
    expect(mockClient.readScenario).toHaveBeenCalledWith({ path: "scene_blocks/coding-style.md" });
    expect(addedLines.some((l) => l.content.includes("coding rules content"))).toBe(true);
  });

  it("should read user persona", async () => {
    mockClient.readCore.mockResolvedValue({
      content: "persona content details"
    });

    await handleSlashCommand("/memory read-persona", mockCtx as any);
    expect(mockClient.readCore).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("persona content details"))).toBe(true);
  });

  it("should trigger manual sync of conversation history", async () => {
    const saveHistoryMock = vi.fn().mockResolvedValue(undefined);
    const syncCtx = {
      ...mockCtx,
      agent: {
        ...mockCtx.agent,
        saveHistory: saveHistoryMock,
      },
    };

    await handleSlashCommand("/memory sync", syncCtx as any);
    expect(saveHistoryMock).toHaveBeenCalled();
    expect(addedLines.some((l) => l.content.includes("Synchronization complete"))).toBe(true);
  });
});
