/** Read-only route selection and backend readiness for image/document conversions.
 * This does not start any conversion or create any file.
 */
import path from "node:path";
import { mediaCapabilities, mediaInspect, mediaError, type MediaRequest } from "./mediaEngine.js";

const RASTERS = new Set(["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff", "bmp", "gif"]);
const OUTPUT_RASTERS = new Set(["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff", "gif"]);
const OFFICE = new Set(["docx", "xlsx", "pptx"]);
const COMPOSITES = new Set(["resize", "crop", "convert", "compress", "rotate", "flip_vertical", "flop_horizontal", "grayscale", "watermark", "remove_background", "upscale_ai"]);
type Route = {
  backend: string;
  requirements: string[];
  fidelity: "lossless_visual" | "lossy_visual" | "editable_text" | "structured_table" | "embedded_image" | "raster_slide";
  warnings: string[];
};
const planError = (code: string, message: string) => ({ status: "failed" as const, supported: false, code, message });

export async function mediaPlan(args: MediaRequest, workspace: string) {
  try {
    const paths = Array.isArray(args.inputPaths) ? args.inputPaths : [args.inputPath];
    if (paths.length < 1 || paths.length > 50 || paths.some(item => typeof item !== "string" || !item.trim())) {
      return planError("invalid_argument", "Provide 1-50 input files.");
    }
    const inspected = [];
    for (const inputPath of paths) inspected.push(await mediaInspect({ inputPath }, workspace));
    const types = inspected.map(item => item.format as string);
    const input = types[0];
    const target = typeof args.outputPath === "string" ? path.extname(args.outputPath).slice(1).toLowerCase() : "";
    if (!target) return planError("invalid_argument", "outputPath must include a supported file extension.");
    if (args.mode !== undefined && args.mode !== "convert" && args.mode !== "transform") {
      return planError("invalid_argument", "mode must be transform or convert.");
    }
    const mode = args.mode === "transform" ? "transform" : "convert";
    let route: Route | null = null;
    if (mode === "transform") {
      const action = typeof args.operation === "string" ? args.operation : "";
      if (!COMPOSITES.has(action)) return planError("invalid_operation", "Unknown raster transform operation.");
      if (!RASTERS.has(input) || paths.length !== 1) return planError("unsupported_conversion", "Image transforms accept one raster file.");
      if (!OUTPUT_RASTERS.has(target)) return planError("unsupported_conversion", "Transform outputs must be raster images.");
      if (action === "remove_background") {
        if (target !== "png") return planError("unsupported_conversion", "Background removal requires PNG output.");
        const model = typeof args.model === "string" ? args.model : "u2netp";
        if (!["u2netp", "u2net", "isnet-general-use"].includes(model)) {
          return planError("invalid_argument", "Unsupported background model.");
        }
        route = { backend: "rembg", requirements: ["rembg", model === "u2netp" ? "rembg_model_u2netp" : "model:" + model],
          fidelity: "lossy_visual", warnings: ["Alpha mask must be visually reviewed around edges."] };
      } else if (action === "upscale_ai") {
        if (target !== "png") return planError("unsupported_conversion", "AI upscale requires PNG output.");
        route = { backend: "Real-ESRGAN NCNN Vulkan", requirements: ["realesrgan_ncnn"], fidelity: "lossy_visual", warnings: ["Upscaling synthesizes plausible detail and is not evidence of original fine detail."] };
      } else {
        if (action === "watermark") {
          if (typeof args.watermarkPath !== "string" || !args.watermarkPath.trim()) {
            return planError("invalid_argument", "watermarkPath must identify a workspace raster image.");
          }
          const mark = await mediaInspect({ inputPath: args.watermarkPath }, workspace);
          if (!RASTERS.has(mark.format as string)) return planError("unsupported_format", "Watermark must be a raster image.");
        }
        route = { backend: "sharp", requirements: ["sharp"], fidelity: ["jpg", "jpeg", "webp", "avif"].includes(target) ? "lossy_visual" : "lossless_visual",
          warnings: action === "watermark" ? ["The watermark remains part of the resulting raster image, not an editable layer."] : [] };
      }
    } else {
      if (types.every(type => RASTERS.has(type))) {
        if (target === "pdf") route = { backend: "pdf-lib + sharp", requirements: ["sharp"], fidelity: "lossless_visual", warnings: ["PDF pages contain raster images."] };
        else if (OFFICE.has(target)) route = { backend: "Python Office writer", requirements: target === "docx" ? ["python_docx", "pillow"] : target === "xlsx" ? ["openpyxl", "pillow"] : ["python_pptx", "pillow"], fidelity: "embedded_image", warnings: ["Office output embeds pictures; OCR is required for editable text or table cells."] };
        else if (paths.length === 1 && OUTPUT_RASTERS.has(target)) route = { backend: "sharp", requirements: ["sharp"], fidelity: ["jpg", "jpeg", "webp", "avif"].includes(target) ? "lossy_visual" : "lossless_visual", warnings: [] };
      } else if (types.length === 1 && input === "pdf") {
        if (["png", "jpg", "jpeg", "webp"].includes(target)) route = { backend: "PyMuPDF + Pillow", requirements: ["pymupdf", "pillow"], fidelity: "lossy_visual", warnings: ["PDF pages are rendered as images."] };
        else if (target === "docx") route = { backend: "PyMuPDF + python-docx", requirements: ["pymupdf", "python_docx"], fidelity: "editable_text", warnings: ["Text-only reconstruction cannot preserve exact layout and does not OCR scanned pages."] };
        else if (target === "xlsx") route = { backend: "PyMuPDF + openpyxl", requirements: ["pymupdf", "openpyxl"], fidelity: "structured_table", warnings: ["Only tables detected on each page are extracted; review cell alignment."] };
        else if (target === "pptx") route = { backend: "PyMuPDF + python-pptx", requirements: ["pymupdf", "python_pptx"], fidelity: "raster_slide", warnings: ["Slides visually preserve PDF pages as pictures, not editable shapes."] };
      } else if (types.length === 1 && OFFICE.has(input)) {
        const requirements = ["pymupdf", "pillow"];
        if (input === "xlsx" && (target === "csv" || target === "tsv")) {
          route = { backend: "@e965/xlsx", requirements: [], fidelity: "structured_table",
            warnings: ["Only the first worksheet is exported as delimited text."] };
        } else if (target === "pdf" || ["png", "jpg", "jpeg", "webp"].includes(target)) {
          route = { backend: "LibreOffice or Windows Office", requirements: target === "pdf" ? [] : requirements,
            fidelity: ["png", "jpg", "jpeg", "webp"].includes(target) ? "lossy_visual" : "lossless_visual",
            warnings: ["Rendering depends on installed fonts and Office backend."] };
        }
      } else if (types.length === 1 && (input === "csv" || input === "tsv") && target === "xlsx"
          || types.length === 1 && input === "xlsx" && (target === "csv" || target === "tsv")) {
        route = { backend: "@e965/xlsx", requirements: [], fidelity: "structured_table",
          warnings: input === "xlsx" ? ["Only the first worksheet is exported as delimited text."] : [] };
      }
    }
    if (!route) return planError("unsupported_conversion", "No implemented conversion route exists for " + types.join("+") + " -> " + target);
    const installed = await mediaCapabilities();
    const missing = route.requirements.filter(name => !installed.available[name]);
    if (route.backend === "LibreOffice or Windows Office" && !installed.available.libreoffice && !installed.available.office_win32) {
      missing.push("libreoffice_or_windows_office");
    }
    return {
      status: "ok" as const, supported: true, ready: missing.length === 0, mode, inputFormats: types,
      targetFormat: target, backend: route.backend, requiredBackends: route.requirements, missingBackends: missing,
      fidelity: route.fidelity, warnings: route.warnings,
      inputHashes: inspected.map(item => item.sha256 as string),
      noFileCreated: true,
    };
  } catch (error) {
    return { ...mediaError(error), supported: false };
  }
}
