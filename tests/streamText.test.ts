import { describe, it, expect } from "vitest";
import { createIncrementalStreamCleaner } from "../src/utils/streamText.js";

describe("createIncrementalStreamCleaner", () => {
  // Simple stand-in for cleanXmlForDisplay with observable effects.
  const stripTmp = (text: string): string => text.replace(/<tmp>[\s\S]*?<\/tmp>/g, "");

  it("returns identical output to the full cleaner for prose streams", () => {
    const cleaner = createIncrementalStreamCleaner(stripTmp);
    let buffer = "";
    for (const chunk of ["plain words\n", "more prose\n", "tail without newline"]) {
      buffer += chunk;
      expect(cleaner.clean(buffer)).toBe(stripTmp(buffer));
    }
  });

  it("falls back to full cleaning when markup is present", () => {
    const cleaner = createIncrementalStreamCleaner(stripTmp);
    const buffer = "intro\n<tmp>secret</tmp>\nafter\n";
    expect(cleaner.clean(buffer)).toBe(stripTmp(buffer));
  });

  it("handles markup arriving after cached prose", () => {
    const cleaner = createIncrementalStreamCleaner(stripTmp);
    let buffer = "prose line\n";
    expect(cleaner.clean(buffer)).toBe(stripTmp(buffer));
    buffer += "<tmp>x</tmp>\nend";
    expect(cleaner.clean(buffer)).toBe(stripTmp(buffer));
  });

  it("cleanFinal always performs a complete clean", () => {
    const cleaner = createIncrementalStreamCleaner(stripTmp);
    const buffer = "keep\n<tmp>drop</tmp>\n";
    expect(cleaner.cleanFinal(buffer)).toBe("keep\n\n");
  });

  it("cleaner.reset invalidates the cache", () => {
    const cleaner = createIncrementalStreamCleaner(stripTmp);
    const long = "word \n".repeat(5000);
    cleaner.clean(long);
    cleaner.reset();
    const fresh = "<tmp>x</tmp>\nkeep";
    expect(cleaner.clean(fresh)).toBe(stripTmp(fresh));
  });

  it("self-heals when the buffer shrinks between turns", () => {
    const cleaner = createIncrementalStreamCleaner(stripTmp);
    const long = "word \n".repeat(5000);
    cleaner.clean(long);
    const fresh = "short";
    expect(cleaner.clean(fresh)).toBe(stripTmp(fresh));
  });

  it("is asymptotically cheaper than full cleaning on a streamed buffer", () => {
    // The realistic use case in app.tsx: the display buffer grows chunk by
    // chunk from streaming, and the cleaner is invoked on every flush with
    // the latest full buffer. The naive approach (re-cleaning the entire
    // buffer each time) does O(n²) work; the incremental cache reduces
    // this to O(n) for prose by reusing already-cleaned stable content.
    let examined = 0;
    const countingClean = (text: string): string => {
      examined += text.length;
      return text;
    };
    const cleaner = createIncrementalStreamCleaner(countingClean);
    let buffer = "";
    const line = "lorem ipsum dolor sit amet\n"; // 28 chars incl. newline
    const ITERATIONS = 2000;
    for (let i = 0; i < ITERATIONS; i++) {
      buffer += line;
      cleaner.clean(buffer);
    }
    // Final buffer ≈ 56 KB of plain prose.
    expect(buffer.length).toBeGreaterThan(8192);

    // Naive full cleaning: Σ_{k=1..N} 28k = 14·N·(N+1) ≈ 56M chars examined.
    const naiveExamined = line.length * (ITERATIONS * (ITERATIONS + 1)) / 2;
    expect(naiveExamined).toBeGreaterThan(10_000_000);

    // With caching, the stable prefix is frozen after the first pass, so
    // examined scales linearly with N (the volatile tail plus the initial
    // pass that warms the cache). The window dominates overhead, so we
    // expect at least an order-of-magnitude reduction.
    expect(examined).toBeLessThan(naiveExamined / 10);
  });
});
