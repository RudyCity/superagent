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
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-vector-"));
  await fs.chmod(stageDir, 0o700).catch(() => undefined);
  try {
    const stagingPath = path.join(stageDir, "edited.pdf");
    const result = await runPython({
      mode, fontPolicy, page: args.page, inputPath: input.file, stagingPath,
      targetText: target, replacementText: replacement, expectedInputSha256: input.sha256,
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
      if (content.includes(target as string)) deny("verification_failed", "Original target remains in selectable PDF text.");
      if (mode === "replace_exact" && !content.includes(replacement as string)) deny("verification_failed", "Replacement not extractable.");
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
