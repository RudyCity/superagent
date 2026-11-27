import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_UI_CHANGE_RATIO_BUCKETS,
  DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS,
  getDesktopUiMetricsSnapshot,
  recordCaptureFrame,
  recordCaptureSourceFallback,
  recordCarrierPrewarm,
  recordSessionOpened,
  recordSnapshotSample,
  recordWaitReadyAttempt,
  recordWaitReadyComplete,
  resetDesktopUiMetrics,
} from "../../src/core/desktopUi/desktopUiMetrics.js";

afterEach(() => resetDesktopUiMetrics());

describe("desktop UI metrics", () => {
  it("starts empty and exposes only fixed buckets", () => {
    const snapshot = getDesktopUiMetricsSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.counters).toMatchObject({
      snapshotsTotal: 0,
      snapshotsOk: 0,
      snapshotsFailed: 0,
      waitReadyCalls: 0,
      waitReadyAttempts: 0,
    });
    expect(snapshot.histograms.snapshotLatencyMs.buckets).toEqual([...DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS]);
    expect(snapshot.histograms.snapshotLatencyMs.counts).toHaveLength(DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS.length + 1);
    expect(snapshot.histograms.snapshotChangeRatio.buckets).toEqual([...DESKTOP_UI_CHANGE_RATIO_BUCKETS]);
    expect(snapshot.last.snapshotLatencyMs).toBeNull();
  });

  it("counts snapshots, records last latency and places values in fixed buckets", () => {
    recordSnapshotSample({ latencyMs: 12, ok: true });
    recordSnapshotSample({ latencyMs: 250, ok: false });
    recordSnapshotSample({ latencyMs: 10_000, ok: true });

    const snapshot = getDesktopUiMetricsSnapshot();
    expect(snapshot.counters.snapshotsTotal).toBe(3);
    expect(snapshot.counters.snapshotsOk).toBe(2);
    expect(snapshot.counters.snapshotsFailed).toBe(1);
    expect(snapshot.last.snapshotOk).toBe(true);
    expect(snapshot.last.snapshotLatencyMs).toBe(10_000);

    const latency = snapshot.histograms.snapshotLatencyMs;
    expect(latency.count).toBe(3);
    expect(latency.sum).toBe(10_262);
    expect(latency.max).toBe(10_000);
    // 12ms lands in the 25ms bucket, 250ms in 300ms, and 10s in overflow.
    expect(latency.counts[DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS.indexOf(25)]).toBe(1);
    expect(latency.counts[DESKTOP_UI_SNAPSHOT_LATENCY_BUCKETS_MS.indexOf(300)]).toBe(1);
    expect(latency.counts[latency.counts.length - 1]).toBe(1);
  });

  it("records bounded change ratios and ignores invalid samples", () => {
    recordSnapshotSample({ latencyMs: 40, ok: true, changeRatio: 0.004 });
    recordSnapshotSample({ latencyMs: Number.NaN, ok: true, changeRatio: Number.POSITIVE_INFINITY });
    recordSnapshotSample({ latencyMs: -5, ok: false, changeRatio: -1 });

    const snapshot = getDesktopUiMetricsSnapshot();
    expect(snapshot.last.changeRatio).toBe(0.004);
    expect(snapshot.histograms.snapshotChangeRatio.count).toBe(1);
    expect(snapshot.last.snapshotLatencyMs).toBe(0);
    expect(Number.isFinite(snapshot.histograms.snapshotLatencyMs.sum)).toBe(true);
  });

  it("tracks wait_ready calls and attempts without storing content", () => {
    recordWaitReadyAttempt();
    recordWaitReadyAttempt();
    recordWaitReadyComplete(2);

    const snapshot = getDesktopUiMetricsSnapshot();
    expect(snapshot.counters.waitReadyAttempts).toBe(2);
    expect(snapshot.counters.waitReadyCalls).toBe(1);
    expect(snapshot.last.waitReadyAttempts).toBe(2);
    expect(snapshot.last.waitReadyAtMs).toEqual(expect.any(Number));
  });

  it("tracks carrier health, fallbacks and session opens", () => {
    recordCaptureFrame("persistent");
    recordCaptureFrame("persistent");
    recordCaptureFrame("one-shot");
    recordCaptureSourceFallback();
    recordCarrierPrewarm(true);
    recordCarrierPrewarm(false);
    recordSessionOpened();

    const snapshot = getDesktopUiMetricsSnapshot();
    expect(snapshot.counters.persistentCaptureFrames).toBe(2);
    expect(snapshot.counters.oneShotCaptureFrames).toBe(1);
    expect(snapshot.counters.captureSourceFallbacks).toBe(1);
    expect(snapshot.counters.carrierPrewarmOk).toBe(1);
    expect(snapshot.counters.carrierPrewarmFailed).toBe(1);
    expect(snapshot.counters.sessionsOpened).toBe(1);
  });

  it("returns a detached bounded copy", () => {
    recordSnapshotSample({ latencyMs: 30, ok: true, changeRatio: 0.02 });
    const first = getDesktopUiMetricsSnapshot();
    first.counters.snapshotsTotal = 99;
    first.histograms.snapshotLatencyMs.counts.fill(7);
    first.last.snapshotLatencyMs = 1;

    const second = getDesktopUiMetricsSnapshot();
    expect(second.counters.snapshotsTotal).toBe(1);
    expect(second.histograms.snapshotLatencyMs.counts.every((value) => value <= 1)).toBe(true);
    expect(second.last.snapshotLatencyMs).toBe(30);

    // The payload is numbers only: nothing here can leak a title, path or token.
    const numericOnly = JSON.stringify(second);
    expect(numericOnly).not.toMatch(/[A-Za-z]:\\\\|[\\/](?:Users|home|var|tmp)[\\/]/);
  });
});
