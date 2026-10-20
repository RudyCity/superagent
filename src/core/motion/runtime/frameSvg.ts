import type { MotionProject } from "../schema/types.js";
import { evaluateFrame } from "../timeline/evaluateFrame.js";

function escapeXml(raw: string): string {
  return raw.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char);
}
function number(raw: number): string {
  // Stable output for deterministic frame hashing and tests.
  return Number(raw.toFixed(6)).toString();
}
/** Safe, declarative SVG preview: never evaluates user-provided code or fetches remote assets. */
export function renderMotionSvg(project: MotionProject, frame: number, images = new Map<string, string>()): string {
  const scene = evaluateFrame(project, frame);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`,
    `<rect width="${scene.width}" height="${scene.height}" fill="${scene.background}"/>`,
  ];
  for (const { layer, values } of scene.layers) {
    const x = number(values.x);
    const y = number(values.y);
    const opacity = number(values.opacity);
    const cx = number(values.x + layer.width / 2);
    const cy = number(values.y + layer.height / 2);
    const transform = `rotate(${number(values.rotation)} ${cx} ${cy})`;
    if (layer.kind === "rect") {
      parts.push(`<rect x="${x}" y="${y}" width="${number(layer.width)}" height="${number(layer.height)}" fill="${layer.fill}" opacity="${opacity}" transform="${transform}"/>`);
    } else if (layer.kind === "image") {
      const href = images.get(layer.assetId);
      if (!href || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(href)) throw new Error("Motion image preview requires a validated PNG asset");
      parts.push(`<image x="${x}" y="${y}" width="${number(layer.width)}" height="${number(layer.height)}" href="${href}" opacity="${opacity}" preserveAspectRatio="none" transform="${transform}"/>`);
    } else {
      const baseline = number(values.y + layer.fontSize);
      parts.push(`<text x="${x}" y="${baseline}" fill="${layer.fill}" opacity="${opacity}" font-family="${escapeXml(layer.fontFamily)}" font-size="${number(layer.fontSize)}" transform="${transform}">${escapeXml(layer.text)}</text>`);
    }
  }
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}
