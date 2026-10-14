import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SelfDevEventStore } from "../src/core/selfdev/eventStore.js";
import { buildPromptInjectionBlock } from "../src/core/selfdev/injector.js";
import { isValidLesson } from "../src/core/selfdev/lessonValidation.js";
import type { SelfDevEventInput, SelfDevLesson, SelfDevStoreData, SqliteDbLike } from "../src/core/selfdev/types.js";

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(label: string, samples: number[]): Record<string, number | string> {
  return {
    label,
    samples: samples.length,
    p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
    mean_ms: Number((samples.reduce((sum, value) => sum + value, 0) / Math.max(samples.length, 1)).toFixed(3)),
  };
}

function event(id: string, workspace: string): SelfDevEventInput {
  return {
    id,
    ts: Date.now(),
    sessionId: "selfdev-benchmark",
    workspace,
    kind: "test_result",
    summary: "Selfdev benchmark event; no real user task content.",
    tags: ["benchmark"],
    payload: { passed: true, failed: 0 },
  };
}

function lesson(index: number, workspace: string, status: "candidate" | "active"): SelfDevLesson {
  const now = Date.now();
  const base: SelfDevLesson = {
    id: `benchmark-lesson-${index}`,
    workspace,
    statement: status === "active"
      ? `Always verify workflow step ${index} with a focused test before proceeding.`
      : `Candidate workflow observation ${index}; collect evidence before changing behavior.`,
    rationale: "Synthetic benchmark fixture only.",
    evidenceIds: [`event-${index}`],
    tags: ["benchmark"],
    version: 1,
    status,
    createdAt: now - 100,
    updatedAt: now,
  };
  if (status === "active") {
    base.approvedBy = "benchmark-fixture";
    base.approvedAt = now - 50;
  }
  return base;
}

/**
 * Reference path copied from the pre-validation injector behavior (HEAD before this
 * implementation): it checks basic store shape and workspace/status but does not
 * structurally validate each lesson. The fixture is synthetic and valid by design.
 * This is a comparison reference, never used by runtime application code.
 */
