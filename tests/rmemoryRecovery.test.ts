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
  failSecondConversationOnce: false,
  conversationWrites: 0,
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
    public provider = {
      embedTexts: async (texts: string[]) => texts.map(() => Array(384).fill(0.25)),
    };
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
      if (String(memory.id).startsWith("conv_")) {
        mockState.conversationWrites += 1;
        if (mockState.failSecondConversationOnce && mockState.conversationWrites === 2) {
          mockState.failSecondConversationOnce = false;
          throw new Error("simulated failure after first committed message");
        }
      }
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
    mockState.conversationWrites = 0;
    mockState.failSecondConversationOnce = false;
  });

  it("redacts credentials before they enter atomic memory and conversation vectors", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    const secret = "sk-proj-abcdefghijklmnop";
    await client.updateAtomic({ id: "secret-test", content: "[global] secret is " + secret,
      metadata: { scope: "global", type: "memory" } });
    await client.addConversation({ session_id: "secrets", projectId: "p_a", messages: [
      { role: "user", content: "my secret: " + secret, timestamp: "2026-10-22T00:00:00.000Z" },
    ] });
    const saved = [...mockState.records.values()].filter((v: any) =>
      v.id === "secret-test" || v.metadata?.session === "secrets");
    expect(saved).toHaveLength(2);
    expect(saved.every((v: any) => !v.content.includes(secret))).toBe(true);
    expect(saved.every((v: any) => v.content.includes("[REDACTED]"))).toBe(true);
  });

  it("initializes a single vector index for simultaneous memory callers", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    await Promise.all([
      client.updateAtomic({ id: "parallel-a", content: "first", metadata: { scope: "global", type: "memory" } }),
      client.updateAtomic({ id: "parallel-b", content: "second", metadata: { scope: "global", type: "memory" } }),
      client.updateAtomic({ id: "parallel-c", content: "third", metadata: { scope: "global", type: "memory" } }),
    ]);
    expect(mockState.constructorCalls).toBe(1);
    expect(mockState.records.has("parallel-a")).toBe(true);
    expect(mockState.records.has("parallel-b")).toBe(true);
    expect(mockState.records.has("parallel-c")).toBe(true);
  });

  it("deduplicates conversation writes across retries and isolates project scopes without a gateway key", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    mockSettings.rmemoryGatewayApiKey = "";
    const client = getRMemoryClient();
    const messages = [
      { role: "user" as const, content: "same user question", timestamp: "2026-10-22T00:00:00.000Z" },
      { role: "assistant" as const, content: "answer", timestamp: "2026-10-22T00:00:01.000Z" },
    ];
    const first = await client.addConversation({ session_id: "session-A", projectId: "p_a", messages });
    const second = await client.addConversation({ session_id: "session-A", projectId: "p_a", messages });
    expect(first.accepted_ids).toEqual(second.accepted_ids);
    expect(mockState.conversationWrites).toBe(2);
    expect(first.total_count).toBe(2);
    const other = await client.addConversation({ session_id: "session-A", projectId: "p_b", messages });
    expect(other.accepted_ids[0]).not.toEqual(first.accepted_ids[0]);
    expect(mockState.conversationWrites).toBe(4);
  });

  it("resumes a partly failed conversation batch without duplicating committed messages", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    mockState.failSecondConversationOnce = true;
    const args = {
      session_id: "session-partial",
      projectId: "p_partial",
      messages: [
        { role: "user" as const, content: "first", timestamp: "2026-10-22T00:00:00.000Z" },
        { role: "assistant" as const, content: "second", timestamp: "2026-10-22T00:00:01.000Z" },
      ],
    };
    await expect(client.addConversation(args)).rejects.toThrow(/simulated failure/);
    const afterRetry = await client.addConversation(args);
    expect(afterRetry.accepted_ids).toHaveLength(2);
    expect(Array.from(mockState.records.values()).filter((r) => r.metadata?.session === "session-partial")).toHaveLength(2);
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


  it("revises scoped memory optimistically, preserves a history snapshot, and restores through another revision", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    const { createMemoryRecordMetadata } = await import("../src/core/memoryRecord.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    await client.updateAtomic({ id: "runtime-version", content: "[global] Runtime uses node 20", metadata: createMemoryRecordMetadata({
      memoryId: "runtime-version", memoryType: "decision", scope: "global", source: "test_fixture", now: "2026-01-01T00:00:00.000Z",
    }) });
    const initial = await client.inspectAtomic({ id: "runtime-version", scope: "global", projectId: "p-a" });
    expect(initial?.content).toBe("[global] Runtime uses node 20");
    const preview = await client.previewAtomicRevision({ id: "runtime-version", content: "Runtime uses node 22", scope: "global", projectId: "p-a" });
    expect(preview).toMatchObject({ expectedUpdatedAt: expect.any(String), currentContent: "[global] Runtime uses node 20", proposedContent: "[global] Runtime uses node 22", revisionNumber: 1 });

    await expect(client.reviseAtomic({ id: "runtime-version", content: "Runtime uses node 22", scope: "global", projectId: "p-a", expectedUpdatedAt: "2025-01-01T00:00:00.000Z" })).resolves.toMatchObject({ status: "conflict" });
    const first = await client.reviseAtomic({ id: "runtime-version", content: "Runtime uses node 22", scope: "global", projectId: "p-a", expectedUpdatedAt: preview!.expectedUpdatedAt });
    expect(first).toMatchObject({ status: "revised", revisionNumber: 2, revisionId: expect.any(String) });
    const activeAfterFirstRevision = await client.inspectAtomic({ id: "runtime-version", scope: "global", projectId: "p-a" });
    expect(activeAfterFirstRevision?.content).toBe("[global] Runtime uses node 22");
    expect(activeAfterFirstRevision?.metadata).toMatchObject({ revisionNumber: 2, supersedesMemoryId: first.revisionId });
    const revisions = await client.listAtomicRevisions({ id: "runtime-version", scope: "global", projectId: "p-a" });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revisionId: first.revisionId, content: "[global] Runtime uses node 20", revisionNumber: 1, metadata: { lifecycleState: "superseded", supersededByMemoryId: "runtime-version" } });

    const restored = await client.restoreAtomicRevision({ id: "runtime-version", revisionId: revisions[0].revisionId, scope: "global", projectId: "p-a", expectedUpdatedAt: first.updatedAt! });
    expect(restored).toMatchObject({ status: "revised", revisionNumber: 3 });
    expect((await client.inspectAtomic({ id: "runtime-version", scope: "global", projectId: "p-a" }))?.content).toBe("[global] Runtime uses node 20");
    expect(await client.listAtomicRevisions({ id: "runtime-version", scope: "global", projectId: "p-a" })).toHaveLength(2);
  });

  it("owner-maps ambiguous legacy memory only to the explicitly chosen scope and keeps original readable", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    resetRMemoryInstance();
    mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    mockState.records.set("legacy-unclear", { id: "legacy-unclear", content: "[project] old environment note", metadata: { type: "memory", createdAt: "2025-12-01T00:00:00.000Z" } });

    const preview = await client.previewLegacyAtomicMapping({ sourceId: "legacy-unclear", targetId: "mapped-note", scope: "project", projectId: "p_project_a" });
    expect(preview).toMatchObject({ targetExists: false, scope: "project", projectId: "p_project_a", proposedContent: "[project:p_project_a] old environment note", originalPreserved: true });
    await expect(client.mapLegacyAtomicMemory({ sourceId: "legacy-unclear", targetId: "mapped-note", scope: "project", projectId: "p_project_a", expectedSourceFingerprint: "not-the-current-fingerprint" })).resolves.toMatchObject({ status: "source_changed" });
    const result = await client.mapLegacyAtomicMemory({ sourceId: "legacy-unclear", targetId: "mapped-note", scope: "project", projectId: "p_project_a", expectedSourceFingerprint: preview!.expectedSourceFingerprint, reason: "Owner identified active project" });
    expect(result).toMatchObject({ status: "mapped", sourceId: "legacy-unclear", targetId: "mapped-note", scope: "project", originalPreserved: true });
    expect(mockState.records.get("legacy-unclear")?.content).toBe("[project] old environment note");
    expect(mockState.records.get("p_project_a:mapped-note")?.content).toBe("[project:p_project_a] old environment note");
    expect(mockState.records.get("p_project_a:mapped-note")?.metadata).toMatchObject({ mappedFromLegacyId: "legacy-unclear", provenance: { source: "legacy_owner_mapping" }, scope: "project", projectId: "p_project_a" });
    await expect(client.mapLegacyAtomicMemory({ sourceId: "legacy-unclear", targetId: "mapped-note", scope: "project", projectId: "p_project_a", expectedSourceFingerprint: preview!.expectedSourceFingerprint })).resolves.toMatchObject({ status: "already_mapped" });
    await expect(client.previewLegacyAtomicMapping({ sourceId: "legacy-unclear", targetId: "wrong-scope", scope: "project", projectId: "p_project_b" })).resolves.toMatchObject({ scope: "project", projectId: "p_project_b" });
  });

  it("uses compare-and-swap review transitions and keeps quarantine/stale as non-destructive states", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    const { createMemoryRecordMetadata } = await import("../src/core/memoryRecord.js");
    resetRMemoryInstance(); mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    await client.updateAtomic({ id: "review-note", content: "[global] Runtime uses Node 22", metadata: createMemoryRecordMetadata({ memoryId: "review-note", memoryType: "environment", scope: "global", source: "test", now: "2026-10-01T00:00:00.000Z", existingMetadata: { retentionClass: "environment" } }) });
    let current = await client.inspectAtomic({ id: "review-note", scope: "global", projectId: "p_project_a" });
    const verified = await client.reviewAtomic({ id: "review-note", scope: "global", projectId: "p_project_a", expectedUpdatedAt: current!.metadata.updatedAt, action: "verify", reviewedBy: "owner" });
    expect(verified.status).toBe("updated");
    current = await client.inspectAtomic({ id: "review-note", scope: "global", projectId: "p_project_a" });
    expect(current?.metadata).toMatchObject({ validationStatus: "verified", reviewState: "reviewed", reviewedBy: "owner" });

    const quarantined = await client.reviewAtomic({ id: "review-note", scope: "global", projectId: "p_project_a", expectedUpdatedAt: current!.metadata.updatedAt, action: "quarantine", reason: "Need source citation" });
    expect(quarantined.status).toBe("updated");
    current = await client.inspectAtomic({ id: "review-note", scope: "global", projectId: "p_project_a" });
    expect(current?.metadata).toMatchObject({ reviewState: "quarantined", quarantineReason: "Need source citation" });

    const conflict = await client.reviewAtomic({ id: "review-note", scope: "global", projectId: "p_project_a", expectedUpdatedAt: "2026-01-01T00:00:00.000Z", action: "unquarantine" });
    expect(conflict.status).toBe("conflict");
    const unquarantined = await client.reviewAtomic({ id: "review-note", scope: "global", projectId: "p_project_a", expectedUpdatedAt: current!.metadata.updatedAt, action: "unquarantine" });
    expect(unquarantined.status).toBe("updated");
    current = await client.inspectAtomic({ id: "review-note", scope: "global", projectId: "p_project_a" });
    expect(current?.metadata).toMatchObject({ validationStatus: "unverified", reviewState: "unreviewed" });

    const stale = await client.markAtomicStale({ id: "review-note", scope: "global", projectId: "p_project_a", expectedUpdatedAt: current!.metadata.updatedAt, reason: "Environment refresh interval exceeded" });
    expect(stale.status).toBe("marked_stale");
    current = await client.inspectAtomic({ id: "review-note", scope: "global", projectId: "p_project_a" });
    expect(current?.metadata).toMatchObject({ validationStatus: "stale", staleReason: "Environment refresh interval exceeded" });
    expect(current?.content).toBe("[global] Runtime uses Node 22");
  });

  it("marks and resolves explicit same-key conflict pairs atomically with compare-and-swap tokens", async () => {
    const { getRMemoryClient, resetRMemoryInstance } = await import("../src/core/rmemoryUtil.js");
    const { createMemoryRecordMetadata } = await import("../src/core/memoryRecord.js");
    resetRMemoryInstance(); mockState.constructorFailsOnce = false;
    const client = getRMemoryClient();
    const firstId = "runtime-node-a"; const secondId = "runtime-node-b";
    await client.updateAtomic({ id: firstId, content: "[global] Runtime uses Node 20", metadata: createMemoryRecordMetadata({
      memoryId: firstId, memoryType: "environment", scope: "global", source: "test", now: "2026-10-17T00:00:00.000Z", existingMetadata: { assertionKey: "runtime-version" },
    }) });
    await client.updateAtomic({ id: secondId, content: "[global] Runtime uses Node 22", metadata: createMemoryRecordMetadata({
      memoryId: secondId, memoryType: "environment", scope: "global", source: "test", now: "2026-10-17T01:00:00.000Z", existingMetadata: { assertionKey: "runtime-version" },
    }) });
    let first = await client.inspectAtomic({ id: firstId, scope: "global", projectId: "p-a" });
    let second = await client.inspectAtomic({ id: secondId, scope: "global", projectId: "p-a" });
    const staleToken = await client.reviewAtomicConflictPair({
      first: { id: firstId, expectedUpdatedAt: "2026-10-16T00:00:00.000Z" },
      second: { id: secondId, expectedUpdatedAt: second!.metadata.updatedAt }, scope: "global", projectId: "p-a",
    });
    expect(staleToken.status).toBe("conflict");
    expect((await client.inspectAtomic({ id: firstId, scope: "global", projectId: "p-a" }))?.metadata.lifecycleState).toBe("active");

    const marked = await client.reviewAtomicConflictPair({
      first: { id: firstId, expectedUpdatedAt: first!.metadata.updatedAt },
      second: { id: secondId, expectedUpdatedAt: second!.metadata.updatedAt }, scope: "global", projectId: "p-a", reviewedBy: "owner", reason: "Two incompatible runtime assertions",
    });
    expect(marked).toMatchObject({ status: "marked_conflicted", firstId, secondId, assertionKey: "runtime-version" });
    first = await client.inspectAtomic({ id: firstId, scope: "global", projectId: "p-a" });
    second = await client.inspectAtomic({ id: secondId, scope: "global", projectId: "p-a" });
    expect(first?.metadata).toMatchObject({ lifecycleState: "conflicted", reviewState: "unreviewed", validationStatus: "candidate", conflictWithMemoryIds: [secondId], conflictDetectedBy: "owner", conflictReason: "Two incompatible runtime assertions" });
    expect(second?.metadata).toMatchObject({ lifecycleState: "conflicted", reviewState: "unreviewed", validationStatus: "candidate", conflictWithMemoryIds: [firstId], conflictDetectedBy: "owner", conflictReason: "Two incompatible runtime assertions" });

    const resolved = await client.resolveAtomicConflictPair({
      first: { id: firstId, expectedUpdatedAt: first!.metadata.updatedAt },
      second: { id: secondId, expectedUpdatedAt: second!.metadata.updatedAt }, scope: "global", projectId: "p-a", reviewedBy: "owner",
    });
    expect(resolved).toMatchObject({ status: "resolved", firstId, secondId, validationStatus: "unverified" });
    first = await client.inspectAtomic({ id: firstId, scope: "global", projectId: "p-a" });
    second = await client.inspectAtomic({ id: secondId, scope: "global", projectId: "p-a" });
    expect(first?.metadata).toMatchObject({ lifecycleState: "active", reviewState: "reviewed", validationStatus: "unverified" });
    expect(second?.metadata).toMatchObject({ lifecycleState: "active", reviewState: "reviewed", validationStatus: "unverified" });
    expect(first?.metadata.conflictWithMemoryIds).toBeUndefined();
    expect(second?.metadata.conflictWithMemoryIds).toBeUndefined();
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
