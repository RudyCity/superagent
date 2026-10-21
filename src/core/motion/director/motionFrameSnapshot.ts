import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { readMotionAsset } from "../assets/motionAssets.js";
import { createMotionFrameRenderer } from "../render/canvasFrames.js";
import { validateMotionProject } from "../schema/validation.js";
import type { MotionProject } from "../schema/types.js";

/** Render an authenticated, bounded PNG snapshot through the same Canvas evaluator used for MP4. */
export async function renderMotionFrameSnapshot(
  workspace: string, project: MotionProject, frame: number,
): Promise<Buffer> {
  validateMotionProject(project);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= project.composition.durationFrames) {
    throw new RangeError("Motion frame index outside composition");
  }
  const aspect = project.composition.width / project.composition.height;
  const width = Math.max(2, Math.min(480, Math.floor(700 * aspect)));
  const height = Math.max(2, Math.round(width / aspect));
  if (width * height > 480 * 700) throw new RangeError("Snapshot pixel budget exceeded");
  const images = new Map<string, Image>();
  for (const id of new Set(project.composition.layers.flatMap(layer =>
    layer.kind === "image" ? [layer.assetId] : []))) {
    images.set(id, await loadImage(await readMotionAsset(workspace, id)));
  }
  const rgba = createMotionFrameRenderer(project, width, height, images)(frame);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const pixels = ctx.createImageData(width, height);
  pixels.data.set(rgba);
  ctx.putImageData(pixels, 0, 0);
  const png = canvas.toBuffer("image/png");
  if (png.length > 2 * 1024 * 1024) throw new RangeError("Snapshot PNG budget exceeded");
  return png;
}
