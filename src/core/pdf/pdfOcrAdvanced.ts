/** Workspace-scoped PDF OCR with pinned offline pretrained RapidOCR/Tesseract. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { bytesFromPdf, hash, pdfDoc, PdfOperationError, rootDir } from "./pdfEngine.js";

type Tier = "auto" | "tiny" | "small" | "medium" | "tesseract";
type Lang = "auto" | "id" | "en";
const workerScript = fileURLToPath(new URL("../../../scripts/pdf_ocr_backend.py", import.meta.url));
const profileRoot = path.join(os.homedir(), ".superagent-r");
const modelRoot = path.join(profileRoot, "models", "pdf-ocr-v6");
const pythonExe = path.join(profileRoot, "venvs", "pdf-ocr-rapid",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
function deny(code: string, message: string): never { throw new PdfOperationError(code, message); }
function boundedPages(value: unknown, max: number): number[] {
  if (value === undefined) {
    if (max > 20) deny("page_limit", "Choose explicit pages for PDFs exceeding 20 pages.");
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some(v => !Number.isInteger(v) || v < 1 || v > max) ||
      new Set(value).size !== value.length) {
    deny("invalid_input", "Choose 1 to 20 unique 1-based page numbers.");
  }
  return value as number[];
}
function choice<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, field: string): T {
  const value = raw === undefined ? fallback : raw;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    deny("invalid_input", "Invalid " + field + ". Allowed: " + allowed.join(", "));
  }
  return value as T;
}
async function pickBackend(tier: Tier): Promise<Exclude<Tier, "auto">> {
  if (tier !== "auto") return tier;
  const checks = [
    ["small", path.join(modelRoot, "small", "PP-OCRv6_rec_small.onnx")],
    ["tiny", path.join(modelRoot, "tiny", "PP-OCRv6_rec_tiny.onnx")],
    ["tesseract", path.join(modelRoot, "tessdata", "ind.traineddata")],
  ] as const;
  for (const [name, file] of checks) {
    if (await fs.stat(file).then(s => s.isFile()).catch(() => false)) return name;
  }
  deny("ocr_backend_unavailable", "No provisioned pretrained offline OCR model found.");
}
type OcrLine = { text: string; confidence: number | null; quad: number[][] };
type WorkerPage = { page: number; text: string; lines: OcrLine[];
  lineCount: number; elapsedSeconds: number; imageSha256: string; truncated?: boolean };
type WorkerResult = { status: string; code?: string; message?: string;
  engine?: string; modelHashes?: Record<string, string>; pages?: WorkerPage[];
  coldStartSeconds?: number; wallSeconds?: number; observedRssBytes?: number;
  rssMeasurement?: string; runtimeVersions?: Record<string, string | null> };

async function runWorker(engine: Exclude<Tier, "auto">, language: Lang,
  images: Array<{ path: string }>, maxChars: number, signal?: AbortSignal): Promise<WorkerResult> {
  if (signal?.aborted) deny("cancelled", "OCR request cancelled.");
  for (const file of [pythonExe, workerScript]) {
    if (!await fs.stat(file).then(s => s.isFile()).catch(() => false)) {
      deny("ocr_backend_unavailable", "Pinned offline OCR worker is not installed.");
    }
  }
  const request = JSON.stringify({ engine, language, images, maxChars });
  if (request.length > 32_000) deny("invalid_input", "OCR request exceeds worker limit.");
  return new Promise<WorkerResult>((resolve, reject) => {
    const child = spawn(pythonExe, [workerScript], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal,
      env: { ...process.env, OMP_NUM_THREADS: "4", OPENBLAS_NUM_THREADS: "4",
        MKL_NUM_THREADS: "4", VECLIB_MAXIMUM_THREADS: "4" },
    });
    let stdout = "";
    let done = false;
    const fail = (code: string, msg: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new PdfOperationError(code, msg));
    };
    const timer = setTimeout(() => {
      child.kill();
      fail("ocr_timeout", "Local OCR exceeded bounded deadline.");
    }, 105000);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 6_000_000) {
        child.kill();
        fail("ocr_result_limit", "OCR returned excessive output.");
      }
    });
    child.stderr.resume(); // stderr may include private document paths/text
    child.stdin.on("error", () => undefined);
    child.on("error", err => fail(signal?.aborted ? "cancelled" : "ocr_backend_failed",
      "Cannot start local OCR worker: " + err.message.slice(0, 100)));
    child.on("close", code => {
      if (done) return;
      if (signal?.aborted) return fail("cancelled", "OCR cancelled.");
      if (code !== 0) return fail("ocr_backend_failed", "Local OCR worker exited abnormally.");
      let response: WorkerResult;
      try { response = JSON.parse(stdout) as WorkerResult; }
      catch { return fail("ocr_backend_failed", "OCR worker returned non-JSON output."); }
      if (response.status !== "verified" || !Array.isArray(response.pages) ||
          response.pages.length !== images.length) {
        return fail(response.code || "ocr_backend_failed", response.message || "Invalid OCR worker result.");
      }
      done = true;
      clearTimeout(timer);
      resolve(response);
    });
    child.stdin.end(request);
  });
}

export async function ocrPdfPretrained(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  if (typeof args.inputPath !== "string" || !args.inputPath.trim()) {
    deny("invalid_input", "inputPath is required.");
  }
  const input = await bytesFromPdf(args.inputPath, root);
  if (args.expectedInputSha256 !== undefined && args.expectedInputSha256 !== input.sha256) {
    deny("hash_mismatch", "Source SHA256 changed since inspection.");
  }
  const doc = await pdfDoc(input.bytes);
  const pages = boundedPages(args.pages, doc.getPageCount());
  const tier = choice(args.engine, ["auto","tiny","small","medium","tesseract"] as const, "auto", "engine");
  const language = choice(args.language, ["auto","id","en"] as const, "auto", "language");
  const forceOcr = args.forceOcr === true;
  const maxChars = args.maxChars === undefined ? 30000 : args.maxChars;
  if (!Number.isInteger(maxChars) || (maxChars as number) < 1 || (maxChars as number) > 100000) {
    deny("invalid_input", "maxChars must be 1..100000.");
  }
  const scale = args.scale === undefined ? 2 : args.scale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 1 || scale > 2.5) {
    deny("invalid_input", "scale must be 1..2.5.");
  }
  const parser = new PDFParse({ data: Uint8Array.from(input.bytes) });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-ocr-"));
  await fs.chmod(temp, 0o700).catch(() => undefined);
  const pagesByNum = new Map<number, Record<string, unknown>>();
  let worker: WorkerResult | undefined;
  const scan: number[] = [];
  try {
    const originalText = await parser.getText({ partial: pages });
    if (originalText.pages.length !== pages.length) deny("ocr_parse_failed", "Missing PDF text page.");
    for (const p of originalText.pages) {
      if (!pages.includes(p.num)) deny("ocr_parse_failed", "Unexpected PDF text page.");
      if (p.text.trim().length > 0 && !forceOcr) {
        pagesByNum.set(p.num, { page: p.num, text: p.text, backend: "pdf-text-layer",
          ocrPerformed: false, lines: [], coordinateSystem: "PDF native text extraction" });
      } else scan.push(p.num);
    }
    if (scan.length) {
      const shots = await parser.getScreenshot({ partial: scan, scale,
        imageBuffer: true, imageDataUrl: false });
      if (shots.pages.length !== scan.length) deny("ocr_render_failed", "Unexpected PDF render count.");
      const files: Array<{ path: string; width: number; height: number }> = [];
      for (let i = 0; i < scan.length; i++) {
        const shot = shots.pages[i];
        if (shot.pageNumber !== scan[i] || !shot.data || shot.data.length > 35 * 1024 * 1024 ||
            !Number.isFinite(shot.width) || !Number.isFinite(shot.height) ||
            shot.width * shot.height > 12_000_000) {
          deny("ocr_render_failed", "Invalid or oversized OCR page raster.");
        }
        const file = path.join(temp, "page-" + scan[i] + ".png");
        await fs.writeFile(file, shot.data, { mode: 0o600, flag: "wx" });
        files.push({ path: file, width: shot.width, height: shot.height });
      }
      worker = await runWorker(await pickBackend(tier), language,
        files.map(f => ({ path: f.path })), maxChars as number, signal);
      for (let i = 0; i < files.length; i++) {
        const item = worker.pages![i];
        const file = files[i];
        if (item.imageSha256 !== hash(await fs.readFile(file.path))) {
          deny("ocr_integrity_mismatch", "OCR page bytes changed.");
        }
        pagesByNum.set(scan[i], {
          page: scan[i], text: item.text, lines: item.lines, ocrPerformed: true,
          backend: worker.engine, confidenceUncalibrated: true, lineCount: item.lineCount,
          imageWidth: file.width, imageHeight: file.height,
          coordinateSystem: "image pixels, top-left origin; image size provided",
          imageSha256: item.imageSha256, elapsedSeconds: item.elapsedSeconds,
        });
      }
    }
    if (signal?.aborted) deny("cancelled", "OCR cancelled.");
    if (hash(await fs.readFile(input.file)) !== input.sha256) deny("hash_mismatch", "Source PDF changed during OCR.");
    const ordered = pages.map(p => {
      const result = pagesByNum.get(p);
      if (!result) deny("ocr_backend_failed", "Missing OCR page result.");
      return result;
    });
    const full = ordered.map(p => String(p.text || "")).join("\n\n");
    const ocrPerformed = scan.length > 0;
    const nonempty = full.trim().length > 0;
    return {
      status: !nonempty || full.length > (maxChars as number) ? "partial" : "verified",
      backend: worker?.engine || "pdf-text-layer", ocrPerformed,
      scannedPages: scan, inputSha256: input.sha256,
      totalPageCount: doc.getPageCount(), pageCount: ordered.length,
      text: full.slice(0, maxChars as number), truncated: full.length > (maxChars as number),
      pages: ordered, modelHashes: worker?.modelHashes || {},
      metrics: worker ? {
        coldStartSeconds: worker.coldStartSeconds, wallSeconds: worker.wallSeconds,
        observedRssBytes: worker.observedRssBytes,
        rssMeasurement: worker.rssMeasurement,
      } : null,
      warning: ocrPerformed
        ? "Actual local pretrained OCR executed on scanned pages. OCR text and boxes require human verification."
        : "Selectable PDF text extracted. No OCR model ran; set forceOcr=true to request OCR.",
    };
  } finally {
    await parser.destroy().catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
