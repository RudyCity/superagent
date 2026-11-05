/** Local-first, bounded media conversion coordinator. All outputs are create-only. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execa } from "execa";
import { inspectMediaFormat } from "./mediaFormatGuard.js";

const IMAGE_INPUTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".tif", ".tiff", ".bmp", ".gif"]);
const IMAGE_OUTPUTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".tif", ".tiff", ".gif"]);
const OFFICE = new Set([".docx", ".xlsx", ".pptx"]);
const MAX_INPUT = 100 * 1024 * 1024;
const MAX_OUTPUT = 200 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

export type MediaRequest = Record<string, unknown>;
export type MediaResult = { status: "ok" | "failed"; code?: string; message?: string; backend?: string;
  input?: string; outputs?: { path: string; sizeBytes: number; sha256: string }[]; warnings?: string[]; [key: string]: unknown };

function problem(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function getString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) problem("invalid_argument", name + " is required");
  return value;
}
function numberOption(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) problem("invalid_argument", name + " is outside its supported range");
  return result;
}
function relativeInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
async function scopedPath(workspace: string, raw: string, mustExist: boolean): Promise<string> {
  const root = await fs.realpath(workspace);
  const requested = path.resolve(root, raw);
  if (!relativeInside(root, requested)) problem("path_outside_workspace", "File is outside the authorized workspace");
  if (mustExist) {
    const actual = await fs.realpath(requested).catch(() => problem("input_missing", "Input file does not exist"));
    if (!relativeInside(root, actual)) problem("path_outside_workspace", "Input resolves outside workspace");
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > MAX_INPUT || stat.size === 0) problem("input_invalid", "Input must be a regular nonempty file at most 100 MiB");
    return actual;
  }
  const actualParent = await fs.realpath(path.dirname(requested)).catch(() => problem("output_parent_missing", "Output directory must already exist"));
  if (!relativeInside(root, actualParent)) problem("path_outside_workspace", "Output directory resolves outside workspace");
  const destination = path.join(actualParent, path.basename(requested));
  if (await fs.lstat(destination).then(() => true, () => false)) problem("output_exists", "Output already exists; overwrite is disabled");
  return destination;
}
async function validatedInput(file: string): Promise<string> {
  return inspectMediaFormat(file, MAX_INPUT);
}
function sha256(buffer: Buffer): string { return crypto.createHash("sha256").update(buffer).digest("hex"); }
async function attest(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_OUTPUT) problem("output_invalid", "Output exceeds size limit or is empty");
  await inspectMediaFormat(file, MAX_OUTPUT);
  return { path: file, sizeBytes: stat.size, sha256: sha256(await fs.readFile(file)) };
}
function tempName(dest: string): string {
  return path.join(path.dirname(dest), ".sa-media-" + crypto.randomUUID() + path.extname(dest));
}
async function publish(stage: string, destination: string): Promise<ReturnType<typeof attest> extends Promise<infer T> ? T : never> {
  // Hard-link to the same-directory staging file ensures create-only publication (no TOCTOU overwrite).
  await fs.link(stage, destination);
  return attest(destination);
}
async function runStaged(destination: string, action: (temp: string) => Promise<{ paths?: string[]; backend: string; warnings?: string[] }>) {
  const stage = tempName(destination);
  const published: string[] = [];
  try {
    const result = await action(stage);
    const paths = result.paths ?? [stage];
    if (!paths.length || paths.length > 100) problem("invalid_backend", "Backend produced invalid output count");
    const output = [];
    for (const candidate of paths) {
      const source = path.resolve(candidate);
      if (path.dirname(source) !== path.dirname(stage)) problem("invalid_backend", "Backend wrote outside output directory");
      const target = source === stage ? destination : path.join(path.dirname(destination), path.basename(source).replace(path.basename(stage, path.extname(stage)), path.basename(destination, path.extname(destination))));
      if (source === target) problem("invalid_backend", "Output staging collision");
      const item = await attest(source);
      if (!item.sizeBytes) problem("invalid_backend", "Empty artifact");
      const final = await publish(source, target);
      published.push(target);
      output.push(final);
    }
    return { status: "ok" as const, backend: result.backend, outputs: output, warnings: result.warnings ?? [] };
  } catch (error) {
    await Promise.all(published.map(p => fs.unlink(p).catch(() => {})));
    throw error;
  } finally {
    const parent = path.dirname(stage);
    const prefix = path.basename(stage, path.extname(stage));
    const files = await fs.readdir(parent).catch(() => []);
    await Promise.all(files.filter(f => f === path.basename(stage) || f.startsWith(prefix + "-p")).map(f => fs.unlink(path.join(parent, f)).catch(() => {})));
  }
}
async function sharpEngine() {
  try { return (await import("sharp")).default; }
  catch { return problem("backend_unavailable", "Sharp is not installed"); }
}
async function pythonBackend(task: Record<string, unknown>, signal?: AbortSignal) {
  const actual = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/media_backend.py");
  await fs.access(actual).catch(() => problem("backend_unavailable", "Bundled Python media adapter not found"));
  const run = await execa("python", [actual, JSON.stringify(task)], {
    reject: false, timeout: 120000, maxBuffer: 1024 * 1024,
    signal, windowsHide: true,
  }).catch(error => problem("backend_unavailable", "Python adapter could not start: " + String((error as Error).message).slice(0, 180)));
  let payload: any;
  try { payload = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1) || "{}"); }
  catch { problem("backend_error", "Python backend returned malformed JSON"); }
  if (run.exitCode !== 0 || payload.status !== "ok") problem(String(payload.code || "backend_error"), String(payload.message || run.stderr || "Python conversion failed").slice(0, 320));
  if (!Array.isArray(payload.outputs)) problem("invalid_backend", "Backend returned no artifact list");
  return { paths: payload.outputs as string[], backend: String(payload.backend || "python"), warnings: payload.warnings as string[] || [] };
}
async function sharpConvert(source: string, stage: string, options: MediaRequest, signal?: AbortSignal, watermarkSource?: string) {
  if (signal?.aborted) problem("cancelled", "Conversion cancelled");
  const sharp = await sharpEngine();
  const metadata = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
  if (metadata.pages && metadata.pages > 1 && options.frame === undefined) problem("multi_frame_requires_selection", "Animated/multi-frame image needs explicit frame selection");
  const frame = numberOption(options.frame, 0, 0, Math.max(0, (metadata.pages || 1) - 1), "frame");
  const op = String(options.operation || "convert");
  let image = sharp(source, { limitInputPixels: MAX_PIXELS, page: frame, pages: 1, animated: false });
  if (op === "rotate") {
    const degrees = numberOption(options.degrees, 90, 0, 360, "degrees");
    image = image.rotate(degrees);
  } else {
    image = image.rotate();
  }
  const w = options.width === undefined ? undefined : Math.floor(numberOption(options.width, 1, 1, 16000, "width"));
  const h = options.height === undefined ? undefined : Math.floor(numberOption(options.height, 1, 1, 16000, "height"));
  if (w && h && w * h > MAX_PIXELS) problem("limit_exceeded", "Output dimensions exceed 40 megapixels");
  if (op === "resize" || op === "convert" || op === "crop") {
    if (op === "crop") {
      const left = Math.floor(numberOption(options.left, 0, 0, 16000, "left"));
      const top = Math.floor(numberOption(options.top, 0, 0, 16000, "top"));
      if (!w || !h) problem("invalid_argument", "Crop requires width and height");
      image = image.extract({ left, top, width: w, height: h });
    } else if (w || h) image = image.resize({ width: w, height: h, fit: options.fit === "cover" ? "cover" : "inside", withoutEnlargement: options.allowEnlarge !== true });
  } else if (op === "flip_vertical") {
    image = image.flip();
  } else if (op === "flop_horizontal") {
    image = image.flop();
  } else if (op === "grayscale") {
    image = image.grayscale();
  } else if (op === "compress" || op === "rotate") {
    // Rotation is configured above. Compression is handled at format encode time.
  } else if (op === "watermark") {
    if (!watermarkSource) problem("invalid_argument", "watermarkPath must specify an authorized raster image");
    const baseWidth = metadata.autoOrient?.width || metadata.width || 1;
    const markWidth = Math.floor(numberOption(options.watermarkWidth,
      Math.max(1, Math.floor(baseWidth / 4)), 1, 16000, "watermarkWidth"));
    const overlay = await sharp(watermarkSource, { limitInputPixels: MAX_PIXELS })
      .rotate().resize({ width: markWidth, withoutEnlargement: true }).png().toBuffer();
    image = image.composite([{ input: overlay, gravity: "southeast" }]);
  } else problem("unsupported_operation", "Unsupported raster transform operation: " + op);
  const ext = path.extname(stage).toLowerCase();
  const format = ({ ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp",
    ".avif": "avif", ".tif": "tiff", ".tiff": "tiff", ".gif": "gif" } as Record<string, string>)[ext];
  if (!format) problem("unsupported_format", "Unsupported image output");
  if (format === "jpeg") image = image.flatten({ background: "#ffffff" });
  const quality = Math.floor(numberOption(options.quality, 85, 1, 100, "quality"));
  await image.toFormat(format as keyof import("sharp").FormatEnum, format === "png" ? {} : { quality }).toFile(stage);
  return { backend: "sharp" };
}
export async function mediaInspect(args: MediaRequest, workspace: string): Promise<MediaResult> {
  const input = await scopedPath(workspace, getString(args.inputPath, "inputPath"), true);
  const ext = await validatedInput(input);
  const stat = await fs.stat(input);
  const common = { status: "ok" as const, input, format: ext.slice(1), sizeBytes: stat.size, sha256: sha256(await fs.readFile(input)) };
  if (IMAGE_INPUTS.has(ext)) {
    const sharp = await sharpEngine();
    const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
    return { ...common, width: meta.width, height: meta.height, pages: meta.pages ?? 1, hasAlpha: meta.hasAlpha, orientation: meta.orientation };
  }
  if (ext === ".pdf") {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(await fs.readFile(input), { updateMetadata: false });
    return { ...common, pages: pdf.getPageCount(), encrypted: false };
  }
  return { ...common, note: "Office metadata inspection is limited to container signature and file hash" };
}
export async function mediaTransform(args: MediaRequest, workspace: string, signal?: AbortSignal): Promise<MediaResult> {
  const source = await scopedPath(workspace, getString(args.inputPath, "inputPath"), true);
  const ext = await validatedInput(source);
  if (!IMAGE_INPUTS.has(ext)) problem("unsupported_format", "media_transform requires an image");
  const output = await scopedPath(workspace, getString(args.outputPath, "outputPath"), false);
  const action = getString(args.operation, "operation");
  const target = path.extname(output).toLowerCase();
  if (action === "remove_background") {
    if (target !== ".png") problem("unsupported_format", "Background removal requires PNG output");
    return runStaged(output, stage => pythonBackend({ kind: "remove_background", source, output: stage, model: args.model }, signal));
  }
  if (action === "upscale_ai") {
    if (target !== ".png") problem("unsupported_format", "AI upscale currently requires PNG output");
    const factor = numberOption(args.scale, 2, 2, 4, "scale");
    if (![2, 3, 4].includes(factor)) problem("invalid_argument", "Upscale scale must be 2, 3, or 4");
    const dimension = await (await sharpEngine())(source).metadata();
    if ((dimension.width || 0) * (dimension.height || 0) * factor * factor > MAX_PIXELS) problem("limit_exceeded", "AI upscale would exceed pixel limit");
    return runStaged(output, async stage => {
      const installedRoot = path.join(os.homedir(), ".superagent-r", "media-backends", "realesrgan");
      const portable = path.join(installedRoot, process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan");
      const hasPortable = await fs.access(portable).then(() => true, () => false);
      const binary = hasPortable ? portable : "realesrgan-ncnn-vulkan";
      const argumentsList = ["-i", source, "-o", stage, "-s", String(factor), "-n", "realesrgan-x4plus", "-t", "128"];
      if (hasPortable) argumentsList.push("-m", path.join(installedRoot, "models"));
      const run = await execa(binary, argumentsList, {
        cwd: hasPortable ? installedRoot : undefined,
        reject: false, timeout: 180000, signal, windowsHide: true,
      }).catch(() => problem("backend_unavailable", "Install Real-ESRGAN NCNN Vulkan and weights for AI upscale"));
      if (run.exitCode !== 0) problem("upscale_failed", run.stderr.slice(0, 300));
      return { backend: "Real-ESRGAN NCNN Vulkan" };
    });
  }
  if (!IMAGE_OUTPUTS.has(target)) problem("unsupported_format", "Output must be a raster image");
  let watermarkSource: string | undefined;
  if (action === "watermark") {
    watermarkSource = await scopedPath(workspace, getString(args.watermarkPath, "watermarkPath"), true);
    const watermarkType = await validatedInput(watermarkSource);
    if (!IMAGE_INPUTS.has(watermarkType)) problem("unsupported_format", "Watermark source must be a supported raster image");
  }
  return runStaged(output, stage => sharpConvert(source, stage, args, signal, watermarkSource));
}
export async function mediaConvert(args: MediaRequest, workspace: string, signal?: AbortSignal): Promise<MediaResult> {
  const raws = Array.isArray(args.inputPaths) ? args.inputPaths : [args.inputPath];
  if (!raws.length || raws.length > 50) problem("invalid_argument", "Specify 1-50 inputs");
  const sources: { source: string; ext: string }[] = [];
  for (const raw of raws) {
    const source = await scopedPath(workspace, getString(raw, "inputPath"), true);
    const ext = await validatedInput(source);
    sources.push({ source, ext });
  }
  const output = await scopedPath(workspace, getString(args.outputPath, "outputPath"), false);
  const target = path.extname(output).toLowerCase();
  const first = sources[0];
  if (sources.every(s => IMAGE_INPUTS.has(s.ext))) {
    const sharp = await sharpEngine();
    let totalPixels = 0;
    for (const entry of sources) {
      const metadata = await sharp(entry.source, { limitInputPixels: MAX_PIXELS }).metadata();
      const pixels = (metadata.width || 0) * (metadata.height || 0);
      if (pixels < 1 || pixels > MAX_PIXELS) problem("limit_exceeded", "Source image exceeds 40 megapixels");
      totalPixels += pixels;
      if (totalPixels > 100_000_000) problem("limit_exceeded", "Combined source images exceed the 100-megapixel batch budget");
      if ((metadata.pages ?? 1) > 1 && target && OFFICE.has(target)) {
        problem("unsupported_multiframe", "Animated or multi-page raster sources cannot be embedded into Office documents");
      }
      if ((metadata.pages ?? 1) > 1 && args.frame === undefined) {
        problem("multi_frame_requires_selection", "Animated raster sources require an explicit frame selection");
      }
    }
    if (target === ".pdf") return runStaged(output, async stage => {
      const { PDFDocument } = await import("pdf-lib");
      const document = await PDFDocument.create();
      for (const source of sources) {
        const frame = args.frame === undefined ? 0 : Math.floor(numberOption(args.frame, 0, 0, 100, "frame"));
        const input = await sharp(source.source, { limitInputPixels: MAX_PIXELS, page: frame, pages: 1 }).rotate().png().toBuffer();
        const image = await document.embedPng(input);
        const page = document.addPage([image.width * 0.75, image.height * 0.75]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
      await fs.writeFile(stage, await document.save(), { flag: "wx" });
      return { backend: "pdf-lib + sharp" };
    });
    if (OFFICE.has(target)) return runStaged(output, stage => pythonBackend({ kind: "image_document", sources: sources.map(x => x.source), output: stage, targetExt: target }, signal));
    if (IMAGE_OUTPUTS.has(target) && sources.length === 1) return runStaged(output, stage => sharpConvert(first.source, stage, args, signal));
  }
  if (sources.length !== 1) problem("unsupported_conversion", "Multiple inputs are supported only for image-to-PDF/Office");
  if (first.ext === ".pdf" && IMAGE_OUTPUTS.has(target)) {
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(target)) problem("unsupported_conversion", "PDF can render to PNG, JPEG, or WebP");
    return runStaged(output, stage => pythonBackend({
      kind: "render_pdf", source: first.source, output: stage, page: args.page, allPages: args.allPages, dpi: args.dpi,
    }, signal));
  }
  if (first.ext === ".pdf" && OFFICE.has(target)) return runStaged(output, stage => pythonBackend({
    kind: "pdf_editable", source: first.source, output: stage, targetExt: target,
  }, signal));
  if (OFFICE.has(first.ext) && target === ".pdf") return runStaged(output, stage => pythonBackend({ kind: "office_pdf", source: first.source, output: stage }, signal));
  if (OFFICE.has(first.ext) && [".png", ".jpg", ".jpeg", ".webp"].includes(target)) return runStaged(output, stage => pythonBackend({
    kind: "office_image", source: first.source, output: stage, page: args.page, allPages: args.allPages, dpi: args.dpi,
  }, signal));
  if ((first.ext === ".csv" || first.ext === ".tsv") && target === ".xlsx") return runStaged(output, async stage => {
    const XLSX = await import("@e965/xlsx");
    const raw = await fs.readFile(first.source, "utf8");
    const book = XLSX.read(raw, { type: "string", raw: true, FS: first.ext === ".tsv" ? "\t" : "," });
    await fs.writeFile(stage, XLSX.write(book, { bookType: "xlsx", type: "buffer" }), { flag: "wx" });
    return { backend: "@e965/xlsx" };
  });
  if (first.ext === ".xlsx" && [".csv", ".tsv"].includes(target)) return runStaged(output, async stage => {
    const XLSX = await import("@e965/xlsx");
    const book = XLSX.read(await fs.readFile(first.source), { type: "buffer" });
    if (book.SheetNames.length < 1) problem("input_invalid", "Workbook is empty");
    const content = XLSX.utils.sheet_to_csv(book.Sheets[book.SheetNames[0]], { FS: target === ".tsv" ? "\t" : "," });
    await fs.writeFile(stage, content, { flag: "wx" });
    return { backend: "@e965/xlsx", warnings: ["Only the first worksheet was exported."] };
  });
  problem("unsupported_conversion", "No safe verified conversion route for " + first.ext + " -> " + target);
}
export async function mediaBatch(args: MediaRequest, workspace: string, signal?: AbortSignal): Promise<MediaResult> {
  if (!Array.isArray(args.jobs) || args.jobs.length < 1 || args.jobs.length > 20) problem("invalid_argument", "Batch requires 1-20 jobs");
  const jobs: MediaResult[] = [];
  for (const job of args.jobs) {
    if (signal?.aborted) {
      return { status: "failed", code: "cancelled", completed: jobs.length, total: args.jobs.length,
        succeeded: jobs.filter(entry => entry.status === "ok").length, cancelled: true, jobs };
    }
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      jobs.push({ status: "failed", code: "invalid_job" });
    } else {
      try {
        const payload = job as Record<string, unknown>;
        if (payload.mode !== "convert" && payload.mode !== "transform") problem("invalid_job", "Batch mode must be transform or convert");
        jobs.push(payload.mode === "convert" ? await mediaConvert(payload, workspace, signal) : await mediaTransform(payload, workspace, signal));
      } catch (error) { jobs.push(mediaError(error)); }
    }
    if (args.stopOnError === true && jobs.at(-1)?.status === "failed") break;
  }
  const succeeded = jobs.filter(entry => entry.status === "ok").length;
  return { status: jobs.length === args.jobs.length && succeeded === jobs.length ? "ok" : "failed",
    completed: jobs.length, total: args.jobs.length, succeeded, failed: jobs.length - succeeded,
    stoppedEarly: jobs.length < args.jobs.length, jobs };
}
export async function mediaCapabilities() {
  const available: Record<string, boolean> = { sharp: false, python: false, rembg: false, pillow: false, pymupdf: false, openpyxl: false, python_docx: false, python_pptx: false, libreoffice: false, realesrgan_ncnn: false };
  try { await sharpEngine(); available.sharp = true; } catch {}
  try {
    const probe = await execa("python", ["-c", "import importlib.util,json,shutil;print(json.dumps({k:bool(importlib.util.find_spec(v)) for k,v in {'rembg':'rembg','pillow':'PIL','pymupdf':'fitz','openpyxl':'openpyxl','python_docx':'docx','python_pptx':'pptx','win32com':'win32com'}.items()}))"], { reject: false, timeout: 10000, windowsHide: true });
    if (probe.exitCode === 0) { available.python = true; Object.assign(available, JSON.parse(probe.stdout)); }
  } catch {}
  for (const [key, binary] of [["libreoffice", "soffice"], ["realesrgan_ncnn", "realesrgan-ncnn-vulkan"]]) {
    try {
      const probe = await execa(binary, ["--version"], { reject: false, timeout: 4000, windowsHide: true });
      available[key] = probe.exitCode === 0;
    } catch {}
  }
  const bundled = path.join(os.homedir(), ".superagent-r", "media-backends", "realesrgan");
  if (await fs.access(path.join(bundled, process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan")).then(() => true, () => false)
    && await fs.access(path.join(bundled, "models")).then(() => true, () => false)) available.realesrgan_ncnn = true;
  available.rembg_model_u2netp = available.rembg &&
    await fs.access(path.join(os.homedir(), ".u2net", "u2netp.onnx")).then(() => true, () => false);
  available.office_win32 = process.platform === "win32" && available.win32com;
  return { status: "ok", available, imageFormats: [...IMAGE_OUTPUTS], documents: [...OFFICE, ".pdf", ".csv", ".tsv"],
    limitations: ["Editable PDF conversion is best-effort", "Office export requires LibreOffice or installed Windows Office with pywin32", "Background removal requires locally provisioned rembg and model", "AI upscale requires Real-ESRGAN NCNN Vulkan"] };
}
export function mediaError(error: unknown): MediaResult {
  const obj = error as { code?: string; message?: string } | undefined;
  return { status: "failed", code: obj?.code || "media_operation_failed", message: String(obj?.message || error).slice(0, 400) };
}
