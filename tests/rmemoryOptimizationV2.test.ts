import { afterEach, describe, expect, it } from "vitest";
import { fuseScopedMemoryHits } from "../src/core/memoryRetrieval.js";
import { calculateRecallBudget } from "../src/core/memoryBudget.js";
import { suggestMemoryCandidates } from "../src/core/memoryIntelligence.js";
import { getMemoryPerformanceSnapshot, recordMemorySearchPerformance, recordMemoryIngestion, resetMemoryPerformanceMetrics } from "../src/core/memoryTelemetry.js";
import { listMemoryArchiveBackups, scanMemoryArchive } from "../src/core/memoryArchiveRecovery.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function hit(id: string, content: string, metadata: Record<string, any> = {}) {
  return { memory: { id, content, metadata }, distance: 0.25 };
}
describe("RMemory v2 ranked recall", () => {
  it("rejects other-project rows and blocked lifecycle records before top-K", () => {
    const now = Date.now();
    const result = fuseScopedMemoryHits([
      [
        hit("foreign", "private project B", { scope: "project", projectId: "p_b" }),
        hit("stale", "outdated", { scope: "project", projectId: "p_a", validationStatus: "stale" }),
        hit("valid", "current decision", { scope: "project", projectId: "p_a", validationStatus: "verified" }),
      ],
      [hit("global", "global preference", { scope: "global", validationStatus: "verified" })],
    ], "p_a", 2, now);
    expect(result.map(x => x.id).sort()).toEqual(["global", "valid"]);
  });
  it("fuses independent ranks and deduplicates exactly matching scoped assertions", () => {
    const common = hit("winner", "use bun", { scope: "project", projectId: "p_a" });
    const records = fuseScopedMemoryHits([
      [hit("other", "use pnpm", { scope: "project", projectId: "p_a" }), common],
      [common, hit("duplicate", "use bun", { scope: "project", projectId: "p_a" })],
    ], "p_a", 20);
    expect(records.filter(x => x.content === "use bun")).toHaveLength(1);
    expect(records[0].id).toBe("winner");
  });
  it("hides explicit contradictory assertions rather than selecting one by rank", () => {
    const data = [
      hit("old", "choose A", { scope: "project", projectId: "p_a", assertionKey: "runtime" }),
      hit("new", "choose B", { scope: "project", projectId: "p_a", assertionKey: "runtime" }),
      hit("unrelated", "use tests", { scope: "project", projectId: "p_a" }),
    ];
    expect(fuseScopedMemoryHits([data], "p_a", 5).map(x => x.id)).toEqual(["unrelated"]);
  });
});
describe("memory operations v2", () => {
  afterEach(() => resetMemoryPerformanceMetrics());
  it("bounds token budgets and never grants more than configured capacity", () => {
    expect(calculateRecallBudget(200, "small", 800)).toBeLessThanOrEqual(800);
    expect(calculateRecallBudget(50000, "complex " .repeat(60), 1700)).toBeLessThanOrEqual(1700);
    expect(calculateRecallBudget(8000, "detailed architecture decisions needed")).toBeGreaterThan(350);
  });
  it("only suggests reviewable candidates and redacts or skips credentials", () => {
    const candidates = suggestMemoryCandidates([
      "Decision: Use Bun for runtime builds",
      "Preference: concise output",
      "Decision: Use Bun for runtime builds",
      "Decision: Store sk-proj-12345678901234567890",
      "Some ordinary text without explicit intent",
    ].join("\n"));
    expect(candidates).toHaveLength(2);
    expect(candidates.every(c => c.requiresReview && c.validationStatus === "candidate")).toBe(true);
  });
  it("exposes counters and bounded latency statistics without query text", () => {
    recordMemorySearchPerformance(15, 2);
    recordMemorySearchPerformance(40, 0);
    recordMemoryIngestion(3, 1);
    const snapshot = getMemoryPerformanceSnapshot();
    expect(snapshot.searches).toBe(2);
    expect(snapshot.latencyMs.p95).toBe(40);
    expect(snapshot.ingested).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
});
describe("archived embeddings inspection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rmemory-archive-recovery-test-"));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it("never changes backup, and only recovers unambiguously scoped atomic memory", () => {
    const dirname = path.join(root, ".index-backups", "backup-99-12345");
    fs.mkdirSync(dirname, { recursive: true });
    fs.writeFileSync(path.join(dirname, "metadata.json"), JSON.stringify({ modelName: "old-model", dimensions: 768 }));
    const db = new DatabaseSync(path.join(dirname, "vectors.db"));
    db.exec("CREATE TABLE memories_memories (id TEXT, content TEXT, metadata TEXT)");
    const insert = db.prepare("INSERT INTO memories_memories VALUES (?, ?, ?)");
    insert.run("p_a:abc", "[project:p_a] use Bun", JSON.stringify({ type: "memory", scope: "project", projectId: "p_a" }));
    insert.run("global", "[global] concise", JSON.stringify({ type: "memory", scope: "global" }));
    insert.run("foreign", "[project:p_b] private", JSON.stringify({ type: "memory", scope: "project", projectId: "p_b" }));
    insert.run("ambiguous", "[project] unclear", JSON.stringify({ type: "memory" }));
    insert.run("msg", "raw chat", JSON.stringify({ type: "message", scope: "project", projectId: "p_a" }));
    db.close();
    expect(listMemoryArchiveBackups(root)).toHaveLength(1);
    const scan = scanMemoryArchive(root, "backup-99-12345", "p_a");
    expect(scan.eligible).toBe(2);
    expect(scan.ambiguous).toBe(2);
    expect(scan.candidates.map(c => c.id)).toEqual(["p_a:abc", "global"]);
    expect(scan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(dirname, "vectors.db"))).toBe(true);
    expect(() => scanMemoryArchive(root, "../outside", "p_a")).toThrow();
  });
});
