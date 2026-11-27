/**
 * desktopUiMetrics.ts — bounded, in-process observability for Desktop UI perception.
 *
 * Why this exists: warm snapshot cost, carrier fallbacks and wait_ready churn are
 * invisible to operators and to the model that chooses between snapshot and
 * wait_ready. These metrics answer "which carrier is serving frames, how slow is
 * perception, and is the host settling?" without reading window metadata.
 *
 * Hard bounds, by construction:
 * - fixed counters (no labels, no ids, no titles, no paths, no tokens),
 * - fixed-bucket histograms (no unbounded sampling arrays),
 * - a single "last" value per signal.
 *
 * Nothing here is persisted, authoritative, or part of any permission decision.
 */

export const DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 150, 200, 300, 500, 750, 1_000, 2_000, 5_000,
] as const;

/** Diagnostic change-ratio buckets; 0.12 is the historical stability budget. */
export const DESKTOP_UI_CHANGE_RATIO_BUCKETS = [
  0, 0.001, 0.01, 0.05, 0.12, 0.25, 0.5, 1,
] as const;

const MAX_RECORDED_LATENCY_MS = 3_600_000;

interface HistogramState {
  readonly buckets: readonly number[];
  readonly counts: number[];
  count: number;
  sum: number;
  max: number;
}

function createHistogram(buckets: readonly number[]): HistogramState {
  return { buckets, counts: new Array(buckets.length + 1).fill(0), count: 0, sum: 0, max: 0 };
}

function observe(histogram: HistogramState, value: number): void {
  histogram.count += 1;
  histogram.sum += value;
  if (value > histogram.max) histogram.max = value;
  let index = histogram.buckets.findIndex((bound) => value <= bound);
  if (index === -1) index = histogram.buckets.length;
  histogram.counts[index] += 1;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export interface DesktopUiCounterSnapshot {
  sessionsOpened: number;
  snapshotsTotal: number;
  snapshotsOk: number;
  snapshotsFailed: number;
  waitReadyCalls: number;
  waitReadyAttempts: number;
  persistentCaptureFrames: number;
  oneShotCaptureFrames: number;
  captureSourceFallbacks: number;
  carrierPrewarmOk: number;
  carrierPrewarmFailed: number;
}

export interface DesktopUiHistogramSnapshot {
  buckets: number[];
  /** One more entry than `buckets`: the overflow bucket. */
  counts: number[];
  count: number;
  sum: number;
  max: number;
}

export interface DesktopUiMetricsSnapshot {
  version: 1;
  uptimeMs: number;
  counters: DesktopUiCounterSnapshot;
  histograms: {
    snapshotLatencyMs: DesktopUiHistogramSnapshot;
    snapshotChangeRatio: DesktopUiHistogramSnapshot;
  };
  last: {
    snapshotAtMs: number | null;
    snapshotLatencyMs: number | null;
    snapshotOk: boolean | null;
    changeRatioAtMs: number | null;
    changeRatio: number | null;
    waitReadyAtMs: number | null;
    waitReadyAttempts: number | null;
  };
}

const startedAtMs = Date.now();

const counters: DesktopUiCounterSnapshot = {
  sessionsOpened: 0,
  snapshotsTotal: 0,
  snapshotsOk: 0,
  snapshotsFailed: 0,
  waitReadyCalls: 0,
  waitReadyAttempts: 0,
  persistentCaptureFrames: 0,
  oneShotCaptureFrames: 0,
  captureSourceFallbacks: 0,
  carrierPrewarmOk: 0,
  carrierPrewarmFailed: 0,
};

const snapshotLatency = createHistogram(DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS);
const snapshotChangeRatio = createHistogram(DESKTOP_UI_CHANGE_RATIO_BUCKETS);

const last: DesktopUiMetricsSnapshot["last"] = {
  snapshotAtMs: null,
  snapshotLatencyMs: null,
  snapshotOk: null,
  changeRatioAtMs: null,
  changeRatio: null,
  waitReadyAtMs: null,
  waitReadyAttempts: null,
};

/** One completed perception attempt (success or failure). */
export function recordSnapshotSample(input: {
  latencyMs: number;
  ok: boolean;
  changeRatio?: number | null;
}): void {
  const latency = finiteNonNegative(input.latencyMs) ?? 0;
  counters.snapshotsTotal += 1;
  if (input.ok) counters.snapshotsOk += 1;
  else counters.snapshotsFailed += 1;
  observe(snapshotLatency, Math.min(latency, MAX_RECORDED_LATENCY_MS));
  last.snapshotAtMs = Date.now();
  last.snapshotLatencyMs = Math.round(latency * 100) / 100;
  last.snapshotOk = input.ok;

  const ratio = finiteNonNegative(input.changeRatio);
  if (ratio !== null) {
    const bounded = Math.min(ratio, 1);
    observe(snapshotChangeRatio, bounded);
    last.changeRatioAtMs = last.snapshotAtMs;
    last.changeRatio = Math.round(bounded * 10_000) / 10_000;
  }
}

/** One waiter poll attempt (bounded external retry loop). */
export function recordWaitReadyAttempt(): void {
  counters.waitReadyAttempts += 1;
}

/** One completed wait_ready call, including the attempts it needed. */
export function recordWaitReadyComplete(attempts: number): void {
  counters.waitReadyCalls += 1;
  last.waitReadyAtMs = Date.now();
  last.waitReadyAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0;
}

export function recordCaptureFrame(kind: "persistent" | "one-shot"): void {
  if (kind === "persistent") counters.persistentCaptureFrames += 1;
  else counters.oneShotCaptureFrames += 1;
}

/** The persistent capture worker refused and the session fell back to one-shot. */
export function recordCaptureSourceFallback(): void {
  counters.captureSourceFallbacks += 1;
}

export function recordCarrierPrewarm(ok: boolean): void {
  if (ok) counters.carrierPrewarmOk += 1;
  else counters.carrierPrewarmFailed += 1;
}

export function recordSessionOpened(): void {
  counters.sessionsOpened += 1;
}

function histogramSnapshot(state: HistogramState): DesktopUiHistogramSnapshot {
  return {
    buckets: [...state.buckets],
    counts: [...state.counts],
    count: state.count,
    sum: state.sum,
    max: state.max,
  };
}

/**
 * Bounded read-only payload for the `stats` command. A fresh object is built on
 * every call so callers cannot mutate the live counters.
 */
export function getDesktopUiMetricsSnapshot(): DesktopUiMetricsSnapshot {
  return {
    version: 1,
    uptimeMs: Date.now() - startedAtMs,
    counters: { ...counters },
    histograms: {
      snapshotLatencyMs: histogramSnapshot(snapshotLatency),
      snapshotChangeRatio: histogramSnapshot(snapshotChangeRatio),
    },
    last: { ...last },
  };
}

/** Test seam: clear all in-process metrics. Never called from production paths. */
export function resetDesktopUiMetrics(): void {
  for (const key of Object.keys(counters) as Array<keyof DesktopUiCounterSnapshot>) {
    counters[key] = 0;
  }
  for (const histogram of [snapshotLatency, snapshotChangeRatio]) {
    histogram.counts.fill(0);
    histogram.count = 0;
    histogram.sum = 0;
    histogram.max = 0;
  }
  for (const key of Object.keys(last) as Array<keyof DesktopUiMetricsSnapshot["last"]>) {
    last[key] = null;
  }
}
