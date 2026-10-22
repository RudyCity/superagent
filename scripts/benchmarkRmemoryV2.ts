import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fuseScopedMemoryHits } from "../src/core/memoryRetrieval.js";

interface Entry { id: string; content: string; metadata: Record<string, any> }
interface Case { id: string; projectId: string; scope: string; candidateIds: string[]; expectedIds: string[] }
const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/memory-recall-v1.json", import.meta.url), "utf8")) as {
  fixtureVersion: string; evaluatedAt: string; records: Entry[]; cases: Case[];
};
// Offline ranker/lifecycle evaluation, not a live embedding latency benchmark.
const cases = fixture.cases.filter(test => test.scope === "all");
if (!cases.length) throw new Error("No all-scope labeled evaluation cases found.");
const started = performance.now();
let truePositive = 0, relevantCount = 0, returnedCount = 0, crossProjectLeakage = 0;
const details = cases.map(test => {
  const records = test.candidateIds
    .map(id => fixture.records.find(row => row.id === id))
    .filter((row): row is Entry => Boolean(row))
    .map(row => ({ memory: row, distance: 0.2 }));
  const ranked = fuseScopedMemoryHits([records], test.projectId, 5, Date.parse(fixture.evaluatedAt));
  const expected = new Set(test.expectedIds);
  const found = ranked.filter(row => expected.has(row.id)).length;
  truePositive += found;
  relevantCount += expected.size;
  returnedCount += ranked.length;
  crossProjectLeakage += ranked.filter(row =>
    row.metadata?.scope === "project" && row.metadata?.projectId !== test.projectId).length;
  return { id: test.id, expected: [...expected], returned: ranked.map(r => r.id),
    recallAt5: expected.size ? found / expected.size : 1 };
});
console.log(JSON.stringify({ fixtureVersion: fixture.fixtureVersion, evaluation: "offline_ranker",
  sampleCases: details.length,
  recallAt5: relevantCount ? truePositive / relevantCount : 1,
  precisionAt5: returnedCount ? truePositive / returnedCount : 1,
  crossProjectLeakage,
  rankerExecutionMs: Math.round((performance.now() - started) * 100) / 100,
  details }, null, 2));
