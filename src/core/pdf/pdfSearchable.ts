/**
 * Searchable PDF export for image-only pages, using offline pretrained OCR.
 * Creates NEW document; originals, images and all visible page content retained.
 * Hidden text is additive and must NEVER be mistaken for true redaction/editing.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ocrPdfPretrained } from "./pdfOcrAdvanced.js";
import {
  PdfOperationError, bytesFromPdf, hash, isSigned, outputPath,
  pdfDoc, publish, rootDir,
} from "./pdfEngine.js";

type Line = { text: string; quad: number[][]; confidence: number };
const UNICODE_FONT_PATH = path.join(os.homedir(), ".superagent-r", "models", "pdf-ocr-v6", "fonts", "NotoSans-Regular.ttf");
const LOCK_FILE = fileURLToPath(new URL("../../../scripts/pdf-ocr-v6-lock.json", import.meta.url));
type GlyphVerifier = { hasGlyphForCodePoint(codePoint: number): boolean };
const pinnedGlyphsByDocument = new WeakMap<PDFDocument, GlyphVerifier>();
export async function loadVerifiedUnicodeOcrFont(doc: PDFDocument, text: string): Promise<PDFFont> {
  const pin = JSON.parse(await fs.readFile(LOCK_FILE, "utf8"))?.fonts?.noto_sans_regular;
  if (!pin || typeof pin.sha256 !== "string" || !Number.isSafeInteger(pin.bytes)) {
    deny("ocr_font_unavailable", "A pinned Unicode OCR font definition must be installed.");
  }
  const stat = await fs.lstat(UNICODE_FONT_PATH).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes) {
    deny("ocr_font_unavailable", "A private, pinned Unicode font is required. Provision the OCR font explicitly.");
  }
  const fontBytes = await fs.readFile(UNICODE_FONT_PATH);
  if (hash(fontBytes) !== pin.sha256) {
    deny("ocr_font_invalid", "Pinned Unicode font SHA-256 mismatch; refusing to publish a searchable PDF.");
  }
  let face: GlyphVerifier;
  try {
    face = fontkit.create(fontBytes);
    for (const character of text) {
      if (!face.hasGlyphForCodePoint(character.codePointAt(0)!)) {
        deny("unsupported_unicode", "OCR text contains glyphs outside the provisioned Unicode font.");
      }
    }
  } catch (error) {
    if (error instanceof PdfOperationError) throw error;
    deny("ocr_font_invalid", "Unicode font cannot be parsed safely.");
  }
  doc.registerFontkit(fontkit);
  try {
    // Keep the PDF compact. Independent PDF.js extraction is required
    // before publication and guards against broken ToUnicode mappings.
    const embedded = await doc.embedFont(fontBytes, { subset: true });
    pinnedGlyphsByDocument.set(doc, face);
    return embedded;
  } catch {
    deny("ocr_font_invalid", "Unable to safely embed the pinned Unicode OCR font.");
  }
}
type PageResult = { page: number; ocrPerformed: boolean; text: string;
  lines: Line[]; lineCount: number; imageWidth: number; imageHeight: number; backend?: string };
function deny(code: string, message: string): never { throw new PdfOperationError(code, message); }
async function bytesForPage(input: Uint8Array, page: number): Promise<Uint8Array> {
  const parser = new PDFParse({ data: Uint8Array.from(input) });
  try {
    const result = await parser.getScreenshot({
      partial: [page], scale: 1, imageBuffer: true, imageDataUrl: false,
    });
    const entry = result.pages[0];
    if (!entry?.data) deny("render_failed", "Cannot render page to verify visual preservation.");
    return entry.data;
  } finally { await parser.destroy(); }
}
async function samePixels(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const first = await loadImage(Buffer.from(a));
  const second = await loadImage(Buffer.from(b));
  if (first.width !== second.width || first.height !== second.height ||
      first.width * first.height > 12_000_000) return false;
  const canvasA = createCanvas(first.width, first.height);
  const canvasB = createCanvas(second.width, second.height);
  const ctxA = canvasA.getContext("2d");
  const ctxB = canvasB.getContext("2d");
  ctxA.drawImage(first, 0, 0);
  ctxB.drawImage(second, 0, 0);
  const x = ctxA.getImageData(0, 0, first.width, first.height).data;
  const y = ctxB.getImageData(0, 0, first.width, first.height).data;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i] - y[i]) > 1) return false;
  }
  return true;
}
function isValidQuad(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length === 4 &&
    value.every(p => Array.isArray(p) && p.length === 2 &&
      p.every(v => typeof v === "number" && Number.isFinite(v)));
}
export async function createSearchablePdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  if (typeof args.inputPath !== "string" || typeof args.outputPath !== "string") {
    deny("invalid_input", "inputPath and new outputPath are required.");
  }
  if (typeof args.expectedInputSha256 !== "string" || !/^[\da-f]{64}$/i.test(args.expectedInputSha256)) {
    deny("hash_required", "Require source SHA-256 obtained from pdf_inspect.");
  }
  const input = await bytesFromPdf(args.inputPath, root);
  if (input.sha256 !== args.expectedInputSha256.toLowerCase()) {
    deny("hash_mismatch", "Input PDF has changed since inspection.");
  }
  if (isSigned(input.bytes)) deny("signed_document", "Searchable OCR layers cannot be added to an existing signed document.");
  const target = await outputPath(args.outputPath, root);
  const result = await ocrPdfPretrained({
    inputPath: args.inputPath,
    expectedInputSha256: input.sha256,
    pages: args.pages,
    engine: args.engine,
    language: args.language,
    forceOcr: false,
    scale: 2,
    maxChars: 100000,
  }, cwd, signal);
  if (result.status !== "verified" || result.truncated) {
    deny("ocr_incomplete", "A scanned page was empty, incomplete or truncated; refuse to publish a partial searchable PDF.");
  }
  const newLayers = (result.pages as unknown as PageResult[]).filter(p => p.ocrPerformed);
  if (!newLayers.length) deny("not_scanned", "All selected pages already have selectable text; no hidden OCR layer added.");
  for (const p of newLayers) {
    if (!p.text?.trim() || !Array.isArray(p.lines) || !p.lines.length ||
        p.lines.length > 5000 || p.lines.some(line => !line.text?.trim() || !isValidQuad(line.quad))) {
      deny("ocr_incomplete", "Scanned page contains empty, malformed or incomplete OCR text/coordinates.");
    }
    if (!Number.isInteger(p.lineCount) || p.lineCount !== p.lines.length) {
      deny("ocr_incomplete", "OCR worker omitted bounding boxes for one or more recognized lines.");
    }
  }
  const doc = await pdfDoc(input.bytes);
  const standardFont = await doc.embedFont(StandardFonts.Helvetica);
  let unicodeFont: PDFFont | undefined;
  const unicodeText = new Set<string>();
  let insertedLines = 0;
  for (const pageData of newLayers) {
    const page = doc.getPage(pageData.page - 1);
    const crop = page.getCropBox();
    const pageW = page.getWidth(), pageH = page.getHeight();
    if (page.getRotation().angle !== 0 || crop.x !== 0 || crop.y !== 0 ||
        Math.abs(crop.width - pageW) > 0.001 || Math.abs(crop.height - pageH) > 0.001) {
      deny("unsupported_geometry", "Searchable OCR export currently supports unrotated, uncropped pages only.");
    }
    if (!Number.isFinite(pageData.imageWidth) || !Number.isFinite(pageData.imageHeight) ||
        pageData.imageWidth < 1 || pageData.imageHeight < 1) {
      deny("invalid_ocr_geometry", "Missing image geometry from OCR.");
    }
    for (const line of pageData.lines) {
      // No silent skipping: the complete OCR text and all its geometry must be
      // mapped or the output will not be published as searchable/verified.
      if (typeof line.text !== "string" || !line.text.trim() || !isValidQuad(line.quad)) {
        deny("ocr_incomplete", "An OCR line cannot be represented safely.");
      }
      const xs = line.quad.map(p => p[0]);
      const ys = line.quad.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const top = Math.min(...ys), bottom = Math.max(...ys);
      if (x0 < 0 || x1 > pageData.imageWidth + 1 || top < 0 || bottom > pageData.imageHeight + 1 ||
          bottom <= top || x1 <= x0) {
        deny("invalid_ocr_geometry", "OCR returned a line outside the original page.");
      }
      const x = (x0 / pageData.imageWidth) * pageW;
      const y = ((pageData.imageHeight - bottom) / pageData.imageHeight) * pageH;
      const boxW = ((x1 - x0) / pageData.imageWidth) * pageW;
      const boxH = ((bottom - top) / pageData.imageHeight) * pageH;
      let size = Math.min(80, Math.max(1, boxH * 0.9));
      let font = standardFont;
      try {
        standardFont.encodeText(line.text);
      } catch {
        if (!unicodeFont) unicodeFont = await loadVerifiedUnicodeOcrFont(doc, line.text);
        else {
          // Verify later strings against the SAME hash-verified face used
          // for embedding, not against mutable filesystem bytes.
          const face = pinnedGlyphsByDocument.get(doc);
          if (!face) deny("ocr_font_invalid", "Unicode font verifier has not been initialized.");
          for (const character of line.text) {
            if (!face.hasGlyphForCodePoint(character.codePointAt(0)!)) {
              deny("unsupported_unicode", "OCR text contains unsupported font glyphs.");
            }
          }
        }
        font = unicodeFont;
        unicodeText.add(line.text);
      }
      const actualW = font.widthOfTextAtSize(line.text, size);
      if (!Number.isFinite(actualW) || actualW <= 0) {
        deny("unsupported_unicode", "OCR text has invalid embedded-font geometry.");
      }
      size = Math.max(0.5, Math.min(size, (size * boxW) / actualW));
      try {
        page.drawText(line.text, { x, y, font, size, opacity: 0 });
      } catch {
        deny("unsupported_unicode", "Could not embed the exact OCR text without changing characters.");
      }
      insertedLines++;
    }
  }
  if (!insertedLines) deny("ocr_empty", "No valid OCR text was mapped onto the page.");
  if (signal?.aborted) deny("cancelled", "OCR export cancelled.");
  const outputBytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const outputDoc = await pdfDoc(outputBytes);
  if (outputDoc.getPageCount() !== (await pdfDoc(input.bytes)).getPageCount()) {
    deny("verification_failed", "Searchable PDF changed the original page count.");
  }
  // Independent selectable text extraction and exact-pixel source preservation.
  const parser = new PDFParse({ data: Uint8Array.from(outputBytes) });
  try {
    const extracted = await parser.getText({ partial: newLayers.map(p => p.page) });
    for (const p of newLayers) {
      const actual = extracted.pages.find(x => x.num === p.page)?.text || "";
      const expectedLines = p.lines.map(l => l.text?.trim()).filter(Boolean);
      if (!expectedLines.length || expectedLines.some(line => !actual.includes(line))) {
        deny("verification_failed", "At least one OCR line failed independent PDF text extraction.");
      }
    }
  } finally { await parser.destroy(); }
  for (const p of newLayers) {
    if (!await samePixels(await bytesForPage(input.bytes, p.page), await bytesForPage(outputBytes, p.page))) {
      deny("layout_mismatch", "OCR layer changed visible source image pixels; output refused.");
    }
  }
  if (hash(await fs.readFile(input.file)) !== input.sha256) deny("hash_mismatch", "Source changed while creating searchable PDF.");
  const outputSha256 = await publish(target, outputBytes, signal);
  return {
    status: "verified", inputSha256: input.sha256, outputSha256,
    outputPath: target, ocrEngine: result.backend, modelHashes: result.modelHashes,
    originalPageCount: doc.getPageCount(), newSearchablePages: newLayers.map(x => x.page),
    mappedTextLines: insertedLines,
    fontProvenance: unicodeText.size
      ? { standard14: true, unicode: "SIL OFL 1.1 Noto Sans; SHA-256 verified from local model lock", unicodeLines: unicodeText.size }
      : { standard14: true, unicode: null, unicodeLines: 0 },
    verificationScopes: {
      sourceUnmodified: true,
      originalVisiblePixels: "pixel_parity_verified_for_modified_pages",
      textLayerExtractable: true,
      signatures: "input_must_be_unsigned",
      pdfUaAccessibleText: "not_certified",
      textBoundingBoxExactness: "not_certified",
    },
    warning: "This adds hidden selectable OCR text; it is NOT editing existing text or privacy redaction. OCR accuracy and PDF/UA conformance require separate review.",
  };
}
