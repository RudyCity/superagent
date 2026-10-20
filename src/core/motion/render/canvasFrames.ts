import { createCanvas, type Image } from "@napi-rs/canvas";
import type { MotionProject } from "../schema/types.js";
import { evaluateFrame } from "../timeline/evaluateFrame.js";

/**
 * Restricted built-in declarative canvas renderer. Does not load URLs, plugins,
 * custom scripts, host files or user-selected fonts.
 */
export function createMotionFrameRenderer(project: MotionProject, width: number, height: number, images = new Map<string, Image>()) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const sx = width / project.composition.width;
  const sy = height / project.composition.height;
  return (frameIndex: number): Buffer => {
    const frame = evaluateFrame(project, frameIndex);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, width, height);
    ctx.scale(sx, sy);
    for (const { layer, values } of frame.layers) {
      ctx.save();
      const centerX = values.x + layer.width / 2;
      const centerY = values.y + layer.height / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate(values.rotation * Math.PI / 180);
      ctx.translate(-centerX, -centerY);
      ctx.globalAlpha = values.opacity;
      ctx.fillStyle = layer.fill;
      if (layer.kind === "rect") {
        ctx.fillRect(values.x, values.y, layer.width, layer.height);
      } else if (layer.kind === "image") {
        const image = images.get(layer.assetId);
        if (!image) throw new Error("Motion image asset missing from pinned renderer");
        ctx.drawImage(image, values.x, values.y, layer.width, layer.height);
      } else {
        ctx.textBaseline = "alphabetic";
        ctx.font = `${layer.fontSize}px "${layer.fontFamily}"`;
        ctx.fillText(layer.text, values.x, values.y + layer.fontSize);
      }
      ctx.restore();
    }
    const data = ctx.getImageData(0, 0, width, height).data;
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  };
}
