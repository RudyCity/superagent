import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PathLayer, MotionProject, MotionTrack } from "../schema/types.js";
import { validateMotionProject } from "../schema/validation.js";

export type ImageTraceMode = "silhouette" | "color" | "outline";

export interface ImageTraceOptions {
  /** Tracing mode: "silhouette" (monochrome shape), "color" (multi-tone), or "outline" (stroke only) */
  mode?: ImageTraceMode;
  /** Binarization luminance threshold 0-255 (default: 128) */
  threshold?: number;
  /** Invert foreground / background detection (default: false) */
  invert?: boolean;
  /** Douglas-Peucker point simplification tolerance in pixels (default: 1.2) */
  simplify?: number;
  /** Minimum contour area in pixels to discard speckles (default: 16) */
  minArea?: number;
  /** Smooth contours using quadratic Bezier curves (default: true) */
  smooth?: boolean;
  /** Override fill color (hex format "#RRGGBB" or "none") */
  fill?: string;
  /** Override stroke color (hex format "#RRGGBB" or "none") */
  stroke?: string;
  /** Stroke line width in pixels (default: 0, or 2 in outline mode) */
  strokeWidth?: number;
  /** Dash array pattern for kinetic draw animations (e.g. [500, 500]) */
  strokeDasharray?: number[];
  /** Dash offset for line draw animations */
  strokeDashoffset?: number;
  /** Number of tonal bands for multi-color mode (2 to 4, default: 3) */
  colorBands?: number;
  /** Optional target width to scale traced coordinates */
  fitWidth?: number;
  /** Optional target height to scale traced coordinates */
  fitHeight?: number;
}

export interface TracedPath {
  d: string;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: number[];
  strokeDashoffset?: number;
  bounds: { x: number; y: number; width: number; height: number };
  pointsCount: number;
}

export interface TraceResult {
  width: number;
  height: number;
  paths: TracedPath[];
  svg: string;
  totalPoints: number;
}

interface Point {
  x: number;
  y: number;
}

/** Distance from point p to line segment ab */
function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/** Ramer-Douglas-Peucker polygon simplification */
function simplifyPolygon(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointToSegmentDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = simplifyPolygon(points.slice(0, index + 1), epsilon);
    const right = simplifyPolygon(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/** Shoelace polygon area */
function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

/** Moore-Neighbor 8-connected boundary contour tracer */
function traceContours(grid: Uint8Array, width: number, height: number): Point[][] {
  const visited = new Uint8Array(width * height);
  const contours: Point[][] = [];

  // Clockwise 8-directional offsets
  const dx = [0, 1, 1, 1, 0, -1, -1, -1];
  const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

  const get = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return grid[y * width + x];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[y * width + x] === 1 && visited[y * width + x] === 0) {
        // Must be on the boundary: at least one of the 8 neighbors is 0
        let isBoundary = false;
        for (let i = 0; i < 8; i++) {
          if (get(x + dx[i], y + dy[i]) === 0) {
            isBoundary = true;
            break;
          }
        }
        if (!isBoundary) continue;

        const contour: Point[] = [{ x, y }];
        visited[y * width + x] = 1;
        let cx = x;
        let cy = y;
        let backtrackDir = 0;
        let steps = width * height * 2;

        while (steps-- > 0) {
          let found = false;
          for (let s = 0; s < 8; s++) {
            const dir = (backtrackDir + s) % 8;
            const nx = cx + dx[dir];
            const ny = cy + dy[dir];
            if (get(nx, ny) === 1) {
              contour.push({ x: nx, y: ny });
              visited[ny * width + nx] = 1;
              backtrackDir = (dir + 4 + 1) % 8;
              cx = nx;
              cy = ny;
              found = true;
              break;
            }
          }
          if (!found || (cx === x && cy === y)) break;
        }

        if (contour.length >= 4) contours.push(contour);
      }
    }
  }

  return contours;
}