async function buildPreValidationReferenceBlock(options: {
  workspace: string;
  storePath: string;
  config?: { enabled?: boolean; injectionEnabled?: boolean };
}): Promise<string> {
  if (options.config?.enabled === false || options.config?.injectionEnabled === false) return "";
  if (!path.isAbsolute(options.storePath)) return "";
  try {
    const info = await stat(options.storePath);
    if (info.size > 16 * 1024 * 1024) return "";
    const content = await readFile(options.storePath, "utf8");
    if (!content.trim()) return "";
    const data = JSON.parse(content) as SelfDevStoreData;
    if (!data || !Array.isArray(data.lessons)) return "";
    const active = data.lessons
      .filter(item => item.workspace === options.workspace && item.status === "active")
      .sort((a, b) => (b.approvedAt ?? b.updatedAt) - (a.approvedAt ?? a.updatedAt))
      .slice(0, 5);
    if (active.length === 0) return "";
    const lines = active.map(item => {
      const statement = item.statement.length > 280 ? item.statement.slice(0, 277) + "..." : item.statement;
      return `- ${statement}`;
    });
    return [
      "=== WORKSPACE OPERATIONAL LESSONS ===",
      "The following advisory lessons were previously verified and approved for this workspace:",
      ...lines,
      "Use these operational lessons as helpful context to avoid previously encountered issues.",
      "=====================================",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Models the just-before-optimization validated path: validate every lesson
 * first, then filter by workspace and active status. Compared to the current
 * implementation, only the filter order differs.
 */
async function buildValidateAllReferenceBlock(options: {
  workspace: string;
  storePath: string;
  config?: { enabled?: boolean; injectionEnabled?: boolean };
}): Promise<string> {
  if (options.config?.enabled === false || options.config?.injectionEnabled === false) return "";
  if (!path.isAbsolute(options.storePath)) return "";
  try {
    const info = await stat(options.storePath);
    if (info.size > 16 * 1024 * 1024) return "";
    const content = await readFile(options.storePath, "utf8");
    if (!content.trim()) return "";
    const data = JSON.parse(content) as SelfDevStoreData;
    if (!data || !Array.isArray(data.lessons)) return "";
    const active = data.lessons
      .filter(item => isValidLesson(item) && item.workspace === options.workspace && item.status === "active")
      .sort((a, b) => (b.approvedAt ?? b.updatedAt) - (a.approvedAt ?? a.updatedAt))
      .slice(0, 5);
    if (active.length === 0) return "";
    const lines = active.map(item => {
      const statement = item.statement.length > 280 ? item.statement.slice(0, 277) + "..." : item.statement;
      return "- " + statement;
    });
    return [
      "=== WORKSPACE OPERATIONAL LESSONS ===",
      "The following advisory lessons were previously verified and approved for this workspace:",
      ...lines,
      "Use these operational lessons as helpful context to avoid previously encountered issues.",
      "=====================================",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Repeatable local benchmark, no network access, provider calls, or real workspace content.
 * Run with: bun run scripts/bench-selfdev.ts
 */
async function main(): Promise<void> {
  const workspace = "selfdev-benchmark-workspace";
  const db = new DatabaseSync(":memory:");
  const eventStore = new SelfDevEventStore({
    workspace,
    getDb: () => db as unknown as SqliteDbLike,
    config: { enabled: true, collectionEnabled: true, maxEventsPerWorkspace: 5000 },
  });
  const tempDir = await mkdtemp(path.join(tmpdir(), "superagent-selfdev-bench-"));
  const storePath = path.join(tempDir, "lessons.json");

  try {
    const singleSamples: number[] = [];
    for (let i = 0; i < 250; i++) {
      const start = performance.now();
      eventStore.record(event(`single-${i}`, workspace));
      const elapsed = performance.now() - start;
      if (i >= 25) singleSamples.push(elapsed);
    }

    const batchSamples: number[] = [];
    let batchIndex = 0;
    for (let batch = 0; batch < 25; batch++) {
      const items = Array.from({ length: 10 }, () => event(`batch-${batchIndex++}`, workspace));
      const start = performance.now();
      eventStore.recordBatch(items);
      const elapsed = performance.now() - start;
      if (batch >= 3) batchSamples.push(elapsed / items.length);
    }

    const lessons: SelfDevLesson[] = [
      ...Array.from({ length: 5 }, (_, index) => lesson(index, workspace, "active")),
      ...Array.from({ length: 495 }, (_, index) => lesson(index + 5, workspace, "candidate")),
    ];
    const storeData: SelfDevStoreData = {
      schemaVersion: 1,
      updatedAt: Date.now(),
      lessons,
    };
    await writeFile(storePath, JSON.stringify(storeData), { encoding: "utf8", mode: 0o600 });

    const injectionOptions = {
      workspace,
      storePath,
      config: { enabled: true, injectionEnabled: true, redactSecrets: true },
    };
    const injectionReferenceSamples: number[] = [];
    const validatedBeforeOptimizationSamples: number[] = [];
    const injectionSamples: number[] = [];
    // Interleave all versions to reduce ordering / warm-cache bias.
    for (let i = 0; i < 70; i++) {
      let start = performance.now();
      const reference = await buildPreValidationReferenceBlock(injectionOptions);
      const referenceElapsed = performance.now() - start;
      start = performance.now();
      const validatedBeforeOptimization = await buildValidateAllReferenceBlock(injectionOptions);
      const validatedBeforeOptimizationElapsed = performance.now() - start;
      start = performance.now();
      const current = await buildPromptInjectionBlock(injectionOptions);
      const currentElapsed = performance.now() - start;
      if (!reference.includes("WORKSPACE OPERATIONAL LESSONS") ||
          !validatedBeforeOptimization.includes("WORKSPACE OPERATIONAL LESSONS") ||
          !current.includes("WORKSPACE OPERATIONAL LESSONS")) {
        throw new Error("Benchmark fixture failed to inject active lessons");
      }
      if (i >= 10) {
        injectionReferenceSamples.push(referenceElapsed);
        validatedBeforeOptimizationSamples.push(validatedBeforeOptimizationElapsed);
        injectionSamples.push(currentElapsed);
      }
    }

    const noActivePath = path.join(tempDir, "lessons-no-active.json");
    const noActiveLessons = Array.from({ length: 500 }, (_, index) => lesson(index + 1000, workspace, "candidate"));
    await writeFile(noActivePath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: Date.now(),
      lessons: noActiveLessons,
    } satisfies SelfDevStoreData), { encoding: "utf8", mode: 0o600 });
    const noActiveSamples: number[] = [];
    for (let i = 0; i < 45; i++) {
      const start = performance.now();
      const result = await buildPromptInjectionBlock({ ...injectionOptions, storePath: noActivePath });
      const elapsed = performance.now() - start;
      if (result !== "") throw new Error("No-active-lesson fixture must not create an injection block");
      if (i >= 5) noActiveSamples.push(elapsed);
    }

    const referenceP95 = percentile(injectionReferenceSamples, 0.95);
    const validatedBeforeOptimizationP95 = percentile(validatedBeforeOptimizationSamples, 0.95);
    const currentP95 = percentile(injectionSamples, 0.95);
    const optimizationP95DeltaPercent = validatedBeforeOptimizationP95 > 0
      ? Number((((currentP95 - validatedBeforeOptimizationP95) / validatedBeforeOptimizationP95) * 100).toFixed(1))
      : 0;
    const validationP95DeltaPercent = referenceP95 > 0
      ? Number((((currentP95 - referenceP95) / referenceP95) * 100).toFixed(1))
      : 0;

    const output = {
      benchmark: "Selfdev before/after injector filter-order optimization",
      generatedAt: new Date().toISOString(),
      environment: {
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
        platform: process.platform,
        arch: process.arch,
        eventSamples: singleSamples.length,
        batchEventsPerSample: 10,
        injectionStoreLessons: lessons.length,
        injectedActiveLessons: 5,
        noActiveLessonStoreLessons: noActiveLessons.length,
        injectionSamplesPerVariant: injectionSamples.length,
      },
      results: [
        summarize("event_store_single_record", singleSamples),
        summarize("event_store_batch_record_per_event", batchSamples),
        summarize("prompt_injection_pre_validation_reference_500_lesson_store", injectionReferenceSamples),
        summarize("prompt_injection_before_filter_optimization_validate_all_500", validatedBeforeOptimizationSamples),
        summarize("prompt_injection_after_filter_optimization_validate_eligible_500", injectionSamples),
        summarize("prompt_injection_current_500_candidates_zero_active", noActiveSamples),
      ],
      comparison: {
        metric: "prompt-injection p95",
        beforeOptimizationMs: Number(validatedBeforeOptimizationP95.toFixed(3)),
        afterOptimizationMs: Number(currentP95.toFixed(3)),
        beforeAfterDeltaPercent: optimizationP95DeltaPercent,
        preValidationReferenceMs: Number(referenceP95.toFixed(3)),
        currentVsReferenceDeltaPercent: validationP95DeltaPercent,
        interpretation: "Before/after isolates validating all 500 lessons first versus cheap workspace/status filtering before validating eligible active lessons. The pre-validation reference shows the overhead of maintaining structural validation compared to the previous behavior.",
      },
      notes: [
        "Synthetic data only; no provider/network calls.",
        "Single and batch event results measure store writes including validation, roundtrips, and retention.",
        "The reference injector mirrors the previous implementation from repository HEAD (basic shape checks, no per-lesson structural validation); it is benchmark-only and never used for application behavior.",
        "Reference and current injector calls are interleaved on the same process/runtime/store. Compare only on the same machine/runtime.",
        "The 500-candidate case measures the no-approved-lesson path, which must return an empty block.",
      ],
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Selfdev benchmark failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
