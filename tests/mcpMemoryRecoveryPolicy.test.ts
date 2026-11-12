import { describe, expect, it } from "vitest";
import { decideMcpMemoryRecovery } from "../src/core/runtime/mcpMemoryRecoveryPolicy.js";
import type { MemoryTrendAssessment } from "../src/core/runtime/memoryTrend.js";

const trend = (suspicious:boolean):MemoryTrendAssessment => ({
  sampleCount:4, windowMs:180_000, rssGrowthBytes:suspicious?500_000_000:0,
  heapGrowthBytes:0, rssSlopeBytesPerMinute:suspicious?160_000_000:0,
  heapSlopeBytesPerMinute:0, positiveRssStepRatio:suspicious?1:0,
  positiveHeapStepRatio:0, suspicious,
  reasons:suspicious?["rss_sustained_growth"]:[],
});

const baseline = {
  trend:trend(true), backendCurrent:true, backendAlive:true, ownerBusy:false,
  ownerSessions:0, backendSessions:0, inFlight:0, inFlightToolCalls:0, oauthPersistent:true,
  attemptsLastHour:0, maxAttemptsPerHour:2,
};

describe("MCP memory recovery policy", () => {
  it("allows URL-stable recovery only for a quiet current backend", () => {
    expect(decideMcpMemoryRecovery(baseline)).toEqual({
      recover:true, reason:"sustained_memory_growth",
    });
  });
  it("blocks recovery while sessions, requests, tool calls, owner operations or rate limits exist", () => {
    expect(decideMcpMemoryRecovery({...baseline,ownerSessions:1}).recover).toBe(false);
    expect(decideMcpMemoryRecovery({...baseline,backendSessions:1}).recover).toBe(false);
    expect(decideMcpMemoryRecovery({...baseline,inFlight:1}).recover).toBe(false);
    expect(decideMcpMemoryRecovery({...baseline,inFlightToolCalls:1}).recover).toBe(false);
    expect(decideMcpMemoryRecovery({...baseline,ownerBusy:true}).recover).toBe(false);
    expect(decideMcpMemoryRecovery({...baseline,attemptsLastHour:2}).reason).toBe("rate_limited");
  });
});
