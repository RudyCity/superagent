import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  planMotionStoryboardFromPrompt, previewApprovedMotionStoryboard, renderApprovedMotionStoryboard,
  type MotionDirectorPlan,
} from "../src/core/motion/director/directorService.js";
import { getMotionProject, listMotionProjects } from "../src/core/motion/project/projectStore.js";
import type { MotionJob } from "../src/core/motion/jobs/motionJobs.js";

const plan: MotionDirectorPlan = {
  name: "Launch Review", background: "#171B28", durationSeconds: 3,
  artDirection: "minimal", transition: "crossfade", aspectRatio: "16:9",
  scenes: [
    { headline: "Laris makin cepat", subtitle: "Promosi baru", accent: "#FFCA32", layout: "left" },
    { headline: "Mulai sekarang", accent: "#00B8FF", layout: "center" },
  ],
};
describe("AI Motion Director 2.0 approval workflow", () => {
  it("plans with the original strict model schema without writing a project", async () => {
    const planner = vi.fn(async () => plan);
    const result = await planMotionStoryboardFromPrompt("Clean simple video promo", { planner });
    expect(result.artDirection).toBe("minimal");
    expect(result.scenes).toHaveLength(2);
    expect(planner).toHaveBeenCalledOnce();
    await expect(planMotionStoryboardFromPrompt("new", {
      planner: async () => ({ ...plan, injected: "shell" }),
    })).rejects.toThrow();
  });
  it("previews a reviewed plan without persistence, then creates a revisioned render job", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "storyboard-preview-"));
    try {
      const preview = await previewApprovedMotionStoryboard(workspace, plan);
      expect(preview.schemaVersion).toBe(1);
      expect(preview.composition.durationFrames).toBe(90);
      expect((await listMotionProjects(workspace))).toHaveLength(0);
      const renderer = vi.fn(async (_ws, id) => ({
        id: "motionjob-" + "a".repeat(24), status: "queued" as const,
        projectId: id, revision: 2,
      } as MotionJob));
      const rendered = await renderApprovedMotionStoryboard(workspace, {
        ...plan, scenes: [{ ...plan.scenes[0], headline: "Sudah disetujui" }, plan.scenes[1]],
      }, { width: 640, renderer });
      expect(rendered.project.revision).toBe(2);
      expect(rendered.outline[0]).toBe("Sudah disetujui");
      expect(rendered.job.status).toBe("queued");
      expect(renderer).toHaveBeenCalledOnce();
      expect((await listMotionProjects(workspace))).toHaveLength(1);
      expect((await getMotionProject(workspace, rendered.project.id)).composition)
        .toEqual(rendered.project.composition);
      await expect(renderApprovedMotionStoryboard(workspace, { ...plan, scenes: [] },
        { width: 640, renderer })).rejects.toThrow();
      expect((await listMotionProjects(workspace))).toHaveLength(1);
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });
});
