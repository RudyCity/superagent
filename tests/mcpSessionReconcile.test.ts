import {describe, expect, it} from "vitest";
import {findOrphanedMcpAffinities} from "../src/core/runtime/mcpSessionReconcile.js";

const now = 100_000;
const base = {
  ownerIds: ["live", "orphan", "sse", "new"],
  workerIds: ["live", "sse"],
  workerCount: 2,
  registeredAt: new Map([["live", 1000], ["orphan", 1000], ["sse", 1000], ["new", now - 100]]),
  inFlight: new Map([["sse", 1]]),
  snapshotAt: now,
};
describe("MCP private affinity reconciliation", () => {
  it("reclaims only an old session missing from authoritative worker registry", () => {
    expect(findOrphanedMcpAffinities(base)).toEqual(["orphan"]);
  });
  it("preserves live SSE/POST and freshly initialized sessions", () => {
    expect(findOrphanedMcpAffinities({...base, inFlight:new Map([["orphan", 1]])})).toEqual([]);
    expect(findOrphanedMcpAffinities({...base, registeredAt:new Map([["orphan", now]])})).toEqual([]);
  });
  it("does not infer absence from missing timestamps", () => {
    expect(findOrphanedMcpAffinities({...base, registeredAt:new Map()})).toEqual([]);
  });
  it("fails closed on inconsistent counts, duplicates and non-array worker health", () => {
    expect(findOrphanedMcpAffinities({...base, workerCount:3})).toEqual([]);
    expect(findOrphanedMcpAffinities({...base, workerIds:["live", "live"]})).toEqual([]);
    expect(findOrphanedMcpAffinities({...base, workerIds:null})).toEqual([]);
    expect(findOrphanedMcpAffinities({...base, workerCount:1000})).toEqual([]);
  });
  it("uses only the snapshot time, not the wall clock, to avoid asynchronous races", () => {
    expect(findOrphanedMcpAffinities({...base, snapshotAt:1100})).toEqual([]);
  });
});