/** Convert a polygon of points into SVG path commands */
function polygonToPathString(points: Point[], smooth: boolean, scaleX = 1, scaleY = 1): string {
  if (points.length < 3) return "";
  const scaled = points.map(p => ({
    x: Number((p.x * scaleX).toFixed(2)),
    y: Number((p.y * scaleY).toFixed(2)),
  }));

  if (!smooth || scaled.length < 5) {
    let d = `M ${scaled[0].x} ${scaled[0].y}`;
    for (let i = 1; i < scaled.length; i++) {
      d += ` L ${scaled[i].x} ${scaled[i].y}`;
    }
    return d + " Z";
  }

  // Smooth midpoint quadratic Bezier curves
  let d = `M ${scaled[0].x} ${scaled[0].y}`;
  for (let i = 0; i < scaled.length - 1; i++) {
    const curr = scaled[i];
    const next = scaled[i + 1];
    const mx = Number(((curr.x + next.x) / 2).toFixed(2));
    const my = Number(((curr.y + next.y) / 2).toFixed(2));
    d += ` Q ${curr.x} ${curr.y} ${mx} ${my}`;
  }
  const last = scaled[scaled.length - 1];
  d += ` L ${last.x} ${last.y} Z`;
  return d;
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Traces raw RGBA pixel data into vector SVG path contours.
 */
export function traceImageData(
  imageData: { data: Uint8Array | Uint8ClampedArray; width: number; height: number },
  options: ImageTraceOptions = {},
): TraceResult {
  const { width, height, data } = imageData;
  if (!width || !height || !data || data.length < width * height * 4) {
    throw new Error("Invalid image data for vector tracing");
  }

  const mode = options.mode ?? "silhouette";
  const threshold = options.threshold ?? 128;
  const invert = options.invert ?? false;
  const simplifyTol = options.simplify ?? 1.2;
  const minArea = options.minArea ?? 16;
  const smooth = options.smooth ?? true;
  const colorBands = Math.max(2, Math.min(4, options.colorBands ?? 3));

  const scaleX = options.fitWidth ? options.fitWidth / width : 1;
  const scaleY = options.fitHeight ? options.fitHeight / height : 1;
  const outWidth = Math.round(width * scaleX);
  const outHeight = Math.round(height * scaleY);

  const paths: TracedPath[] = [];
  let totalPoints = 0;

  if (mode === "color") {
    // Multi-tonal posterized tracing
    const bandSize = Math.floor(256 / colorBands);
    for (let b = 0; b < colorBands; b++) {
      const minLum = b * bandSize;
      const maxLum = (b + 1) * bandSize;
      const grid = new Uint8Array(width * height);
      let sumR = 0, sumG = 0, sumB = 0, count = 0;

      for (let i = 0; i < width * height; i++) {
        const off = i * 4;
        const alpha = data[off + 3];
        if (alpha < 64) continue;
        const r = data[off], g = data[off + 1], bl = data[off + 2];
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * bl);
        if (lum >= minLum && lum < maxLum) {
          grid[i] = 1;
          sumR += r; sumG += g; sumB += bl;
          count++;
        }
      }

      if (count < minArea) continue;
      const avgColor = rgbToHex(sumR / count, sumG / count, sumB / count);
      const rawContours = traceContours(grid, width, height);
      const pathParts: string[] = [];
      let bandPoints = 0;
      let minX = width, minY = height, maxX = 0, maxY = 0;

      for (const raw of rawContours) {
        if (polygonArea(raw) < minArea) continue;
        const simplified = simplifyPolygon(raw, simplifyTol);
        if (simplified.length < 3) continue;
        for (const pt of simplified) {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
        }
        bandPoints += simplified.length;
        pathParts.push(polygonToPathString(simplified, smooth, scaleX, scaleY));
      }

      if (pathParts.length > 0) {
        totalPoints += bandPoints;
        paths.push({
          d: pathParts.join(" "),
          fill: options.fill ?? avgColor,
          stroke: options.stroke ?? "none",
          strokeWidth: options.strokeWidth ?? 0,
          bounds: {
            x: Math.round(minX * scaleX),
            y: Math.round(minY * scaleY),
            width: Math.max(1, Math.round((maxX - minX) * scaleX)),
            height: Math.max(1, Math.round((maxY - minY) * scaleY)),
          },
          pointsCount: bandPoints,
        });
      }
    }
  } else {
    // Silhouette / Outline mode
    const grid = new Uint8Array(width * height);
    let sumR = 0, sumG = 0, sumB = 0, fgCount = 0;

    for (let i = 0; i < width * height; i++) {
      const off = i * 4;
      const alpha = data[off + 3];
      if (alpha < 64) continue;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const isForeground = invert ? lum >= threshold : lum < threshold;
      if (isForeground) {
        grid[i] = 1;
        sumR += r; sumG += g; sumB += b;
        fgCount++;
      }
    }

    const detectedColor = fgCount > 0 ? rgbToHex(sumR / fgCount, sumG / fgCount, sumB / fgCount) : "#38BDF8";
    const rawContours = traceContours(grid, width, height);
    const pathParts: string[] = [];
    let minX = width, minY = height, maxX = 0, maxY = 0;

    for (const raw of rawContours) {
      if (polygonArea(raw) < minArea) continue;
      const simplified = simplifyPolygon(raw, simplifyTol);
      if (simplified.length < 3) continue;
      for (const pt of simplified) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      totalPoints += simplified.length;
      pathParts.push(polygonToPathString(simplified, smooth, scaleX, scaleY));
    }

    if (pathParts.length > 0) {
      const isOutline = mode === "outline";
      paths.push({
        d: pathParts.join(" "),
        fill: options.fill ?? (isOutline ? "none" : (detectedColor === "#000000" ? "#38BDF8" : detectedColor)),
        stroke: options.stroke ?? (isOutline ? (detectedColor === "#000000" ? "#38BDF8" : detectedColor) : "none"),
        strokeWidth: options.strokeWidth ?? (isOutline ? 2 : 0),
        strokeDasharray: options.strokeDasharray,
        strokeDashoffset: options.strokeDashoffset,
        bounds: {
          x: Math.round(minX * scaleX),
          y: Math.round(minY * scaleY),
          width: Math.max(1, Math.round((maxX - minX) * scaleX)),
          height: Math.max(1, Math.round((maxY - minY) * scaleY)),
        },
        pointsCount: totalPoints,
      });
    }
  }

  // Construct valid standalone SVG output
  const svgElements = paths.map(p => {
    const strokeAttr = p.stroke && p.stroke !== "none" ? ` stroke="${p.stroke}" stroke-width="${p.strokeWidth ?? 1}"` : "";
    const dashAttr = p.strokeDasharray ? ` stroke-dasharray="${p.strokeDasharray.join(" ")}"` : "";
    const offsetAttr = p.strokeDashoffset !== undefined ? ` stroke-dashoffset="${p.strokeDashoffset}"` : "";
    return `  <path d="${p.d}" fill="${p.fill}"${strokeAttr}${dashAttr}${offsetAttr} fill-rule="evenodd"/>`;
  }).join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${outWidth} ${outHeight}">\n${svgElements}\n</svg>\n`;

  return {
    width: outWidth,
    height: outHeight,
    paths,
    svg,
    totalPoints,
  };
}

