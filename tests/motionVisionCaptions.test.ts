import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import { createMotionProject, updateMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import { compileDirectorPlan } from "../src/core/motion/director/directorService.js";
import { motionSceneCaptions, motionSceneSrt } from "../src/core/motion/director/motionCaptions.js";
import { inspectMotionVision, validateMotionVisionResponse, autoRepairMotionVision,
  withMotionVisionLease } from "../src/core/motion/director/motionVisionReview.js";
const dirs: string[] = [];
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-review-test-"));
  dirs.push(root);
  const project = await createMotionProject(root, "Visual QA and captions");
  const composition = compileDirectorPlan({
    name: "Visual QA and captions", durationSeconds: 6, background: "#141B2B", transition: "cut",
    scenes: [
      { headline: "Fresh product", subtitle: "Now available", accent: "#F8CD24" },
      { headline: "Second product", subtitle: "Special offer", accent: "#F8CD24" },
    ],
  });
  const updated = await updateMotionProject(root, project.id, project.revision, [
    { type: "replace-composition", composition },
  ]);
  return { root, project: updated };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
describe("Motion captions / optional image-model review (no untrusted commands)", () => {
  it("exports non-overlapping SRT with real timeline timecodes and plain user text", async () => {
    const { project } = await setup();
    const intervals = motionSceneCaptions(project);
    expect(intervals).toHaveLength(2);
    expect(intervals[0].start).toBe(0);
    expect(intervals[0].end).toBeCloseTo(3, 5);
    expect(intervals[1].start).toBeCloseTo(3, 5);
    expect(intervals[1].end).toBeCloseTo(6, 5);
    const srt = motionSceneSrt(project);
    expect(srt).toContain("00:00:00,000 --> 00:00:03,000");
    expect(srt).toContain("00:00:03,000 --> 00:00:06,000");
    expect(srt).toContain("Fresh product\nNow available");
    expect(srt).toContain("Second product\nSpecial offer");
  });
  it("passes real PNG pixels into injected reviewer and validates bounded feedback", async () => {
    const { root, project } = await setup();
    const reviewer = vi.fn().mockImplementation(async (_system, images) => {
      expect(images).toHaveLength(2);
      for (const item of images) {
        expect(item.png.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
        expect(item.png.length).toBeGreaterThan(500);
      }
      return {
        passed: false,
        issues: [{ frame: images[0].frame, category: "readability", severity: "warning",
          explanation: "The title is small", suggestion: "Increase font size" }],
      };
    });
    const review = await inspectMotionVision(root, project, reviewer);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(review.projectId).toBe(project.id);
    expect(review.revision).toBe(project.revision);
    expect(review.type).toBe("model-vision-sampled-frames");
    expect(review.issues).toHaveLength(1);
    expect((await getMotionProject(root, project.id)).revision).toBe(project.revision);
  });
  it("refuses arbitrary model fields, non-sampled frame IDs and inconsistent verdicts", async () => {
    const { project } = await setup();
    const frames = [45, 135];
    expect(() => validateMotionVisionResponse({ passed: true, issues: [],
      execute: "arbitrary" }, project, frames)).toThrow(/Invalid/);
    expect(() => validateMotionVisionResponse({ passed: false, issues: [{
      frame: 999, category: "other", severity: "error", explanation: "Bad", suggestion: "Fix",
    }] }, project, frames)).toThrow(/Invalid/);
    expect(() => validateMotionVisionResponse({ passed: true, issues: [{
      frame: 45, category: "other", severity: "error", explanation: "Bad", suggestion: "Fix",
    }] }, project, frames)).toThrow(/verdict/);
    expect(() => validateMotionVisionResponse({ passed: true, issues: [{ frame: 45,
      category: "other", severity: "warning", explanation: "x".repeat(800), suggestion: "Fix",
    }] }, project, frames)).toThrow(/Invalid/);
  });
  it("performs at most one approved visual revision, renders MP4 and preserves layer scope", async () => {
    if (!await probeFfmpeg()) return;
    const { root, project } = await setup();
    const reviewer = vi.fn().mockImplementation(async (_system, images) => ({
      passed: false, issues: [{
        frame: images[0].frame, category: "layout", severity: "error",
        explanation: "The title is too close to the edge", suggestion: "Move the first title slightly right",
      }],
    }));
    const planner = vi.fn().mockResolvedValue({
      edits: [{ type: "set-property", layerId: "scene-0-title", property: "x", value: 250 }],
    });
    const repaired = await autoRepairMotionVision(root, project.id, {
      baseRevision: project.revision, width: 160, reviewer, planner,
    });
    expect(repaired.changed).toBe(true);
    if (!repaired.changed) throw new Error("Expected a revision");
    expect(repaired.result.project.revision).toBe(project.revision + 1);
    expect(repaired.result.project.composition.layers.find(layer => layer.id === "scene-0-title")?.x).toBe(250);
    expect(planner).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledTimes(1);
    await expect(autoRepairMotionVision(root, project.id, {
      baseRevision: project.revision, reviewer, planner,
    })).rejects.toThrow(/revision conflict/);
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await getMotionJob(root, repaired.result.job.id);
      if (["completed", "failed", "interrupted", "cancelled"].includes(job.status)) {
        expect(job.status, job.error).toBe("completed");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Visual revision MP4 render did not reach a terminal state");
  }, 60000);

  it("does not mutate anything when model passes, and refuses concurrent model review", async () => {
    const { root, project } = await setup();
    const passed = await autoRepairMotionVision(root, project.id, {
      baseRevision: project.revision,
      reviewer: async () => ({ passed: true, issues: [] }),
      planner: vi.fn(),
    });
    expect(passed.changed).toBe(false);
    expect((await getMotionProject(root, project.id)).revision).toBe(project.revision);
    await withMotionVisionLease(root, project.id, async () => {
      await expect(withMotionVisionLease(root, project.id, async () => "unreachable"))
        .rejects.toMatchObject({ statusCode: 409 });
    });
    await expect(withMotionVisionLease(root, project.id, async () => "released"))
      .resolves.toBe("released");
  });

  it("rejects cross-workspace asset references before model is invoked", async () => {
    const { project } = await setup();
    const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "motion-review-foreign-"));
    dirs.push(foreign);
    const imported = await import("../src/core/motion/assets/motionAssets.js");
    const canvas = createCanvas(120, 80);
    canvas.getContext("2d").fillRect(0, 0, 100, 80);
    const asset = await imported.importMotionAsset(foreign, canvas.toBuffer("image/png"));
    project.composition.layers.push({ kind: "image", id: "outside-brand", assetId: asset.id, x: 0, y: 0,
      width: 120, height: 80, rotation: 0, opacity: 1, fill: "#FFFFFF", tracks: [] });
    const reviewer = vi.fn();
    await expect(inspectMotionVision(project.workspaceRoot, project, reviewer)).rejects.toThrow();
    expect(reviewer).not.toHaveBeenCalled();
  });
});
