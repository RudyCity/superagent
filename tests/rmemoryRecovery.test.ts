import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSettings = vi.hoisted(() => ({
  enableRmemory: true,
  rmemoryEmbeddingProvider: "local",
  rmemoryEmbeddingModel: "test-model",
  rmemoryEmbeddingDimensions: 384,
  rmemoryGatewayUrl: "http://127.0.0.1:8420",
  rmemoryGatewayApiKey: "test-key",
  rmemoryServiceId: "default",
}));

const mockState = vi.hoisted(() => ({
  constructorFailsOnce: true,
  constructorCalls: 0,
  addMemoryCalls: 0,
  lastAddedMemory: null as null | Record<string, unknown>,
  records: new Map<string, Record<string, any>>(),
}));

vi.mock("../src/core/config/jsonConfig.js", () => ({
  getSettings: () => mockSettings as any,
}));

vi.mock("@huggingface/transformers", () => ({
  env: {
    backends: {
      onnx: {},
    },
    logLevel: "error",
  },
  pipeline: async () => {
    return async () => ({
      data: new Float32Array(mockSettings.rmemoryEmbeddingDimensions).fill(0.25),
      dispose: () => undefined,
    });
  },
}));

vi.mock("r-memory", () => {
  class MockRMemory {
    public db = {
      getAll: () => Array.from(mockState.records.values()),
      getById: (id: string) => mockState.records.get(id) || null,
      close: () => undefined,
    };

    constructor() {
      mockState.constructorCalls += 1;
      if (mockState.constructorFailsOnce) {
        mockState.constructorFailsOnce = false;
        throw new Error("simulated RMemory constructor failure");
      }
    }

    async addMemory(memory: Record<string, any>) {
      mockState.addMemoryCalls += 1;
      mockState.lastAddedMemory = memory;
      mockState.records.set(String(memory.id), memory);
    }

    delete(id: string) {
      return mockState.records.delete(String(id));
    }

    clear() {
      return undefined;
    }

    async query() {
      return [];
    }
  }

  class MockOpenAIEmbeddingProvider {}

  return {
    RMemory: MockRMemory,
    OpenAIEmbeddingProvider: MockOpenAIEmbeddingProvider,
  };
});

