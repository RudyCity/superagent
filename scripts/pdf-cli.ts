#!/usr/bin/env bun
/**
 * Local PDF CLI. Run from the authorized project directory:
 *   bun scripts/pdf-cli.ts inspect docs/input.pdf
 *   bun scripts/pdf-cli.ts extract docs/input.pdf 1,3
 *   bun scripts/pdf-cli.ts render docs/input.pdf docs/preview 1,2
 *   bun scripts/pdf-cli.ts edit docs/operation.json
 *   bun scripts/pdf-cli.ts split docs/operation.json
 *   bun scripts/pdf-cli.ts verify docs/input.pdf
 *
 * edit/split JSON contains the same declarative arguments as pdf_edit/pdf_split.
 * This CLI is not a replacement for the authenticated primary MCP authorization path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  inspectPdf, extractPdf, renderPdf, editPdf, splitPdf, verifyPdf, redactPdfRaster, PdfOperationError,
} from "../src/core/pdf/pdfEngine.js";
import { editPdfVectorExact } from "../src/core/pdf/pdfVector.js";
import { signPdf, verifyPdfSignature } from "../src/core/pdf/pdfSigning.js";
import { ocrPdfPretrained } from "../src/core/pdf/pdfOcrAdvanced.js";
import { createSearchablePdf } from "../src/core/pdf/pdfSearchable.js";

const cmd = process.argv[2];
const values = process.argv.slice(3);
const root = process.cwd();
const pages = (value?: string) => value
  ? value.split(",").map(v => Number(v.trim()))
  : undefined;

async function main() {
  let args: Record<string, unknown>;
  let run: (a: Record<string, unknown>, cwd: string) => Promise<unknown>;
  switch (cmd) {
    case "inspect":
      args = { inputPath: values[0] }; run = inspectPdf; break;
    case "extract":
      args = { inputPath: values[0], pages: pages(values[1]) }; run = extractPdf; break;
    case "render":
      args = { inputPath: values[0], outputPrefix: values[1], pages: pages(values[2]), scale: values[3] ? Number(values[3]) : undefined }; run = renderPdf; break;
    case "verify":
      args = { inputPath: values[0], expectedSha256: values[1] }; run = verifyPdf; break;
    case "verify-signature":
      args = { inputPath: values[0], verifyTrustedChain: values[1] === "operator-ca" };
      run = verifyPdfSignature; break;
    case "ocr":
      args = { inputPath: values[0], engine: values[1] || "auto", language: values[2] || "auto", pages: pages(values[3]) };
      run = ocrPdfPretrained; break;
    case "edit":
    case "split":
    case "redact":
    case "vector":
    case "sign":
    case "searchable": {
      if (!values[0]) throw new PdfOperationError("invalid_input", "JSON operation file required.");
      const spec = path.resolve(root, values[0]);
      const rel = path.relative(root, spec);
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
        throw new PdfOperationError("path_denied", "JSON spec must stay inside current workspace.");
      }
      const real = await fs.realpath(spec);
      if (real !== spec && (path.relative(root, real).startsWith("..") || path.isAbsolute(path.relative(root, real)))) {
        throw new PdfOperationError("path_denied", "JSON spec symlink leaves workspace.");
      }
      const content = await fs.readFile(real, "utf-8");
      if (content.length > 1_000_000) throw new PdfOperationError("size_limit", "JSON spec must be under 1 MB.");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PdfOperationError("invalid_input", "JSON spec must be an object.");
      }
      args = parsed;
      run = cmd === "edit" ? editPdf
        : cmd === "split" ? splitPdf
        : cmd === "redact" ? redactPdfRaster
        : cmd === "vector" ? editPdfVectorExact
        : cmd === "searchable" ? createSearchablePdf : signPdf;
      break;
    }
    default:
      throw new PdfOperationError("usage", "Usage: bun scripts/pdf-cli.ts inspect|extract|render|ocr|verify|verify-signature|edit|split|redact|vector|sign|searchable ...");
  }
  const result = await run(args, root);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
main().catch(err => {
  process.stderr.write(JSON.stringify({
    status: "failed", code: err instanceof PdfOperationError ? err.code : "cli_error",
    message: String((err as Error).message || err).slice(0, 350),
  }) + "\n");
  process.exitCode = 1;
});
