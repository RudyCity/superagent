import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MotionEdit, MotionProject } from "./schema/types.js";
import { createMotionProject, getMotionProject, listMotionProjects, motionStorageDir, updateMotionProject } from "./project/projectStore.js";
import { renderMotionSvg } from "./runtime/frameSvg.js";
import { resolveMotionAssets } from "./assets/motionAssets.js";
import type { EffectApplication } from "./effects/types.js";

export { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject };
export type { MotionProject, MotionEdit, EffectApplication };

/**
 * Apply a declarative effect from the Motion Studio Effects Engine to a project
 * using optimistic locking and compare-and-swap revisions.
 */
export async function applyEffectToProject(
  workspace: string,
  projectId: string,
  baseRevision: number,
  application: EffectApplication,
): Promise<MotionProject> {
  const current = await getMotionProject(workspace, projectId);
  const { effectRegistry } = await import("./effects/registry.js");
  const updated = effectRegistry.applyToProject(current, application);
  return updateMotionProject(workspace, projectId, baseRevision, [
    { type: "replace-composition", composition: updated.composition },
  ]);
}

/**
 * Phase 1 preview export: writes a deterministic safe SVG under the selected
 * workspace. This is NOT MP4/video rendering or a full studio backend.
 */
export async function writeMotionPreview(
  workspace: string, projectId: string, frame: number,
): Promise<{ projectId: string; revision: number; frame: number; path: string; sha256: string }> {
  const project = await getMotionProject(workspace, projectId);
  const assets = await resolveMotionAssets(workspace, project);
  const imageData = new Map([...assets].map(([id, bytes]) => [id, "data:image/png;base64," + bytes.toString("base64")]));
  const data = renderMotionSvg(project, frame, imageData);
  const storage = await motionStorageDir(workspace);
  const previewDir = path.join(path.dirname(storage), "previews");
  await fs.mkdir(previewDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(previewDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid preview directory");
  const previewPath = path.join(previewDir, project.id + "-r" + project.revision + "-f" + frame + ".svg");
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  try {
    await fs.writeFile(previewPath, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.lstat(previewPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Invalid cached preview");
    const bytes = await fs.readFile(previewPath);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error("Existing preview hash mismatches the pinned revision");
    }
  }
  return { projectId: project.id, revision: project.revision, frame, path: previewPath, sha256 };
}
