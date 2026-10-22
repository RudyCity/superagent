/** Bounded process-local RMemory metrics, never storing query text or secrets. */
const durations: number[] = [];
const MAX_SAMPLES = 256;
const stats = { searches: 0, errors: 0, results: 0, cacheHits: 0, ingested: 0, skippedDuplicates: 0 };

export function recordMemorySearchPerformance(milliseconds: number, resultCount: number, failed = false): void {
  stats.searches++;
  if (failed) stats.errors++;
  stats.results += Math.max(0, resultCount);
  durations.push(Math.max(0, Math.min(60000, milliseconds)));
  if (durations.length > MAX_SAMPLES) durations.shift();
}

export function recordMemoryIngestion(inserted: number, duplicates: number): void {
  stats.ingested += Math.max(0, inserted);
  stats.skippedDuplicates += Math.max(0, duplicates);
}
export function recordMemoryCacheHit(): void { stats.cacheHits++; }

export function getMemoryPerformanceSnapshot() {
  const sorted = [...durations].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
  return { ...stats, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), samples: sorted.length } };
}
export function resetMemoryPerformanceMetrics(): void {
  durations.length = 0;
  Object.keys(stats).forEach((key) => { (stats as any)[key] = 0; });
}
