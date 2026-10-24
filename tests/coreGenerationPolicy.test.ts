import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_CORE_WORKERS, applyCoreRollback,
  mayCreateCoreGeneration, rollbackCandidates,
} from "../src/core/runtime/coreGenerationPolicy.js";

const a = { pid: 1, port: 10001, since: 1 };
const b = { pid: 2, port: 10002, since: 2 };
const c = { pid: 3, port: 10003, since: 3 };

describe("conservative core generation policy", () => {
  it("caps retained generations instead of silently killing workers", () => {
    expect(MAX_RETAINED_CORE_WORKERS).toBe(4);
    expect(mayCreateCoreGeneration(3)).toBe(true);
    expect(mayCreateCoreGeneration(4)).toBe(false);
    expect(mayCreateCoreGeneration(-1)).toBe(false);
  });

  it("rolls back to most recent retained generation without deleting live active workers", () => {
    expect(rollbackCandidates([a, b], c.pid)).toEqual([b, a]);
    expect(applyCoreRollback(c, [a, b], b.pid, true)).toEqual({
      active: b, retained: [a, c],
    });
  });

  it("does not reintroduce a crashed worker, and refuses an unknown candidate", () => {
    expect(applyCoreRollback(c, [a, b], a.pid, false)).toEqual({
      active: a, retained: [b],
    });
    expect(applyCoreRollback(c, [a, b], 404, true)).toBeUndefined();
    expect(applyCoreRollback(c, [a, b], c.pid, true)).toBeUndefined();
  });
});
