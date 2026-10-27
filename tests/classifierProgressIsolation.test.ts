import { describe, expect, it } from "vitest";
import {
  runWithProgressCallback,
  getProgressCallback,
  progressStorage,
} from "../src/core/tools/state.js";

describe("Classifier progress callback execution scoping (DEEP-04)", () => {
  it("isolates progress callbacks across concurrent asynchronous executions", async () => {
    const sessionAEvents: string[] = [];
    const sessionBEvents: string[] = [];

    const simulateTask = async (name: string, delayMs: number, iterations: number) => {
      for (let i = 0; i < iterations; i++) {
        await new Promise((r) => setTimeout(r, delayMs));
        const cb = getProgressCallback();
        if (cb) {
          cb(`${name}_progress_${i}`);
        }
      }
    };

    // Run Session A and Session B concurrently
    const taskA = runWithProgressCallback((ev) => sessionAEvents.push(ev), () =>
      simulateTask("session_a", 15, 4)
    );

    const taskB = runWithProgressCallback((ev) => sessionBEvents.push(ev), () =>
      simulateTask("session_b", 10, 5)
    );

    await Promise.all([taskA, taskB]);

    // Verify Session A received ONLY its own events
    expect(sessionAEvents).toEqual([
      "session_a_progress_0",
      "session_a_progress_1",
      "session_a_progress_2",
      "session_a_progress_3",
    ]);

    // Verify Session B received ONLY its own events
    expect(sessionBEvents).toEqual([
      "session_b_progress_0",
      "session_b_progress_1",
      "session_b_progress_2",
      "session_b_progress_3",
      "session_b_progress_4",
    ]);

    // Neither session leaked events to the other
    expect(sessionAEvents.some((e) => e.startsWith("session_b"))).toBe(false);
    expect(sessionBEvents.some((e) => e.startsWith("session_a"))).toBe(false);
  });

  it("clears execution context after completion", () => {
    expect(progressStorage.getStore()).toBeUndefined();
  });
});
