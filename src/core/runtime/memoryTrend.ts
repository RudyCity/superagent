/**
 * Bounded, allocation-light memory growth assessment.
 *
 * Absolute pressure thresholds catch already-large processes; this catches
 * sustained growth earlier, before RSS reaches the 1-3 GiB guardrails.
 */
export interface MemoryTrendSample {
  at: number;
  rssBytes: number;
  heapUsedBytes: number;
}

export interface MemoryTrendThresholds {
  minSamples: number;
  minWindowMs: number;
  minRssGrowthBytes: number;
  minHeapGrowthBytes: number;
  minSlopeBytesPerMinute: number;
  minPositiveStepRatio: number;
}

export interface MemoryTrendAssessment {
  sampleCount: number;
  windowMs: number;
  rssGrowthBytes: number;
  heapGrowthBytes: number;
  rssSlopeBytesPerMinute: number;
  heapSlopeBytesPerMinute: number;
  positiveRssStepRatio: number;
  positiveHeapStepRatio: number;
  suspicious: boolean;
  reasons: Array<"rss_sustained_growth" | "heap_sustained_growth">;
}

export const DEFAULT_MEMORY_TREND_THRESHOLDS: MemoryTrendThresholds = {
  minSamples: 4,
  minWindowMs: 2 * 60_000,
  minRssGrowthBytes: 128 * 1024 * 1024,
  minHeapGrowthBytes: 96 * 1024 * 1024,
  minSlopeBytesPerMinute: 24 * 1024 * 1024,
  minPositiveStepRatio: 2 / 3,
};

function boundedSample(value: MemoryTrendSample): boolean {
  return Number.isSafeInteger(value.at) && value.at > 0 &&
    Number.isFinite(value.rssBytes) && value.rssBytes >= 0 &&
    Number.isFinite(value.heapUsedBytes) && value.heapUsedBytes >= 0;
}

export function trimMemoryTrendSamples(
  samples: readonly MemoryTrendSample[],
  maxSamples = 30,
): MemoryTrendSample[] {
  const safeMax = Math.max(2, Math.min(240, Math.floor(maxSamples)));
  return samples.filter(boundedSample).slice(-safeMax);
}

export function assessMemoryTrend(
  input: readonly MemoryTrendSample[],
  overrides: Partial<MemoryTrendThresholds> = {},
): MemoryTrendAssessment {
  const thresholds = { ...DEFAULT_MEMORY_TREND_THRESHOLDS, ...overrides };
  const samples = trimMemoryTrendSamples(input, 240)
    .sort((a, b) => a.at - b.at);
  if (samples.length < 2) {
    return {
      sampleCount: samples.length, windowMs: 0,
      rssGrowthBytes: 0, heapGrowthBytes: 0,
      rssSlopeBytesPerMinute: 0, heapSlopeBytesPerMinute: 0,
      positiveRssStepRatio: 0, positiveHeapStepRatio: 0,
      suspicious: false, reasons: [],
    };
  }

  const first = samples[0], last = samples[samples.length - 1];
  const windowMs = Math.max(0, last.at - first.at);
  const minutes = Math.max(windowMs / 60_000, 1 / 60);
  const rssGrowthBytes = last.rssBytes - first.rssBytes;
  const heapGrowthBytes = last.heapUsedBytes - first.heapUsedBytes;
  let rssPositive = 0, heapPositive = 0;
  const steps = samples.length - 1;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].rssBytes > samples[index - 1].rssBytes) rssPositive++;
    if (samples[index].heapUsedBytes > samples[index - 1].heapUsedBytes) heapPositive++;
  }
  const positiveRssStepRatio = steps > 0 ? rssPositive / steps : 0;
  const positiveHeapStepRatio = steps > 0 ? heapPositive / steps : 0;
  const rssSlopeBytesPerMinute = rssGrowthBytes / minutes;
  const heapSlopeBytesPerMinute = heapGrowthBytes / minutes;
  const enoughEvidence = samples.length >= thresholds.minSamples &&
    windowMs >= thresholds.minWindowMs;
  const rssSuspicious = enoughEvidence &&
    rssGrowthBytes >= thresholds.minRssGrowthBytes &&
    rssSlopeBytesPerMinute >= thresholds.minSlopeBytesPerMinute &&
    positiveRssStepRatio >= thresholds.minPositiveStepRatio;
  const heapSuspicious = enoughEvidence &&
    heapGrowthBytes >= thresholds.minHeapGrowthBytes &&
    heapSlopeBytesPerMinute >= thresholds.minSlopeBytesPerMinute &&
    positiveHeapStepRatio >= thresholds.minPositiveStepRatio;
  const reasons: MemoryTrendAssessment["reasons"] = [];
  if (rssSuspicious) reasons.push("rss_sustained_growth");
  if (heapSuspicious) reasons.push("heap_sustained_growth");
  return {
    sampleCount: samples.length, windowMs,
    rssGrowthBytes, heapGrowthBytes,
    rssSlopeBytesPerMinute, heapSlopeBytesPerMinute,
    positiveRssStepRatio, positiveHeapStepRatio,
    suspicious: reasons.length > 0, reasons,
  };
}