describe("RMemory initialization recovery", () => {
  beforeEach(() => {
    mockSettings.enableRmemory = true;
    mockSettings.rmemoryEmbeddingProvider = "local";
    mockSettings.rmemoryEmbeddingModel = "test-model";
    mockSettings.rmemoryEmbeddingDimensions = 384;
    mockSettings.rmemoryGatewayApiKey = "test-key";

    mockState.constructorFailsOnce = true;
    mockState.constructorCalls = 0;
    mockState.addMemoryCalls = 0;
    mockState.lastAddedMemory = null;
    mockState.records.clear();
  });

  it("inspects, exports and deletes atomic memories without crossing project scope", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    const projectA = "p_project_a";
    const projectB = "p_project_b";

    await client.updateAtomic({ id: "private-note", content: "[project:p_project_a] A-only information", metadata: {
      type: "memory", memoryType: "fact", scope: "project", projectId: projectA, logicalId: "private-note", schemaVersion: 1,
    } });
    await client.updateAtomic({ id: "private-note", content: "[project:p_project_b] B-only information", metadata: {
      type: "memory", memoryType: "fact", scope: "project", projectId: projectB, logicalId: "private-note", schemaVersion: 1,
    } });
    await client.updateAtomic({ id: "global-pref", content: "[global] Use concise reports", metadata: {
      type: "memory", memoryType: "preference", scope: "global", schemaVersion: 1,
    } });

    const inspectA = await client.inspectAtomic({ id: "private-note", scope: "project", projectId: projectA });
    expect(inspectA?.content).toContain("A-only information");
    expect(await client.inspectAtomic({ id: "private-note", scope: "project", projectId: "p_other_project" })).toBeNull();

    const exportA = await client.exportAtomic({ projectId: projectA, limit: 10 });
    expect(exportA.total).toBe(2);
    expect(exportA.items.map((item) => item.content).join(" | ")).toContain("A-only information");
    expect(exportA.items.map((item) => item.content).join(" | ")).toContain("Use concise reports");
    expect(exportA.items.map((item) => item.content).join(" | ")).not.toContain("B-only information");

    await expect(client.deleteAtomicScoped({ id: "private-note", scope: "project", projectId: projectA })).resolves.toBe(true);
    expect(await client.inspectAtomic({ id: "private-note", scope: "project", projectId: projectA })).toBeNull();
    expect((await client.inspectAtomic({ id: "private-note", scope: "project", projectId: projectB }))?.content).toContain("B-only information");
    await expect(client.deleteAtomicScoped({ id: "private-note", scope: "project", projectId: "p_other_project" })).resolves.toBe(false);
  });

  it("preserves structured scope and original creation time when an atomic memory is updated without metadata", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    const client = getRMemoryClient();

    await expect(client.updateAtomic({ id: "global-record", content: "initial" }))
      .rejects.toThrow(/simulated RMemory constructor failure/i);
    resetRMemoryInstance();

    const created = await client.updateAtomic({
      id: "global-record",
      content: "initial",
      metadata: { schemaVersion: 1, scope: "global", createdAt: "2026-01-01T00:00:00.000Z", validationStatus: "unverified" },
    });
    expect(created.id).toBe("global-record");
    expect(mockState.lastAddedMemory?.metadata.createdAt).toBe("2026-01-01T00:00:00.000Z");

    await client.updateAtomic({ id: "global-record", content: "updated" });
    const updatedMetadata = mockState.lastAddedMemory?.metadata;
    expect(updatedMetadata.scope).toBe("global");
    expect(updatedMetadata.schemaVersion).toBe(1);
    expect(updatedMetadata.validationStatus).toBe("unverified");
    expect(updatedMetadata.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(Date.parse(updatedMetadata.updatedAt)).toBeGreaterThanOrEqual(Date.parse(updatedMetadata.createdAt));
  });
  it("previews and safely migrates only explicitly scoped legacy memory records", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    const projectA = "p_project_a";

    mockState.records.set("legacy-global", {
      id: "legacy-global",
      content: "[global] Use concise reports",
      metadata: { type: "memory", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    mockState.records.set("legacy-project", {
      id: "legacy-project",
      content: "[project:p_project_a] A-project only knowledge",
      metadata: { type: "memory", memoryType: "decision" },
    });
    mockState.records.set("other-project", {
      id: "other-project",
      content: "[project:p_project_b] B-project private knowledge",
      metadata: { type: "memory" },
    });
    mockState.records.set("ambiguous-legacy", {
      id: "ambiguous-legacy",
      content: "[project] unknown-scope memory",
      metadata: { type: "memory" },
    });

    const preview = await client.migrateLegacyAtomicMemories({ projectId: projectA });
    expect(preview.dryRun).toBe(true);
    expect(preview.candidates).toBe(2);
    expect(preview.items.every(item => item.status === "would_migrate")).toBe(true);
    expect(mockState.records.has("legacy-project")).toBe(true);

    const result = await client.migrateLegacyAtomicMemories({ projectId: projectA, dryRun: false });
    expect(result.migrated).toBe(2);
    expect(result.failed).toBe(0);
    expect(mockState.records.has("legacy-project")).toBe(false);
    expect(mockState.records.has("p_project_a:legacy-project")).toBe(true);
    expect(mockState.records.get("p_project_a:legacy-project")?.content).toBe("A-project only knowledge");
    expect(mockState.records.get("p_project_a:legacy-project")?.metadata).toMatchObject({
      schemaVersion: 1, memoryId: "legacy-project", scope: "project", projectId: projectA,
      provenance: { source: "legacy_prefix_migration" },
    });
    expect(mockState.records.get("legacy-global")?.metadata).toMatchObject({
      schemaVersion: 1, memoryId: "legacy-global", scope: "global",
    });
    expect(mockState.records.get("legacy-global")?.metadata.projectId).toBeUndefined();
    expect(mockState.records.has("other-project")).toBe(true);
    expect(mockState.records.has("ambiguous-legacy")).toBe(true);
  });

  it("preserves both records when legacy migration conflicts with canonical content", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    const projectId = "p_project_a";
    mockState.records.set("canonical-project:note", {
      id: "canonical-project:note", content: "different canonical content",
      metadata: { schemaVersion: 1, memoryId: "note", type: "memory", memoryType: "fact", scope: "project", projectId: "canonical-project", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", validationStatus: "unverified", provenance: { source: "test" } },
    });
    mockState.records.set("note", { id: "note", content: "[project:p_project_a] legacy content", metadata: { type: "memory" } });
    // A namespaced target for the active project with conflicting content must not be overwritten.
    mockState.records.set(projectId + ":note", {
      id: projectId + ":note", content: "canonical content must be kept",
      metadata: { schemaVersion: 1, memoryId: "note", type: "memory", memoryType: "fact", scope: "project", projectId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", validationStatus: "unverified", provenance: { source: "test" } },
    });

    const result = await client.migrateLegacyAtomicMemories({ projectId, dryRun: false });
    expect(result.items).toContainEqual({ id: "note", scope: "project", status: "conflict", reason: "canonical_record_already_exists_with_different_content" });
    expect(mockState.records.get(projectId + ":note")?.content).toBe("canonical content must be kept");
    expect(mockState.records.get("note")?.content).toBe("[project:p_project_a] legacy content");
  });


  it("recovers from a failed index initialization after resetRMemoryInstance", async () => {
    const { getRMemoryClient, getRMemoryDiagnostics, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    const client = getRMemoryClient();

    await expect(client.updateAtomic({ id: "recovery-test", content: "first attempt" }))
      .rejects.toThrow(/simulated RMemory constructor failure/i);

    const degraded = getRMemoryDiagnostics();
    expect(degraded.degraded).toBe(true);
    expect(degraded.retryAvailable).toBe(true);
    expect(degraded.initializationState).toBe("degraded");

    await expect(client.updateAtomic({ id: "recovery-test", content: "second attempt without reset" }))
      .rejects.toThrow();

    resetRMemoryInstance();

    const recovered = await client.updateAtomic({ id: "recovery-test", content: "third attempt after reset" });
    expect(recovered.id).toBe("recovery-test");
    expect(mockState.constructorCalls).toBeGreaterThanOrEqual(2);
    expect(mockState.addMemoryCalls).toBeGreaterThan(0);
    expect(mockState.lastAddedMemory).not.toBeNull();

    const healthy = getRMemoryDiagnostics();
    expect(healthy.degraded).toBe(false);
    expect(healthy.indexReady).toBe(true);
    expect(healthy.initializationState).toBe("ready");
  });
});
