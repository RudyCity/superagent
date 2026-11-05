import type { Tool } from "./types.js";
import { readDocumentTool } from "./documentReadTools.js";

type Handler = (args: Record<string, unknown>, cwd: string, signal?: AbortSignal) => Promise<unknown>;
type EngineAction = "inspectPdf" | "extractPdf" | "renderPdf" | "editPdf" | "splitPdf" | "verifyPdf" | "redactPdfRaster";
const lazy = (action: EngineAction): Handler => async (args, cwd, signal) => {
  const engine = await import("../pdf/pdfEngine.js");
  return engine[action](args, cwd, signal);
};
function wrapped(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): Tool {
  return {
    name, description, parameters: { type: "object", properties, required, additionalProperties: false },
    async execute(args, cwd, signal) {
      try {
        const result = await handler(args, cwd, signal);
        return JSON.stringify(result);
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err && typeof err.code === "string"
          ? err.code : "pdf_operation_failed";
        return JSON.stringify({ status: "failed", code, message: String((err as Error)?.message || err).slice(0, 350) });
      }
    },
  };
}
const file = { type: "string", description: "PDF path inside the active authorized project root." };
const pages = { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, description: "1-based page numbers." };
const operation = {
  type: "object",
  required: ["op"],
  properties: {
    op: { type: "string", enum: [
      "rotate_pages", "delete_pages", "extract_pages", "reorder_pages",
      "merge_pdf", "insert_pdf", "crop_pages", "add_text", "watermark",
      "page_numbers", "add_rectangle", "highlight_overlay",
      "add_image", "set_metadata", "fill_form", "flatten_forms",
    ] },
    pages, sourcePath: file, atPage: { type: "integer" },
    degrees: { type: "integer", enum: [0, 90, 180, 270] },
    x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
    text: { type: "string" }, fontSize: { type: "number" }, color: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
    opacity: { type: "number" }, rotation: { type: "number" }, imagePath: file,
    fontPath: { type: "string", description: "Optional TTF/OTF font inside the authorized workspace, for Unicode text overlays." },
    field: { type: "string" }, value: { description: "Form field value: string for text/choice, boolean for checkbox, or listed string[] for option lists. Unsupported XFA/signatures/read-only values fail closed." },
    title: { type: "string" }, author: { type: "string" }, subject: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};
export const pdfInspectTool = wrapped(
  "pdf_inspect", "Read PDF page dimensions/rotation, metadata, AcroForm field names/types/readonly/required flags and bounded allowed choices, plus conservative signature state. Read-only.",
  { inputPath: file }, ["inputPath"], lazy("inspectPdf"),
);
export const pdfExtractTool = wrapped(
  "pdf_extract", "Extract selectable PDF text from selected 1-based pages. For scanned PDFs use read_document's conditional OCR fallback.",
  { inputPath: file, pages, maxChars: { type: "integer", minimum: 1, maximum: 200000 } },
  ["inputPath"], lazy("extractPdf"),
);
export const pdfOcrTool = wrapped(
  "pdf_ocr",
  "Read native text pages or perform ACTUAL offline pretrained PP-OCRv6 (tiny/small/medium via pinned RapidOCR ONNX) or local Tesseract eng+ind on scanned pages. Returns original 1-based page, text, image-coordinate boxes, exact engine/model hashes, runtime/RSS metrics and truthful OCR provenance. No model training, network upload or automatic download. Missing models fail closed; legacy fallback only by explicit request.",
  {
    inputPath: file,
    pages,
    engine: { type: "string", enum: ["auto", "tiny", "small", "medium", "tesseract", "legacy"], description: "auto: provisioned small then tiny then Tesseract; legacy: old read_document fallback for compatibility only." },
    language: { type: "string", enum: ["auto", "id", "en"] },
    forceOcr: { type: "boolean", description: "Run neural OCR even when PDF has selectable text." },
    scale: { type: "number", minimum: 1, maximum: 2.5 },
    expectedInputSha256: { type: "string" },
    maxChars: { type: "integer", minimum: 1, maximum: 100000 },
  },
  ["inputPath"],
  async (args, cwd, signal) => {
    if (args.engine !== "legacy") {
      return (await import("../pdf/pdfOcrAdvanced.js")).ocrPdfPretrained(args, cwd, signal);
    }
    const info = await (await import("../pdf/pdfEngine.js")).inspectPdf(args, cwd, signal);
    const raw = await readDocumentTool.execute({ filePath: info.inputPath }, cwd, signal);
    if (raw.startsWith("Error:")) return { status: "failed", code: "ocr_read_failed", message: raw.slice(0, 350) };
    const missing = raw.includes("No text content found");
    const backend = raw.includes("via OCR Engine") ? "local_ocr_fallback" : "pdf-parse";
    const maxChars = Math.min(100000, Math.max(1, typeof args.maxChars === "number" && Number.isFinite(args.maxChars) ? Math.floor(args.maxChars) : 30000));
    return {
      status: missing ? "unsupported" : "partial",
      backend: missing ? "none" : backend,
      ocrPerformed: backend === "local_ocr_fallback",
      text: missing ? "" : raw.slice(0, maxChars),
      truncated: raw.length > maxChars,
      inputSha256: info.sha256,
      warning: "Legacy OCR read_document fallback requested; backend accuracy, language, and layout require independent verification.",
    };
  },
);
export const pdfOcrSearchableTool = wrapped(
  "pdf_ocr_searchable",
  "Create a NEW searchable scanned PDF with an invisible selectable text layer generated by offline pretrained RapidOCR (tiny/small/medium) or Tesseract eng+ind. Requires write permission, exact inspected source SHA-256, no existing signatures, strict image-pixel parity and independent extracted-text verification. This is NOT privacy redaction or original text replacement.",
  {
    inputPath: file,
    outputPath: { type: "string", description: "New PDF output path inside authorized project; never overwrites input." },
    expectedInputSha256: { type: "string", description: "64-character SHA-256 from pdf_inspect." },
    pages,
    engine: { type: "string", enum: ["auto", "tiny", "small", "medium", "tesseract"] },
    language: { type: "string", enum: ["auto", "id", "en"] },
  },
  ["inputPath", "outputPath", "expectedInputSha256"],
  async (args, cwd, signal) => (await import("../pdf/pdfSearchable.js")).createSearchablePdf(args, cwd, signal),
);
export const pdfRenderTool = wrapped(
  "pdf_render", "Render 1-20 PDF pages into new PNG files inside the workspace; creates files. Never overwrites.",
  { inputPath: file, pages, outputPrefix: { type: "string" }, scale: { type: "number", minimum: 0.5, maximum: 2.5 } },
  ["inputPath", "outputPrefix"], lazy("renderPdf"),
);
export const pdfEditTool = wrapped(
  "pdf_edit", "Edit PDF pages, stamps/overlays/images, metadata and AcroForms. Creates a new verified PDF; never modifies input or overwrites output. 1-based page numbers. NOT secure redaction or original text replacement. Requires write permission.",
  {
    inputPath: file, outputPath: { type: "string", description: "Required new PDF path inside authorized project." },
    expectedInputSha256: { type: "string", description: "Optional optimistic source hash from pdf_inspect." },
    dryRun: { type: "boolean" },
    operations: { type: "array", minItems: 1, maxItems: 100, items: operation },
  },
  ["inputPath", "outputPath", "operations"], lazy("editPdf"),
);
export const pdfSplitTool = wrapped(
  "pdf_split", "Create up to 20 separate PDFs from explicit groups of 1-based page numbers. Does not overwrite input.",
  { inputPath: file, outputPrefix: { type: "string" }, groups: { type: "array", minItems: 1, maxItems: 20, items: pages } },
  ["inputPath", "outputPrefix", "groups"], lazy("splitPdf"),
);
export const pdfRedactRasterTool = wrapped(
  "pdf_redact_raster",
  "IRREVERSIBLE image-only raster redaction. Reconstructs ALL pages, removes original PDF text/links/forms/metadata and blackens operator-reviewed rectangles. Requires explicit destructive confirmation, exact source SHA-256 AND SHA-256 of EVERY reviewed page preview at scale=1 from pdf_render. Refuses if any preview differs. No claim that all sensitive content was identified.",
  {
    inputPath: file,
    outputPath: { type: "string" },
    expectedInputSha256: { type: "string" },
    confirmDestructiveRasterization: { type: "boolean" },
    expectedPreviewHashes: { type: "object", description: "REQUIRED: all page-number-to-SHA256 preview PNG hashes from pdf_render at scale=1, reviewed before redaction.", additionalProperties: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    regions: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object", required: ["page", "x", "y", "width", "height"],
      properties: { page: { type: "integer", minimum: 1 }, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } },
    } },
  },
  ["inputPath", "outputPath", "expectedInputSha256", "expectedPreviewHashes", "confirmDestructiveRasterization", "regions"], lazy("redactPdfRaster"),
);
export const pdfEditVectorExactTool = wrapped(
  "pdf_edit_vector_exact",
  "CONSTRAINED exact original PDF text edit, not a general layout/reflow engine. Default standard14 policy permits one unique ASCII Tj, bounded fragmented TJ, or strictly consecutive multi-Tj sequence in one BT object; any intervening layout/state operator fails closed. Optional fontPolicy=embedded_subset allows replacement ONLY of one uniquely mapped Type0/Identity-H Latin ID/EN Unicode Tj or bounded fragmented TJ run using already-present embedded subset glyphs; missing glyphs, excessive kerning, overflow, complex mappings and embedded-font redaction fail closed. Never claim full-document sanitization.",
  {
    inputPath: file, outputPath: { type: "string" }, page: { type: "integer", minimum: 1, maximum: 500 },
    expectedInputSha256: { type: "string" },
    mode: { type: "string", enum: ["replace_exact", "redact_exact"] },
    fontPolicy: { type: "string", enum: ["standard14", "embedded_subset"], description: "Explicit opt-in for embedded Type0 Identity-H CID Latin Unicode Tj or bounded fragmented TJ replacement using existing mapped glyphs only. Not for redaction or reflow." },
    targetText: { type: "string", maxLength: 200 },
    replacementText: { type: "string", maxLength: 200 },
    confirmRedact: { type: "boolean" },
  }, ["inputPath", "outputPath", "expectedInputSha256", "page", "mode", "targetText"],
  async (args, cwd, signal) => (await import("../pdf/pdfVector.js")).editPdfVectorExact(args, cwd, signal),
);
export const pdfSignTool = wrapped(
  "pdf_sign",
  "Sign a new PDF with an authorized local PKCS#12 certificate; uses host-only SUPERAGENT_PDF_P12_PASSWORD, explicit confirmSign, source SHA-256, and independent OpenSSL CMS verification. Does not establish certificate trust/revocation/qualified PAdES.",
  {
    inputPath: file, outputPath: { type: "string" }, certificatePath: { type: "string", description: "PKCS#12 .p12/.pfx inside authorized project; never pass private keys through tool text." },
    expectedInputSha256: { type: "string" }, expectedCertificateSha256: { type: "string" },
    confirmSign: { type: "boolean" }, signerName: { type: "string" }, location: { type: "string" }, reason: { type: "string" },
    passwordEnv: { type: "string", enum: ["SUPERAGENT_PDF_P12_PASSWORD"] },
  }, ["inputPath", "outputPath", "certificatePath", "expectedInputSha256", "confirmSign"],
  async (args, cwd, signal) => (await import("../pdf/pdfSigning.js")).signPdf(args, cwd, signal),
);
export const pdfVerifySignatureTool = wrapped(
  "pdf_verify_signature",
  "Verify PDF signatures locally. Default path validates one detached CMS/ByteRange with OpenSSL; optional verifyTrustedChain and verifyOfflineCrl use ONLY operator trust files. Optional verifyIndependentPades runs pinned pyHanko 0.38.1 offline over embedded signatures, explicit operator CA roots, embedded DSS revocation evidence, optional operator SUPERAGENT_PDF_OCSP_RESPONSE (DER), and RFC3161 timestamp tokens. It never fetches AIA/OCSP/CRL/TSA URLs. Full structural PAdES B-B/B-T/B-LT/B-LTA conformance is NOT certified.",
  {
    inputPath: file,
    verifyTrustedChain: { type: "boolean", description: "Check operator SUPERAGENT_PDF_CA_BUNDLE trust anchors, not tool-provided CA." },
    verifyOfflineCrl: { type: "boolean", description: "Offline only: requires SUPERAGENT_PDF_CA_BUNDLE and SUPERAGENT_PDF_CA_CRL_BUNDLE, both operator-configured. No network or prompt-supplied trust/CRL." },
    verifyIndependentPades: { type: "boolean", description: "Run pinned pyHanko offline validator using operator SUPERAGENT_PDF_CA_BUNDLE, optional SUPERAGENT_PDF_TSA_CA_BUNDLE, optional offline SUPERAGENT_PDF_OCSP_RESPONSE DER, plus embedded timestamp/revocation evidence. No network; not structural PAdES certification." },
  }, ["inputPath"],
  async (args, cwd, signal) => (await import("../pdf/pdfSigning.js")).verifyPdfSignature(args, cwd, signal),
);
export const pdfVerifyTool = wrapped(
  "pdf_verify", "Reopen PDF, verify structural readability, optional SHA-256 and page count, report verification scope.",
  { inputPath: file, expectedSha256: { type: "string" }, expectedPageCount: { type: "integer", minimum: 1 } },
  ["inputPath"], lazy("verifyPdf"),
);
