import { describe, expect, it } from "vitest";
import { assessMemoryTrend } from "../src/core/runtime/memoryTrend.js";

const MB = 1024 * 1024;

describe("bounded memory trend detection", () => {
  it("flags sustained sub-gigabyte growth before absolute pressure thresholds", () => {
    const base = 1_000_000;
    const result = assessMemoryTrend([
      {at:base, rssBytes:180*MB, heapUsedBytes:60*MB},
      {at:base+60_000, rssBytes:300*MB, heapUsedBytes:90*MB},
      {at:base+120_000, rssBytes:500*MB, heapUsedBytes:130*MB},
      {at:base+180_000, rssBytes:800*MB, heapUsedBytes:180*MB},
    ]);
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain("rss_sustained_growth");
    expect(result.rssGrowthBytes).toBe(620*MB);
  });

  it("does not flag GC-shaped or short-window noise", () => {
    const base = 2_000_000;
    expect(assessMemoryTrend([
      {at:base, rssBytes:300*MB, heapUsedBytes:140*MB},
      {at:base+60_000, rssBytes:380*MB, heapUsedBytes:190*MB},
      {at:base+120_000, rssBytes:310*MB, heapUsedBytes:120*MB},
      {at:base+180_000, rssBytes:340*MB, heapUsedBytes:135*MB},
    ]).suspicious).toBe(false);
    expect(assessMemoryTrend([
      {at:base, rssBytes:180*MB, heapUsedBytes:60*MB},
      {at:base+10_000, rssBytes:450*MB, heapUsedBytes:180*MB},
      {at:base+20_000, rssBytes:700*MB, heapUsedBytes:240*MB},
      {at:base+30_000, rssBytes:900*MB, heapUsedBytes:300*MB},
    ]).suspicious).toBe(false);
  });
});
