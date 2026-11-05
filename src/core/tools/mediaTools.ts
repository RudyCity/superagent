/** Narrow public Agent tool contract for local image and document workflows. */
import type { Tool } from "./types.js";
import { mediaPlan } from "../media/mediaPlanner.js";
import { mediaInspect, mediaTransform, mediaConvert, mediaBatch, mediaCapabilities, mediaError } from "../media/mediaEngine.js";

const inputPath = { type: "string", description: "Input file relative to an authorized local workspace." };
const outputPath = { type: "string", description: "New output file relative to workspace. Must not already exist; parent must exist." };
const operation = { type: "string", enum: ["resize", "crop", "convert", "compress", "rotate", "flip_vertical", "flop_horizontal", "grayscale", "watermark", "remove_background", "upscale_ai"] };
const common = {
  inputPath, outputPath,
  width: { type: "integer", minimum: 1, maximum: 16000 },
  height: { type: "integer", minimum: 1, maximum: 16000 },
  quality: { type: "integer", minimum: 1, maximum: 100 },
  page: { type: "integer", minimum: 1 },
  allPages: { type: "boolean" },
  dpi: { type: "integer", minimum: 72, maximum: 300 },
  frame: { type: "integer", minimum: 0 },
};
function makeTool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, unknown>, cwd: string, signal?: AbortSignal) => Promise<unknown>): Tool {
  return {
    name, description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    async execute(args, cwd, signal) {
      try { return JSON.stringify(await run(args, cwd, signal)); }
      catch (error) { return JSON.stringify(mediaError(error)); }
    },
  };
}
export const mediaInspectTool = makeTool(
  "media_inspect",
  "Inspect a local raster image, PDF or Office document; verify file header, byte limit, hash and available geometry. Read-only.",
  { inputPath }, ["inputPath"], mediaInspect,
);
export const mediaCapabilitiesTool = makeTool(
  "media_capabilities",
  "Report installed local conversion engines, document backends, AI dependencies and truthful limitations.",
  {}, [], async () => mediaCapabilities(),
);
export const mediaPlanTool = makeTool(
  "media_plan",
  "Read-only conversion route planner: inspect input signatures, determine backend availability, editable/visual fidelity, warnings and supported output format without creating an artifact.",
  { inputPath, inputPaths: { type: "array", items: inputPath, minItems: 1, maxItems: 50 },
    outputPath, mode: { type: "string", enum: ["convert", "transform"] },
    operation },
  ["outputPath"], mediaPlan,
);
export const mediaTransformTool = makeTool(
  "media_transform",
  "Create a new raster image: resize, crop, compress, rotate, flip, grayscale, image watermark, background removal with a local rembg model or Real-ESRGAN AI upscale. No overwrites or automatic cloud uploads.",
  { ...common, operation, left: { type: "integer", minimum: 0 }, top: { type: "integer", minimum: 0 },
    fit: { type: "string", enum: ["inside", "cover"] }, allowEnlarge: { type: "boolean" },
    model: { type: "string", enum: ["u2net", "u2netp", "isnet-general-use"] },
    scale: { type: "integer", enum: [2, 3, 4] },
    degrees: { type: "number", minimum: 0, maximum: 360, description: "Rotation in degrees, default 90." },
    watermarkPath: { type: "string", description: "Raster watermark path inside authorized workspace." },
    watermarkWidth: { type: "integer", minimum: 1, maximum: 16000, description: "Optional overlay width in pixels." },
  }, ["inputPath", "outputPath", "operation"], mediaTransform,
);
export const mediaConvertTool = makeTool(
  "media_convert",
  "Convert images (PNG/JPEG/WebP/etc) to raster/PDF/DOCX/XLSX/PPTX; PDF to image or Office; DOCX/XLSX/PPTX to PDF/image when LibreOffice is provisioned; CSV and XLSX interchange. Editable reconstruction may lose original layout.",
  { ...common, inputPaths: { type: "array", items: inputPath, minItems: 1, maxItems: 50 },
  }, ["outputPath"], mediaConvert,
);
export const mediaBatchTool = makeTool(
  "media_batch",
  "Process 1-20 bounded media_transform/media_convert jobs with per-item successes/failures, cancellation, and optional stopOnError. Requires write permission.",
  { jobs: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 20 },
    stopOnError: { type: "boolean", description: "Stop after the first failed item instead of continuing; defaults false." } }, ["jobs"], mediaBatch,
);
export const MEDIA_TOOLS = [mediaInspectTool, mediaCapabilitiesTool, mediaPlanTool, mediaTransformTool, mediaConvertTool, mediaBatchTool];
