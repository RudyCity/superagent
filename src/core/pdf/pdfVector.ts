/**
 * Strict pikepdf/pdfminer backend boundary for one exact, simple PDF content
 * stream text operator. This is NOT arbitrary PDF text editing.
 *
 * No shell; source and output paths are project-scoped and create-only.
 * Python backend is an optional operator-installed isolated environment.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  bytesFromPdf, hash, isSigned, outputPath, pdfDoc, publish, PdfOperationError, rootDir,
} from "./pdfEngine.js";

function deny(code: string, message: string): never { throw new PdfOperationError(code, message); }
const ASCII = /^[\x20-\x7e]{1,200}$/;
const BACKEND_SCRIPT = fileURLToPath(new URL("../../../scripts/pdf_vector_backend.py", import.meta.url));
function pythonCandidates(): string[] {
  const operatorConfigured = process.env.SUPERAGENT_PDF_PYTHON_BIN;
  const venv = path.join(os.homedir(), ".superagent-r", "venvs", "pdf-advanced",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return [...(operatorConfigured ? [operatorConfigured] : []), venv];
}
async function runPython(
  request: Record<string, unknown>, cwd: string, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) deny("cancelled", "Operation cancelled.");
  const stat = await fs.stat(BACKEND_SCRIPT).catch(() => null);
  if (!stat?.isFile()) deny("advanced_backend_unavailable", "Install the bundled pdf_vector_backend.py script with the SuperAgent runtime.");
  const python = (await Promise.all(pythonCandidates().map(p => fs.stat(p).catch(() => null))))
    .map((st, idx) => st?.isFile() ? pythonCandidates()[idx] : null).find(Boolean);
  if (!python) deny("advanced_backend_unavailable", "pikepdf environment is not installed. See scripts/pdf-vector-requirements.txt.");
  const data = JSON.stringify(request);
  if (Buffer.byteLength(data) > 16 * 1024) deny("size_limit", "Operation exceeds restricted backend input size.");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [BACKEND_SCRIPT], {
      cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal,
    });
    let stdout = "";
    let stderr = "";
    let completed = false;
    const fail = (error: Error) => { if (!completed) { completed = true; reject(error); } };
    const timer = setTimeout(() => { child.kill(); fail(new PdfOperationError("timeout", "Vector engine exceeded 25 seconds.")); }, 25_000);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 32_000) child.kill();
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-1000);
    });
    child.on("error", error => { clearTimeout(timer); fail(new PdfOperationError("advanced_backend_unavailable", "Could not start Python PDF backend: " + error.message.slice(0, 150))); });
    child.on("close", status => {
      clearTimeout(timer);
      if (completed) return;
      completed = true;
      if (signal?.aborted) return reject(new PdfOperationError("cancelled", "PDF edit cancelled."));
      if (status !== 0 || stdout.length > 32_000) return reject(new PdfOperationError("advanced_backend_failed", "Vector backend exited without a valid result."));
      try {
        const result = JSON.parse(stdout.trim());
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid response");
        if (result.status === "failed") return reject(new PdfOperationError(String(result.code || "advanced_backend_failed"), String(result.message || "Unable to safely edit this PDF.")));
        resolve(result);
      } catch {
        reject(new PdfOperationError("advanced_backend_failed", "Vector backend returned an invalid response; " + stderr.slice(0, 70)));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(data);
  });
}

export async function editPdfVectorExact(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const mode = args.mode;
  if (mode !== "replace_exact" && mode !== "redact_exact") deny("invalid_input", "Mode must be replace_exact or redact_exact.");
  if (mode === "redact_exact" && args.confirmRedact !== true) {
    deny("confirmation_required", "Exact vector redaction irreversibly removes text; confirmRedact=true required.");
  }
  const target = args.targetText;
  const replacement = args.replacementText;
  const fontPolicy = args.fontPolicy === undefined ? "standard14" : args.fontPolicy;
  if (fontPolicy !== "standard14" && fontPolicy !== "embedded_subset") {
    deny("invalid_input", "fontPolicy must be standard14 or embedded_subset.");
  }
  let fitBounds: {x0:number;y0:number;x1:number;y1:number}|undefined;
  if (args.fitBounds !== undefined) {
    if (mode !== "replace_exact" || fontPolicy !== "embedded_subset" ||
        typeof args.fitBounds !== "object" || args.fitBounds === null || Array.isArray(args.fitBounds)) {
      deny("invalid_input", "fitBounds is only supported for embedded-subset text replacement.");
    }
    const raw=args.fitBounds as Record<string,unknown>;
    if (Object.keys(raw).sort().join(",") !== "x0,x1,y0,y1") {
      deny("invalid_input", "fitBounds requires exactly x0,y0,x1,y1.");
    }
    const values=["x0","y0","x1","y1"].map(k=>raw[k]);
    if (values.some(v=>typeof v!=="number" || !Number.isFinite(v))) {
      deny("invalid_input", "fitBounds values must be finite numbers.");
    }
    fitBounds={x0:values[0] as number,y0:values[1] as number,x1:values[2] as number,y1:values[3] as number};
    if (!(fitBounds.x1>fitBounds.x0 && fitBounds.y1>fitBounds.y0 &&
          fitBounds.x1-fitBounds.x0>=10 && fitBounds.x1-fitBounds.x0<=450 &&
          fitBounds.y1-fitBounds.y0>=6 && fitBounds.y1-fitBounds.y0<=120)) {
      deny("invalid_input", "fitBounds must define a bounded visible page region.");
    }
  }
  if (fontPolicy === "embedded_subset" && mode === "redact_exact") {
    deny("unsupported_content", "Embedded Unicode redaction requires a separate, forensically verified workflow.");
  }
  const allowable = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.normalize("NFC") !== value) return false;
    return [...value].every(char => {
      const cp = char.codePointAt(0)!;
      return ((cp >= 32 && cp <= 0x024f) || [0x2013,0x2014,0x2018,0x2019,0x201c,0x201d,0x2026].includes(cp)) &&
        !/[\p{Cc}\p{Cf}\p{Mn}\p{Mc}\p{Me}]/u.test(char);
    });
  };
  if (fontPolicy === "standard14"
    ? (typeof target !== "string" || !ASCII.test(target) ||
       (mode === "replace_exact" && (typeof replacement !== "string" || !ASCII.test(replacement))))
    : (!allowable(target) || (mode === "replace_exact" && !allowable(replacement)))) {
    deny("unsupported_unicode", "Exact vector edit requires supported original glyphs and explicit font policy.");
  }
  if (typeof args.page !== "number" || !Number.isInteger(args.page) || args.page < 1 || args.page > 500) {
    deny("invalid_input", "page must be an integer between 1 and 500.");
  }
  const root = await rootDir(cwd);
  const input = await bytesFromPdf(String(args.inputPath || ""), root);
  if (isSigned(input.bytes)) deny("signed_document", "Modifying a signed PDF is prohibited.");
  if (!args.expectedInputSha256 || String(args.expectedInputSha256).toLowerCase() !== input.sha256) {
    deny("hash_mismatch", "A verified expectedInputSha256 from pdf_inspect is required.");
  }
  const output = await outputPath(String(args.outputPath || ""), root);
  if (output === input.file) deny("path_denied", "In-place PDF editing is not permitted.");
  const sourceDoc = await pdfDoc(input.bytes);
  if (args.page > sourceDoc.getPageCount()) deny("invalid_input", "Selected page does not exist.");
  if (fitBounds) {
    const pg = sourceDoc.getPage((args.page as number)-1);
    const {width,height}=pg.getSize();
    if (fitBounds.x0 < 0 || fitBounds.y0 < 0 || fitBounds.x1 > width || fitBounds.y1 > height) {
      deny("invalid_input", "fitBounds must be inside the source page.");
    }
  }
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-vector-"));
  await fs.chmod(stageDir, 0o700).catch(() => undefined);
  try {
    const stagingPath = path.join(stageDir, "edited.pdf");
    const result = await runPython({
      mode, fontPolicy, page: args.page, inputPath: input.file, stagingPath,
      targetText: target, replacementText: replacement, expectedInputSha256: input.sha256,
      ...(fitBounds ? {fitBounds} : {}),
    }, root, signal);
    const bytes = await fs.readFile(stagingPath);
    if (bytes.length > 100 * 1024 * 1024 || hash(bytes) !== result.stagingSha256) {
      deny("verification_failed", "Python backend output integrity mismatch.");
    }
    const checkDoc = await pdfDoc(bytes);
    if (checkDoc.getPageCount() !== sourceDoc.getPageCount()) deny("verification_failed", "Page count changed during local vector modification.");
    const parser = new PDFParse({ data: Uint8Array.from(bytes) });
    try {
      const resultText = await parser.getText();
      const content = resultText.pages.map(page => page.text).join("\n");
      const visibleLines=resultText.pages.flatMap(page=>page.text.split(/\r?\n/));
      const normalizeLine=(text:string)=>text.trim().replace(/\s+/g," ");
      if (visibleLines.some(line=>normalizeLine(line)===normalizeLine(target as string))) {
        deny("verification_failed", "Original target remains as a selectable PDF text line.");
      }
      if (mode === "replace_exact" &&
          visibleLines.filter(line=>normalizeLine(line)===normalizeLine(replacement as string)).length!==1) {
        deny("verification_failed", "Replacement not extractable as exactly one text line.");
      }
      if (mode === "redact_exact") {
        // Conservative additional check for uncompressed plaintext or hex
        // leftovers outside the content stream; this is not an all-encoding proof.
        const asLatin1 = bytes.toString("latin1");
        const oldText = target as string;
        if (asLatin1.includes(oldText) || asLatin1.toLowerCase().includes(Buffer.from(oldText, "ascii").toString("hex"))) {
          deny("verification_failed", "Sensitive ASCII bytes still appear in saved PDF; refusing publication.");
        }
      }
    } finally { await parser.destroy(); }
    if (fitBounds) {
      const approved = result.verificationScopes &&
        (result.verificationScopes as Record<string, unknown>).approvedFitBounds;
      if (!Array.isArray(approved) || approved.length !== 4 ||
          approved.some((value,idx) => typeof value !== "number" ||
             Math.abs(value - [fitBounds.x0,fitBounds.y0,fitBounds.x1,fitBounds.y1][idx]) > 0.001)) {
        deny("verification_failed", "Python backend did not certify the exact approved fit bounds.");
      }
      const sourceRenderer = new PDFParse({data:Uint8Array.from(input.bytes)});
      const outputRenderer = new PDFParse({data:Uint8Array.from(bytes)});
      try {
        const [before, after] = await Promise.all([
          sourceRenderer.getScreenshot({partial:[args.page as number],scale:1,imageBuffer:true,imageDataUrl:false}),
          outputRenderer.getScreenshot({partial:[args.page as number],scale:1,imageBuffer:true,imageDataUrl:false}),
        ]);
        const a=before.pages[0], b=after.pages[0];
        if (!a?.data || !b?.data || a.width!==b.width || a.height!==b.height ||
            a.width*a.height > 12_000_000) {
          deny("verification_failed", "Cannot verify pixel parity outside the approved fit region.");
        }
        const [imgA,imgB]=await Promise.all([loadImage(Buffer.from(a.data)),loadImage(Buffer.from(b.data))]);
        const cA=createCanvas(a.width,a.height), cB=createCanvas(b.width,b.height);
        const ctxA=cA.getContext("2d"), ctxB=cB.getContext("2d");
        ctxA.drawImage(imgA,0,0);ctxB.drawImage(imgB,0,0);
        const pa=ctxA.getImageData(0,0,a.width,a.height).data;
        const pb=ctxB.getImageData(0,0,b.width,b.height).data;
        const left=Math.floor(fitBounds.x0)-2,right=Math.ceil(fitBounds.x1)+2;
        const top=Math.floor(a.height-fitBounds.y1)-2,bottom=Math.ceil(a.height-fitBounds.y0)+2;
        for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
          if(x>=left && x<=right && y>=top && y<=bottom)continue;
          const i=(y*a.width+x)*4;
          if(Math.abs(pa[i]-pb[i])>2 || Math.abs(pa[i+1]-pb[i+1])>2 ||
             Math.abs(pa[i+2]-pb[i+2])>2 || Math.abs(pa[i+3]-pb[i+3])>2){
            deny("verification_failed", "Edited PDF changed rendered pixels outside approved fitBounds.");
          }
        }
      } finally {
        await sourceRenderer.destroy().catch(()=>undefined);
        await outputRenderer.destroy().catch(()=>undefined);
      }
    }
    if (signal?.aborted) deny("cancelled", "Operation cancelled before publication.");
    if (hash(await fs.readFile(input.file)) !== input.sha256) deny("hash_mismatch", "Original PDF changed during transformation.");
    const sha256 = await publish(output, bytes, signal);
    return {
      status: "verified", mode, inputPath: input.file, outputPath: output,
      inputSha256: input.sha256, outputSha256: sha256, pageCount: sourceDoc.getPageCount(),
      vectorGraphicsPreserved: Boolean(result.vectorGraphicsPreserved),
      originalBoundingBox: result.originalBoundingBox,
      verificationScopes: result.verificationScopes,
      warnings: result.warnings,
    };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