/**
 * Traces a PNG/JPEG image buffer into scalable SVG vector paths.
 */
export async function traceImageBuffer(
  imageBuffer: Buffer,
  options: ImageTraceOptions = {},
): Promise<TraceResult> {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 8) {
    throw new Error("Invalid image buffer for vector tracing");
  }

  const img = await loadImage(imageBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return traceImageData(imageData, options);
}

/**
 * Converts a raster image buffer into declarative SuperAgent Studio PathLayer objects.
 */
export async function traceImageToPathLayers(
  imageBuffer: Buffer,
  options: ImageTraceOptions & {
    idPrefix?: string;
    x?: number;
    y?: number;
    tracks?: MotionTrack[];
    kineticReveal?: boolean;
    durationFrames?: number;
  } = {},
): Promise<PathLayer[]> {
  const trace = await traceImageBuffer(imageBuffer, options);
  const prefix = options.idPrefix ?? "vector-trace";
  const startX = options.x ?? 0;
  const startY = options.y ?? 0;
  const layers: PathLayer[] = [];

  trace.paths.forEach((p, idx) => {
    let tracks = options.tracks ? [...options.tracks] : [];
    let strokeDasharray = p.strokeDasharray;
    let strokeDashoffset = p.strokeDashoffset;

    if (options.kineticReveal) {
      // Estimate path perimeter length for drawing reveal animation
      const perimeter = Math.max(100, Math.round(p.bounds.width * 2 + p.bounds.height * 2));
      strokeDasharray = [perimeter, perimeter];
      strokeDashoffset = perimeter;
      const duration = options.durationFrames ?? 60;
      tracks.push({
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 6, value: 1, easing: "easeOut" },
        ],
      });
    }

    layers.push({
      kind: "path",
      id: `${prefix}-${idx}`,
      x: startX + p.bounds.x,
      y: startY + p.bounds.y,
      width: p.bounds.width,
      height: p.bounds.height,
      rotation: 0,
      opacity: 1,
      fill: p.fill,
      stroke: p.stroke,
      strokeWidth: p.strokeWidth,
      strokeDasharray,
      strokeDashoffset,
      fillRule: "evenodd",
      d: p.d,
      tracks,
    });
  });

  return layers;
}

/**
 * Replaces an existing raster ImageLayer in a Motion project with vectorized PathLayers.
 */
export async function vectorizeProjectLayer(
  project: MotionProject,
  targetLayerId: string,
  imageBuffer: Buffer,
  options: ImageTraceOptions = {},
): Promise<{ project: MotionProject; newLayers: PathLayer[] }> {
  validateMotionProject(project);
  const targetIndex = project.composition.layers.findIndex(l => l.id === targetLayerId);
  if (targetIndex < 0) {
    throw new Error(`Layer "${targetLayerId}" not found in project "${project.id}"`);
  }
  const originalLayer = project.composition.layers[targetIndex];
  const newLayers = await traceImageToPathLayers(imageBuffer, {
    ...options,
    idPrefix: `${targetLayerId}-vec`,
    x: originalLayer.x,
    y: originalLayer.y,
    fitWidth: originalLayer.width,
    fitHeight: originalLayer.height,
    tracks: originalLayer.tracks,
  });

  const updatedLayers = [
    ...project.composition.layers.slice(0, targetIndex),
    ...newLayers,
    ...project.composition.layers.slice(targetIndex + 1),
  ];

  const updatedProject: MotionProject = {
    ...project,
    revision: project.revision + 1,
    updatedAt: new Date().toISOString(),
    composition: {
      ...project.composition,
      layers: updatedLayers,
    },
  };

  validateMotionProject(updatedProject);
  return { project: updatedProject, newLayers };
}
