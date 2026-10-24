import type { MotionProject } from "../schema/types.js";
import { evaluateFrame } from "../timeline/evaluateFrame.js";
import { splitTextLines } from "../layout/textLayout.js";

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
    const scaleX = values.scaleX ?? values.scale ?? 1;
    const scaleY = values.scaleY ?? values.scale ?? 1;
    let transform = `rotate(${number(values.rotation)} ${cx} ${cy})`;
    if (scaleX !== 1 || scaleY !== 1) {
      transform += ` translate(${cx} ${cy}) scale(${number(scaleX)} ${number(scaleY)}) translate(-${cx} -${cy})`;
    }
    if (layer.kind === "rect") {
      parts.push(`<rect x="${x}" y="${y}" width="${number(layer.width)}" height="${number(layer.height)}" rx="${number(layer.cornerRadius ?? 0)}" fill="${layer.fill}" opacity="${opacity}" transform="${transform}"/>`);
    } else if (layer.kind === "image") {
      const href = images.get(layer.assetId);
      if (!href || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(href)) throw new Error("Motion image preview requires a validated PNG asset");
      parts.push(`<image x="${x}" y="${y}" width="${number(layer.width)}" height="${number(layer.height)}" href="${href}" opacity="${opacity}" preserveAspectRatio="none" transform="${transform}"/>`);
    } else if (layer.kind === "video") {
      const href = images.get(layer.assetId) ?? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      parts.push(`<image x="${x}" y="${y}" width="${number(layer.width)}" height="${number(layer.height)}" href="${href}" opacity="${opacity}" preserveAspectRatio="none" transform="${transform}"/>`);
    } else if (layer.kind === "path") {
      const fill = layer.fill ?? "none";
      const stroke = layer.stroke ?? "none";
      const strokeWidth = layer.strokeWidth ? ` stroke-width="${number(layer.strokeWidth)}"` : "";
      const dash = layer.strokeDasharray && layer.strokeDasharray.length > 0 ? ` stroke-dasharray="${layer.strokeDasharray.join(" ")}"` : "";
      const offset = layer.strokeDashoffset !== undefined ? ` stroke-dashoffset="${number(layer.strokeDashoffset)}"` : "";
      const fillRule = layer.fillRule ? ` fill-rule="${layer.fillRule}"` : "";
      parts.push(`<g transform="${transform} translate(${x} ${y})"><path d="${escapeXml(layer.d)}" fill="${fill}" stroke="${stroke}"${strokeWidth}${dash}${offset}${fillRule} opacity="${opacity}"/></g>`);
    } else {
      const baseline = number(values.y + layer.fontSize);
      const lines = splitTextLines(layer.text, layer.width > 0 ? layer.width : undefined, s => s.length * layer.fontSize * 0.48);
      if (lines.length <= 1) {
        parts.push(`<text x="${x}" y="${baseline}" fill="${layer.fill}" opacity="${opacity}" font-family="${escapeXml(layer.fontFamily)}" font-size="${number(layer.fontSize)}" transform="${transform}">${escapeXml(layer.text)}</text>`);
      } else {
        const lineHeight = Math.round(layer.fontSize * 1.25);
        const tspans = lines.map((line, idx) => {
          const dy = idx === 0 ? "0" : number(lineHeight);
          return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
        }).join("");
        parts.push(`<text x="${x}" y="${baseline}" fill="${layer.fill}" opacity="${opacity}" font-family="${escapeXml(layer.fontFamily)}" font-size="${number(layer.fontSize)}" transform="${transform}">${tspans}</text>`);
      }
    }
  }
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}
