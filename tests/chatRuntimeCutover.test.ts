import { describe, expect, it } from "vitest";
import { assessCoreCutover } from "../src/core/runtime/chatRuntimeCutover.js";

describe("Chat Runtime cutover fail-closed preflight", () => {
  it("blocks taking over an occupied unsupervised port", () => {
    const result = assessCoreCutover({
      supervised: false, portOccupied: true, activeWorker: false,
      retainedWorkers: 0, retainedLimit: 4,
    });
    expect(result.approved).toBe(false);
    expect(result.blockers.join(" ")).toContain("unmanaged");
  });
  it("blocks a full retained-worker quota even with valid supervisor", () => {
    const result = assessCoreCutover({
      supervised: true, portOccupied: true, activeWorker: true,
      retainedWorkers: 4, retainedLimit: 4,
    });
    expect(result.approved).toBe(false);
    expect(result.blockers.join(" ")).toContain("limit");
  });
  it("permits only a supervised, bounded managed restart request", () => {
    expect(assessCoreCutover({
      supervised: true, portOccupied: true, activeWorker: true,
      retainedWorkers: 1, retainedLimit: 4,
    }).approved).toBe(true);
    expect(assessCoreCutover({
      supervised: true, portOccupied: true, activeWorker: false,
      retainedWorkers: 0, retainedLimit: 4,
    }).approved).toBe(false);
  });
});
