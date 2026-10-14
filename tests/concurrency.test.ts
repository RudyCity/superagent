import { describe, expect, it } from "vitest";
import { mapConcurrentOrdered } from "../src/core/concurrency.js";

describe("mapConcurrentOrdered", () => {
  it("caps active jobs and restores input order", async () => {
    let active = 0;
    let peak = 0;
    const values = [90, 10, 50, 20, 70, 5, 40];
    const result = await mapConcurrentOrdered(values, 3, async (delay) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return delay * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(result).toEqual(values.map((value) => value * 2));
  });

  it("does not schedule remaining jobs after a worker fails", async () => {
    const started: number[] = [];
    await expect(mapConcurrentOrdered([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 0) throw new Error("expected failure");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    })).rejects.toThrow("expected failure");

    expect(started).toContain(0);
    expect(started.length).toBeLessThan(5);
  });

  it("supports cancellation before scheduling starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const mapper = async (value: number) => value;
    await expect(mapConcurrentOrdered([1, 2], 2, mapper, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
