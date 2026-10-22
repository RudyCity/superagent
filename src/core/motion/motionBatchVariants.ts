import type { MotionJob } from "./jobs/motionJobs.js";
import { startDetachedMotionJob, getMotionSchedulerStatus } from "./jobs/motionJobs.js";
import { MotionRevisionConflict } from "./project/revisions.js";
import { createMotionProject, getMotionProject, updateMotionProject } from "./project/projectStore.js";
import { resizeMotionComposition, type MotionOutputAspect } from "./motionResize.js";
import { MotionValidationError } from "./schema/validation.js";

export interface MotionVariantResult {
  aspectRatio: MotionOutputAspect;
  projectId?: string;
  revision?: number;
  jobId?: string;
  jobStatus?: MotionJob["status"];
  error?: string;
}
export interface MotionBatchResult {
  sourceProjectId: string;
  sourceRevision: number;
  variants: MotionVariantResult[];
}
interface BatchOptions {
  width?: number;
  queueJob?: (workspace: string, projectId: string, options: { width?: number }) =>
    Promise<Pick<MotionJob, "id" | "status">>;
  scheduler?: (workspace: string) => Promise<{ queued: number; queueLimit: number }>;
}

/**
 * Materialize explicit new projects rather than modifying the source. Each
 * child project gets an immutable queued MP4 snapshot via the existing job
 * scheduler. A failure is reported on its own entry with the created project ID
 * retained for manual retry; other variants remain usable.
 */
export async function createMotionBatchVariants(
  workspace: string, sourceProjectId: string, baseRevision: number,
  aspectRatios: MotionOutputAspect[], options: BatchOptions = {},
): Promise<MotionBatchResult> {
  const allowed = new Set<MotionOutputAspect>(["16:9", "1:1", "9:16"]);
  if (!Array.isArray(aspectRatios) || aspectRatios.length < 1 || aspectRatios.length > 3 ||
      aspectRatios.some(value => !allowed.has(value)) ||
      new Set(aspectRatios).size !== aspectRatios.length) {
    throw new MotionValidationError(["Select 1-3 unique supported Motion variant ratios"]);
  }
  const width = options.width ?? 640;
  if (!Number.isSafeInteger(width) || width < 160 || width > 1080 || width % 2 !== 0) {
    throw new MotionValidationError(["Variant render width must be an even integer from 160 to 1080"]);
  }
  const source = await getMotionProject(workspace, sourceProjectId);
  if (source.revision !== baseRevision) throw new MotionRevisionConflict(baseRevision, source.revision);
  if (source.composition.durationFrames > 1800)
    throw new MotionValidationError(["Batch variants support at most 1800 frames"]);
  // Preflight queue availability. Admission also checks capacity atomically
  // for every job; concurrent editors may still consume slots meanwhile.
  const scheduler = await (options.scheduler ?? getMotionSchedulerStatus)(workspace);
  if (scheduler.queueLimit - scheduler.queued < aspectRatios.length) {
    throw new Error("Motion batch variants require enough free render queue capacity");
  }
  const queue = options.queueJob ?? startDetachedMotionJob;
  const results: MotionVariantResult[] = [];
  for (const ratio of aspectRatios) {
    let childId: string | undefined;
    let revision: number | undefined;
    try {
      const composition = resizeMotionComposition(source, ratio);
      const child = await createMotionProject(workspace,
        source.name.slice(0, 145) + " [" + ratio.replace(":", "x") + "]");
      childId = child.id;
      const saved = await updateMotionProject(workspace, child.id, child.revision, [
        { type: "replace-composition", composition },
      ]);
      revision = saved.revision;
      const job = await queue(workspace, child.id, { width });
      results.push({
        aspectRatio: ratio, projectId: child.id, revision: saved.revision,
        jobId: job.id, jobStatus: job.status,
        ...(job.status === "failed" ? { error: "Render worker failed to start; retry this variant from its project" } : {}),
      });
    } catch (cause) {
      results.push({
        aspectRatio: ratio,
        ...(childId ? { projectId: childId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { sourceProjectId, sourceRevision: source.revision, variants: results };
}
