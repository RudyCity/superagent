import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterEligibleMemoryRecords } from "../src/core/memoryLifecycle.js";

type Fixture = {
  fixtureVersion: string;
  evaluatedAt: string;
  records: Array<{ id: string; content: string; scope?: "global" | "project"; metadata: Record<string, unknown> }>;
  cases: Array<{ id: string; projectId: string; scope: "all" | "project" | "global"; candidateIds: string[]; relevantIds: string[]; expectedIds: string[]; expectedConflictPairs: number }>;
};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/memory-recall-v1.json", import.meta.url), "utf8")) as Fixture;

describe("versioned memory recall evaluation", () => {
  it("runs the labeled v1 fixture deterministically and reports precision/recall without a live model", () => {
    expect(fixture.fixtureVersion).toBe("memory-recall-v1");
    const perCase = fixture.cases.map(testCase => {
      const candidates = testCase.candidateIds.map(id => fixture.records.find(record => record.id === id)).filter(Boolean) as Fixture["records"];
      const result = filterEligibleMemoryRecords(candidates, { projectId: testCase.projectId, scope: testCase.scope, now: fixture.evaluatedAt });
      const returnedIds = result.items.map(item => item.id).sort();
      const expectedIds = [...testCase.expectedIds].sort();
      const relevant = new Set(testCase.relevantIds);
      const truePositives = returnedIds.filter(id => relevant.has(id)).length;
      const precision = returnedIds.length ? truePositives / returnedIds.length : (relevant.size ? 0 : 1);
      const recall = relevant.size ? truePositives / relevant.size : 1;
      return { id: testCase.id, returnedIds, expectedIds, precision, recall, ...result, expectedConflictPairs: testCase.expectedConflictPairs };
    });

    for (const result of perCase) {
      expect(result.returnedIds, result.id).toEqual(result.expectedIds);
      expect(result.precision, result.id).toBe(1);
      expect(result.recall, result.id).toBe(1);
      expect(result.conflictPairCount, result.id).toBe(result.expectedConflictPairs);
    }
    expect(perCase.reduce((n, item) => n + item.crossScopeRejectedCount, 0)).toBeGreaterThan(0);
    expect(perCase.flatMap(item => item.returnedIds)).not.toContain("legacy-ambiguous");
  });
});
