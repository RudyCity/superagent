import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject, getMotionProject, listMotionProjects } from "../src/core/motion/project/projectStore.js";
import { createMotionBatchVariants } from "../src/core/motion/motionBatchVariants.js";
import { MotionRevisionConflict } from "../src/core/motion/project/revisions.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";

const scheduler = async () => ({ queued: 0, queueLimit: 12 });
describe("Motion batch aspect variants", () => {
  it("materializes 3 distinct revisioned projects without touching the source, and queues only their render jobs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-variants-"));
    try {
      const original = await createMotionProject(workspace, "Three variants");
      const queued: string[] = [];
      const response = await createMotionBatchVariants(workspace, original.id, 1,
        ["16:9", "1:1", "9:16"], {
          scheduler,
          queueJob: async (_workspace, id) => {
            queued.push(id);
            return { id: "motionjob-" + "a".repeat(24), status: "queued" };
          },
        });
      expect(response.sourceProjectId).toBe(original.id);
      expect(response.sourceRevision).toBe(1);
      expect(response.variants).toHaveLength(3);
      expect(queued).toHaveLength(3);
      expect(new Set(queued).size).toBe(3);
      const dimensions: Array<[number, number]> = [];
      for (const variant of response.variants) {
        expect(variant.projectId).not.toBe(original.id);
        expect(variant.revision).toBe(2);
        expect(variant.jobStatus).toBe("queued");
        const project = await getMotionProject(workspace, variant.projectId!);
        validateMotionProject(project);
        expect(project.composition.layers[0]).toBeDefined();
        dimensions.push([project.composition.width, project.composition.height]);
      }
      expect(dimensions).toEqual([[1280,720],[1080,1080],[720,1280]]);
      expect((await getMotionProject(workspace, original.id)).revision).toBe(1);
      expect((await listMotionProjects(workspace))).toHaveLength(4);
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });
  it("rejects unsafe batches and reports a failed queued variant without deleting other output projects", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-variants-fail-"));
    try {
      const p = await createMotionProject(workspace, "Safeguards");
      await expect(createMotionBatchVariants(workspace, p.id, 2, ["16:9"], { scheduler }))
        .rejects.toThrow(MotionRevisionConflict);
      await expect(createMotionBatchVariants(workspace, p.id, 1, ["9:16","9:16"], { scheduler }))
        .rejects.toThrow();
      await expect(createMotionBatchVariants(workspace, p.id, 1, ["16:9"], {
        scheduler: async () => ({ queued: 12, queueLimit: 12 }),
      })).rejects.toThrow(/queue capacity/i);
      expect((await listMotionProjects(workspace))).toHaveLength(1);
      let calls = 0;
      const result = await createMotionBatchVariants(workspace, p.id, 1, ["16:9","9:16"], {
        scheduler,
        queueJob: async () => {
          if (++calls === 2) throw new Error("Renderer unavailable");
          return { id: "motionjob-" + "b".repeat(24), status: "queued" };
        },
      });
      expect(result.variants[0].jobStatus).toBe("queued");
      expect(result.variants[1].error).toContain("Renderer unavailable");
      expect(result.variants[1].projectId).toBeTruthy();
      expect((await listMotionProjects(workspace))).toHaveLength(3);
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });
});
