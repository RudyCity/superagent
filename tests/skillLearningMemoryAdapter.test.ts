import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  records: new Map<string, { id: string; content: string; metadata: Record<string, any> }>(),
  home: "",
  key: "synthetic-local-integration-key",
  writes: 0,
}));

vi.mock("../src/core/config/jsonConfig.js", () => ({
  getSettings: () => ({
    enableRmemory: true,
    rmemoryEmbeddingProvider: "local",
    rmemoryEmbeddingModel: "test-embedding",
    rmemoryEmbeddingDimensions: 384,
    rmemoryGatewayApiKey: state.key,
    rmemoryGatewayUrl: "http://127.0.0.1:8420",
    rmemoryServiceId: "offline-adapter-test",
  }),
}));
vi.mock("node:os", async (importActual) => {
  const real = await importActual<typeof import("node:os")>();
  return { ...real, default: { ...real, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock("@huggingface/transformers", () => ({
  env: { backends: { onnx: {} }, logLevel: "error" },
  pipeline: async () => async () => ({
    data: new Float32Array(384).fill(0.2),
    dispose: () => undefined,
  }),
}));
vi.mock("r-memory", () => {
  class InMemoryRMemory {
    db = {
      getById: (id: string) => state.records.get(id) ?? null,
      getAll: () => [...state.records.values()],
      close: () => undefined,
    };
    provider: any;
    constructor(opts: { embeddingProvider: any }) {
      this.provider = opts.embeddingProvider;
    }
    async addMemory(record: { id: string; content: string; metadata: Record<string, any> }) {
      state.writes++;
      state.records.set(record.id, { id: record.id, content: record.content, metadata: record.metadata });
    }
    delete(id: string) { return state.records.delete(id); }
    async query(opts: { limit: number; filter?: Record<string, any> }) {
      const matching = [...state.records.values()].filter((record) =>
        Object.entries(opts.filter ?? {}).every(([key, value]) => record.metadata[key] === value)
      );
      return matching.slice(0, opts.limit).map(memory => ({ memory, distance: 0.1, score: 0.9 }));
    }
    close() { }
  }
  return { RMemory: InMemoryRMemory, OpenAIEmbeddingProvider: class {} };
});

describe("Hermes skill learning through real MemoryClient adapter (offline fixture)", () => {
  let client: any;
  let bridgeRepeatedSkillFailures: typeof import("../src/core/skills/skillLearningBridge.js").bridgeRepeatedSkillFailures;
  let bridgeNegativeSkillFeedback: typeof import("../src/core/skills/skillLearningBridge.js").bridgeNegativeSkillFeedback;
  let filterEligibleMemoryRecords: typeof import("../src/core/memoryLifecycle.js").filterEligibleMemoryRecords;
  let getRMemoryProjectId: typeof import("../src/core/rmemoryUtil.js").getRMemoryProjectId;
  let getWorkspaceId: typeof import("../src/core/config/paths.js").getWorkspaceId;
  let workA: string;
  let workB: string;

  beforeAll(async () => {
    state.home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-memory-adapter-"));
    const clientModule = await import("../src/core/rmemoryUtil.js");
    ({ getRMemoryProjectId } = clientModule);
    client = clientModule.getRMemoryClient();
    ({ bridgeRepeatedSkillFailures, bridgeNegativeSkillFeedback } = await import("../src/core/skills/skillLearningBridge.js"));
    ({ filterEligibleMemoryRecords } = await import("../src/core/memoryLifecycle.js"));
    ({ getWorkspaceId } = await import("../src/core/config/paths.js"));
    workA = path.join(state.home, "project-A");
    workB = path.join(state.home, "project-B");
    fs.mkdirSync(workA);
    fs.mkdirSync(workB);
  });

  beforeEach(() => {
    state.records.clear();
    state.writes = 0;
    state.key = "synthetic-local-integration-key";
  });

  afterAll(() => {
    fs.rmSync(state.home, { recursive: true, force: true });
  });

  const version = "audit-steps@abcdef123456";
  function failures(workspacePath: string) {
    const projectId = getWorkspaceId(workspacePath);
    return [
      { runId: "evidence-2", jobId: "job-smoke", workspacePath, projectId, pinnedSkillVersion: version,
        attemptNumber: 2, mode: "single" as const, status: "timed_out" as const, executionPolicyJson: "{}",
        startedAt: 2000, completedAt: 2200 },
      { runId: "evidence-1", jobId: "job-smoke", workspacePath, projectId, pinnedSkillVersion: version,
        attemptNumber: 1, mode: "single" as const, status: "error" as const, executionPolicyJson: "{}",
        startedAt: 1000, completedAt: 1200 },
    ];
  }

  it("writes a quarantined evidence-linked candidate and blocks it from recall across projects", async () => {
    const result = await bridgeRepeatedSkillFailures({
      workspacePath: workA, jobId: "job-smoke", pinnedSkillVersion: version,
      runs: failures(workA), client,
    });
    expect(result.status).toBe("created");
    const projectIdA = getRMemoryProjectId(workA);
    const projectIdB = getRMemoryProjectId(workB);
    const record = await client.inspectAtomic({ id: result.memoryId!, scope: "project", projectId: projectIdA });
    expect(record?.metadata).toMatchObject({
      projectId: projectIdA, scope: "project", validationStatus: "candidate", reviewState: "quarantined",
    });
    expect(record?.metadata.evidence.map((e: { id: string }) => e.id)).toEqual(["evidence-2", "evidence-1"]);
    expect(await client.inspectAtomic({ id: result.memoryId!, scope: "project", projectId: projectIdB })).toBeNull();
    const searchA = await client.searchAtomic({ query: "audit steps", projectId: projectIdA });
    const searchB = await client.searchAtomic({ query: "audit steps", projectId: projectIdB });
    expect(searchB.items).toHaveLength(0);
    const recall = filterEligibleMemoryRecords(searchA.items, { projectId: projectIdA });
    expect(recall.items).toHaveLength(0);
    // v2 now withholds unsafe memories before top-K, so downstream governance
    // sees an already-clean result, not the quarantined raw candidate.
    expect(searchA.items).toHaveLength(0);
    expect(recall.withheldCount).toBe(0);
  });

  it("preserves owner review and prevents duplicate writes through the adapter", async () => {
    const result = await bridgeRepeatedSkillFailures({
      workspacePath: workA, jobId: "job-smoke", pinnedSkillVersion: version,
      runs: failures(workA), client,
    });
    const projectId = getRMemoryProjectId(workA);
    const original = await client.inspectAtomic({ id: result.memoryId!, scope: "project", projectId });
    await client.updateAtomic({
      id: result.memoryId!, content: original!.content,
      metadata: { ...original!.metadata, reviewState: "reviewed", validationStatus: "verified" },
    });
    const before = state.writes;
    const repeated = await bridgeRepeatedSkillFailures({
      workspacePath: workA, jobId: "job-smoke", pinnedSkillVersion: version,
      runs: failures(workA), client,
    });
    expect(repeated.status).toBe("already_exists");
    expect(state.writes).toBe(before);
    expect((await client.inspectAtomic({ id: result.memoryId!, scope: "project", projectId }))?.metadata.reviewState).toBe("reviewed");
  });

  it("persists negative feedback without writing arbitrary user text or exposing candidate for recall", async () => {
    const id = "skill-feedback-12345678-1234-1234-1234-123456789abc";
    const result = await bridgeNegativeSkillFeedback({
      skillName: "audit-steps", skillVersion: "abcdef123456", feedbackId: id,
      workspacePath: workB, client,
    });
    expect(result.status).toBe("created");
    const projectId = getRMemoryProjectId(workB);
    const record = await client.inspectAtomic({ id: result.memoryId!, scope: "project", projectId });
    expect(record?.metadata.evidence).toMatchObject([{ kind: "user_feedback", id, status: "negative" }]);
    expect(filterEligibleMemoryRecords([record!], { projectId }).items).toHaveLength(0);
    expect(await client.inspectAtomic({ id: result.memoryId!, scope: "project", projectId: getRMemoryProjectId(workA) })).toBeNull();
  });

  it("permits local memory storage without requiring an unrelated HTTP gateway key", async () => {
    state.key = "";
    const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
    const noKeyClient = getRMemoryClient();
    const previousWrites = state.writes;
    await expect(bridgeRepeatedSkillFailures({
      workspacePath: workA, jobId: "job-smoke", pinnedSkillVersion: version,
      runs: failures(workA), client: noKeyClient,
    })).resolves.toMatchObject({ status: "created" });
    expect(state.writes).toBe(previousWrites + 1);
  });
});
