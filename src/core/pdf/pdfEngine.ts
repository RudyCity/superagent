/**
 * PDF operations for SuperAgent (local-first, create-only outputs).
 *
 * SECURITY: No implicit in-place edits, no shell commands, no PDF JS execution.
 * This module intentionally does NOT claim arbitrary content-stream text edits
 * or redaction: covering existing text is not deletion.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  PDFDocument, degrees, rgb, StandardFonts, PDFTextField, PDFCheckBox,
  PDFDropdown, PDFRadioGroup, PDFOptionList, PDFSignature, PDFName, PDFDict,
  PDFArray, PDFStream,
} from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fontkit from "@pdf-lib/fontkit";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_OPERATIONS = 100;
const MAX_RENDER_PAGES = 20;
const MAX_TEXT_CHARS = 12_000;

export class PdfOperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PdfOperationError";
  }
}
function failure(code: string, message: string): never { throw new PdfOperationError(code, message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure("invalid_input", "An object is required.");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) failure("invalid_input", label + " must be a nonempty string.");
  return value;
}
function finite(value: unknown, label: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    failure("invalid_input", label + " must be a finite number in range " + min + " .. " + max);
  }
  return value;
}
function integer(value: unknown, label: string, min = 1, max = MAX_PAGES): number {
  const n = finite(value, label, min, max);
  if (!Number.isInteger(n)) failure("invalid_input", label + " must be an integer.");
  return n;
}
function pageNumbers(value: unknown, count: number, label = "pages"): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAGES) failure("invalid_input", label + " must be a nonempty list.");
  return value.map((n, idx) => integer(n, label + "[" + idx + "]", 1, count));
}
function optionalPages(value: unknown, count: number): number[] {
  return value === undefined ? Array.from({ length: count }, (_, i) => i + 1) : pageNumbers(value, count);
}
function rgbColor(value: unknown, defaultColor = [0, 0, 0]): ReturnType<typeof rgb> {
  if (value === undefined) return rgb(defaultColor[0], defaultColor[1], defaultColor[2]);
  if (!Array.isArray(value) || value.length !== 3) failure("invalid_color", "color must be [r,g,b] in range 0..1.");
  return rgb(finite(value[0], "color[0]", 0, 1), finite(value[1], "color[1]", 0, 1), finite(value[2], "color[2]", 0, 1));
}
function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) failure("cancelled", "Operation cancelled before publication.");
}
function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
export async function rootDir(cwd: string): Promise<string> {
  return fs.realpath(cwd);
}
export async function inputPath(name: string, root: string): Promise<string> {
  const candidate = path.resolve(root, name);
  if (!isWithin(root, candidate)) failure("path_denied", "Input path leaves the active workspace.");
  let real: string;
  try { real = await fs.realpath(candidate); }
  catch { return failure("not_found", "Input file not found."); }
  if (!isWithin(root, real)) failure("path_denied", "Input symlink leaves the active workspace.");
  const stat = await fs.stat(real);
  if (!stat.isFile()) failure("invalid_input", "Input must be a regular file.");
  if (stat.size > MAX_INPUT_BYTES) failure("size_limit", "PDF exceeds 100 MiB.");
  return real;
}
export async function outputPath(name: string, root: string): Promise<string> {
  const target = path.resolve(root, name);
  if (!isWithin(root, target)) failure("path_denied", "Output path leaves the active workspace.");
  const dir = await fs.realpath(path.dirname(target)).catch(() => failure("path_denied", "Output directory must already exist."));
  if (!isWithin(root, dir)) failure("path_denied", "Output parent symlink leaves the workspace.");
  const output = path.join(dir, path.basename(target));
  try {
    await fs.lstat(output);
    failure("already_exists", "Output already exists; choose a new outputPath. In-place edits are unsupported.");
  } catch (err) {
    if (err instanceof PdfOperationError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return output;
}
export async function bytesFromPdf(name: string, root: string): Promise<{ file: string; bytes: Uint8Array; sha256: string }> {
  const file = await inputPath(name, root);
  const buffer = await fs.readFile(file);
  if (buffer.length < 8 || !buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    failure("invalid_pdf", "PDF magic bytes were not found.");
  }
  return { file, bytes: new Uint8Array(buffer), sha256: hash(buffer) };
}
export function hash(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
export function isSigned(bytes: Uint8Array): boolean {
  const src = Buffer.from(bytes).toString("latin1");
  // Conservative detection: do not mutate a signed PDF whose signature may be invalidated.
  return /\/ByteRange\s*\[/.test(src) || /\/Type\s*\/Sig\b/.test(src);
}
export async function pdfDoc(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    if (doc.getPageCount() > MAX_PAGES) failure("page_limit", "PDF exceeds 500 pages.");
    return doc;
  } catch (err) {
    if (err instanceof PdfOperationError) throw err;
    const msg = String((err as Error).message || err);
    failure(/encrypt|password/i.test(msg) ? "password_required" : "invalid_pdf", "Could not open PDF: " + msg.slice(0, 240));
  }
}
export async function publish(output: string, content: Uint8Array, signal?: AbortSignal): Promise<string> {
  assertActive(signal);
  const temp = path.join(path.dirname(output), "." + path.basename(output) + "." + crypto.randomUUID() + ".tmp");
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertActive(signal);
    // hard link gives atomic create-if-absent semantics; rename might silently overwrite on Windows.
    await fs.link(temp, output);
    return hash(content);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}
function fields(doc: PDFDocument): Array<Record<string, unknown>> {
  try {
    return doc.getForm().getFields().map(field => ({
      name: field.getName(), type: field.constructor.name,
      readOnly: field.isReadOnly(), required: field.isRequired(),
      ...((field instanceof PDFDropdown || field instanceof PDFRadioGroup || field instanceof PDFOptionList)
        ? { options: field.getOptions().slice(0, 100), optionsTruncated: field.getOptions().length > 100 }
        : {}),
      ...(field instanceof PDFTextField ? { maxLength: field.getMaxLength() ?? null } : {}),
    }));
  } catch { return []; }
}
function inspectLoaded(doc: PDFDocument, sha256: string, signed: boolean) {
  return {
    status: "verified" as const,
    sha256,
    pageCount: doc.getPageCount(),
    pages: doc.getPages().map((p, i) => ({
      page: i + 1, width: p.getWidth(), height: p.getHeight(),
      rotation: p.getRotation().angle, cropBox: p.getCropBox(),
    })),
    title: doc.getTitle() || null,
    author: doc.getAuthor() || null,
    subject: doc.getSubject() || null,
    keywords: doc.getKeywords() || null,
    forms: fields(doc),
    signed,
    editable: !signed,
    coordinateSystem: "PDF points, origin bottom-left; page numbers 1-based",
    verificationScopes: { pageStructure: "verified", textLayout: "not_read", signatures: "heuristic" },
  };
}
export async function inspectPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  assertActive(signal);
  const input = await bytesFromPdf(nonempty(args.inputPath, "inputPath"), root);
  const doc = await pdfDoc(input.bytes);
  return { ...inspectLoaded(doc, input.sha256, isSigned(input.bytes)), inputPath: input.file };
}
export async function extractPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  assertActive(signal);
  const input = await bytesFromPdf(nonempty(args.inputPath, "inputPath"), root);
  const doc = await pdfDoc(input.bytes);
  const pages = optionalPages(args.pages, doc.getPageCount());
  const parser = new PDFParse({ data: input.bytes });
  try {
    const result = await parser.getText({ partial: pages });
    assertActive(signal);
    const maxChars = integer(args.maxChars ?? 30_000, "maxChars", 1, 200_000);
    const full = result.text;
    const hasSelectableText = result.pages.some(p => Boolean(p.text.trim()));
    let pageCharsRemaining = maxChars;
    const limitedPages = result.pages.map(p => {
      const text = p.text.slice(0, pageCharsRemaining);
      pageCharsRemaining -= text.length;
      return { page: p.num, text, truncated: text.length !== p.text.length };
    });
    const truncated = full.length > maxChars || limitedPages.some(p => p.truncated);
    return {
      status: hasSelectableText && !truncated ? "verified" : "partial",
      text: full.slice(0, maxChars),
      totalChars: full.length, truncated,
      pages: limitedPages,
      inputSha256: input.sha256, verificationScopes: { extractedText: hasSelectableText ? "verified" : "empty", scannedTextOcr: "not_attempted" },
    };
  } finally { await parser.destroy(); }
}
export async function renderPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  const input = await bytesFromPdf(nonempty(args.inputPath, "inputPath"), root);
  const doc = await pdfDoc(input.bytes);
  const pages = optionalPages(args.pages, doc.getPageCount());
  if (pages.length > MAX_RENDER_PAGES) failure("page_limit", "Render no more than 20 pages per call.");
  const scale = finite(args.scale ?? 1, "scale", 0.5, 2.5);
  const prefix = nonempty(args.outputPrefix, "outputPrefix");
  const targets: string[] = [];
  for (const p of pages) targets.push(await outputPath(prefix + "-page-" + p + ".png", root));
  const parser = new PDFParse({ data: input.bytes });
  const results: Array<{ path: string; page: number; width: number; height: number; sha256: string }> = [];
  try {
    const shots = await parser.getScreenshot({ partial: pages, scale, imageBuffer: true, imageDataUrl: false });
    if (shots.pages.length !== pages.length) failure("render_failed", "Not all requested pages were rendered.");
    for (let idx = 0; idx < shots.pages.length; idx++) {
      assertActive(signal);
      const item = shots.pages[idx];
      const page = pages[idx];
      if (item.pageNumber !== page || !item.data || !item.data.length) failure("render_failed", "Missing screenshot for page " + page);
      const sha256 = await publish(targets[idx], item.data, signal);
      results.push({ path: targets[idx], page, width: item.width, height: item.height, sha256 });
    }
  } catch (error) {
    // Never delete another process's file: only rollback bytes with the expected hash.
    for (const item of results) {
      const existing = await fs.readFile(item.path).catch(() => null);
      if (existing && hash(existing) === item.sha256) await fs.unlink(item.path).catch(() => undefined);
    }
    throw error;
  } finally { await parser.destroy(); }
  return { status: "verified", inputSha256: input.sha256, images: results };
}
function operationPages(op: Record<string, unknown>, doc: PDFDocument): number[] {
  return optionalPages(op.pages, doc.getPageCount());
}
async function applyOperation(doc: PDFDocument, raw: unknown, root: string): Promise<PDFDocument> {
  const op = record(raw);
  const kind = nonempty(op.op, "op");
  if (kind === "replace_text" || kind === "redact") {
    failure("unsupported_exact_edit", "Covering text does not delete it. Arbitrary text replacement and secure redaction need a validated content-removal engine.");
  }
  if (kind === "rotate_pages") {
    const angle = integer(op.degrees, "degrees", 0, 359);
    if (![0, 90, 180, 270].includes(angle)) failure("invalid_rotation", "Rotation must be 0, 90, 180, or 270 degrees.");
    for (const page of operationPages(op, doc)) doc.getPage(page - 1).setRotation(degrees(angle));
  } else if (kind === "delete_pages") {
    const pages = [...new Set(pageNumbers(op.pages, doc.getPageCount()))].sort((a, b) => b - a);
    if (pages.length >= doc.getPageCount()) failure("invalid_input", "Cannot delete every page.");
    for (const page of pages) doc.removePage(page - 1);
  } else if (kind === "extract_pages" || kind === "reorder_pages") {
    const pages = pageNumbers(op.pages, doc.getPageCount());
    if (kind === "reorder_pages" && (pages.length !== doc.getPageCount() || new Set(pages).size !== pages.length)) {
      failure("invalid_input", "reorder_pages requires every original page exactly once.");
    }
    if (fields(doc).length) failure("unsupported_form_preservation", "Page copying of PDFs with form fields is blocked to prevent field loss.");
    const result = await PDFDocument.create();
    const copies = await result.copyPages(doc, pages.map(p => p - 1));
    copies.forEach(copy => result.addPage(copy));
    return result;
  } else if (kind === "merge_pdf" || kind === "insert_pdf") {
    const source = await bytesFromPdf(nonempty(op.sourcePath, "sourcePath"), root);
    const other = await pdfDoc(source.bytes);
    if (isSigned(source.bytes)) failure("signed_document", "Copying pages from signed PDFs would invalidate the signature.");
    if (fields(other).length) failure("unsupported_form_preservation", "Merging PDFs with forms requires field-renaming support.");
    if (fields(doc).length) failure("unsupported_form_preservation", "Cannot merge into a PDF containing forms with current backend.");
    const selected = optionalPages(op.pages, other.getPageCount());
    if (doc.getPageCount() + selected.length > MAX_PAGES) failure("page_limit", "Result exceeds 500 pages.");
    const copies = await doc.copyPages(other, selected.map(p => p - 1));
    if (kind === "merge_pdf") copies.forEach(p => doc.addPage(p));
    else {
      let at = integer(op.atPage, "atPage", 1, doc.getPageCount() + 1) - 1;
      for (const p of copies) doc.insertPage(at++, p);
    }
  } else if (kind === "crop_pages") {
    const x = finite(op.x ?? 0, "x", 0), y = finite(op.y ?? 0, "y", 0);
    const width = finite(op.width, "width", 1), height = finite(op.height, "height", 1);
    for (const num of operationPages(op, doc)) {
      const page = doc.getPage(num - 1);
      if (x + width > page.getWidth() || y + height > page.getHeight()) failure("invalid_crop", "Crop box outside page boundary.");
      page.setCropBox(x, y, width, height);
    }
  } else if (kind === "add_text" || kind === "watermark" || kind === "page_numbers") {
    let font;
    if (op.fontPath !== undefined) {
      const fontPath = await inputPath(nonempty(op.fontPath, "fontPath"), root);
      if (!/\.(?:ttf|otf)$/i.test(fontPath)) failure("invalid_font", "fontPath must reference a local TTF or OTF file.");
      const fontData = await fs.readFile(fontPath);
      if (fontData.length > 10 * 1024 * 1024) failure("size_limit", "Font file exceeds 10 MiB.");
      try {
        doc.registerFontkit(fontkit);
        font = await doc.embedFont(fontData, { subset: true });
      } catch (error) {
        failure("unsupported_font", "Unable to embed the authorized font file: " + String((error as Error).message).slice(0, 140));
      }
    } else {
      font = await doc.embedFont(StandardFonts.Helvetica);
    }
    const size = finite(op.fontSize ?? (kind === "watermark" ? 40 : 12), "fontSize", 1, 200);
    const opacity = finite(op.opacity ?? (kind === "watermark" ? 0.22 : 1), "opacity", 0, 1);
    const color = rgbColor(op.color, kind === "watermark" ? [0.5, 0.5, 0.5] : [0, 0, 0]);
    const rotation = finite(op.rotation ?? (kind === "watermark" ? 35 : 0), "rotation", -180, 180);
    const text = kind === "page_numbers" ? "" : nonempty(op.text, "text");
    if (text.length > MAX_TEXT_CHARS) failure("size_limit", "Text overlay exceeds 12,000 characters.");
    for (const num of operationPages(op, doc)) {
      const page = doc.getPage(num - 1);
      const out = kind === "page_numbers" ? String(num) : text;
      let x = finite(op.x ?? 30, "x", 0), y = finite(op.y ?? 30, "y", 0);
      if (kind === "watermark") { x = page.getWidth() * 0.23; y = page.getHeight() * 0.5; }
      try { page.drawText(out, { x, y, size, font, color, opacity, rotate: degrees(rotation) }); }
      catch (err) { failure("unsupported_font", "Text cannot be encoded with the selected font; supply fontPath for Unicode: " + String((err as Error).message).slice(0, 140)); }
    }
  } else if (kind === "add_rectangle" || kind === "highlight_overlay") {
    const x = finite(op.x, "x", 0), y = finite(op.y, "y", 0);
    const width = finite(op.width, "width", 0.1), height = finite(op.height, "height", 0.1);
    const opacity = finite(op.opacity ?? (kind === "highlight_overlay" ? 0.3 : 1), "opacity", 0, 1);
    const color = rgbColor(op.color, kind === "highlight_overlay" ? [1, 0.95, 0] : [1, 1, 1]);
    for (const num of operationPages(op, doc)) {
      const pg = doc.getPage(num - 1);
      if (x + width > pg.getWidth() || y + height > pg.getHeight()) failure("invalid_rectangle", "Rectangle outside page boundary.");
      pg.drawRectangle({ x, y, width, height, color, opacity });
    }
  } else if (kind === "add_image") {
    const p = await inputPath(nonempty(op.imagePath, "imagePath"), root);
    const image = await fs.readFile(p);
    if (image.length > 20 * 1024 * 1024) failure("size_limit", "Image exceeds 20 MiB.");
    let embedded;
    const ext = path.extname(p).toLowerCase();
    if (ext === ".png") embedded = await doc.embedPng(image);
    else if (ext === ".jpg" || ext === ".jpeg") embedded = await doc.embedJpg(image);
    else failure("invalid_image", "Only PNG/JPEG images are supported.");
    const x = finite(op.x, "x", 0), y = finite(op.y, "y", 0);
    const width = finite(op.width ?? embedded.width, "width", 1), height = finite(op.height ?? embedded.height, "height", 1);
    for (const num of operationPages(op, doc)) {
      const pg = doc.getPage(num - 1);
      if (x + width > pg.getWidth() || y + height > pg.getHeight()) failure("invalid_rectangle", "Image outside page boundary.");
      pg.drawImage(embedded, { x, y, width, height, opacity: finite(op.opacity ?? 1, "opacity", 0, 1) });
    }
  } else if (kind === "set_metadata") {
    if (op.title !== undefined) doc.setTitle(String(op.title).slice(0, 500));
    if (op.author !== undefined) doc.setAuthor(String(op.author).slice(0, 500));
    if (op.subject !== undefined) doc.setSubject(String(op.subject).slice(0, 500));
    if (op.keywords !== undefined) {
      if (!Array.isArray(op.keywords) || op.keywords.some(k => typeof k !== "string")) failure("invalid_input", "keywords must be string[].");
      doc.setKeywords((op.keywords as string[]).slice(0, 30));
    }
  } else if (kind === "fill_form") {
    const fieldName = nonempty(op.field, "field");
    if (fieldName.length > 255) failure("invalid_input", "Form field name exceeds 255 characters.");
    const dict = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")));
    if (dict instanceof PDFDict && dict.has(PDFName.of("XFA"))) {
      failure("unsupported_xfa", "XFA forms require a separate, XFA-aware engine; no mutation published.");
    }
    const value = op.value;
    let field;
    try { field = doc.getForm().getField(fieldName); }
    catch { return failure("field_not_found", "The requested form field was not found."); }
    if (field.isReadOnly()) failure("form_readonly", "Cannot modify a read-only PDF form field.");
    if (field instanceof PDFSignature) failure("unsupported_signature", "A signature field cannot be filled as a regular form.");
    if (field instanceof PDFTextField) {
      if (typeof value !== "string" || value.length > MAX_TEXT_CHARS) {
        failure("invalid_form_value", "A text field requires a string no longer than 12000 characters.");
      }
      if (field.isRequired() && !value.trim()) failure("invalid_form_value", "A required text field cannot be empty.");
      field.setText(value);
    } else if (field instanceof PDFCheckBox) {
      if (typeof value !== "boolean") failure("invalid_form_value", "Checkbox requires a boolean true or false.");
      value ? field.check() : field.uncheck();
    } else if (field instanceof PDFDropdown || field instanceof PDFRadioGroup) {
      if (typeof value !== "string" || value.length > 255 || !field.getOptions().includes(value)) {
        failure("invalid_form_value", "Select a listed value of this PDF form field.");
      }
      field.select(value);
    } else if (field instanceof PDFOptionList) {
      if ((typeof value !== "string" && !Array.isArray(value)) ||
          (Array.isArray(value) && (value.length < 1 || value.length > 40 ||
            value.some(v => typeof v !== "string"))) ||
          (typeof value === "string" ? !field.getOptions().includes(value) :
            (value as string[]).some(v => !field.getOptions().includes(v)))) {
        failure("invalid_form_value", "An option list requires one or more listed string choices.");
      }
      field.select(value as string | string[]);
    } else {
      failure("unsupported_form", "Unsupported form field type.");
    }
  } else if (kind === "flatten_forms") {
    const dict = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")));
    if (dict instanceof PDFDict && dict.has(PDFName.of("XFA"))) {
      failure("unsupported_xfa", "Dynamic XFA forms cannot be safely flattened by pdf-lib.");
    }
    if (doc.getForm().getFields().some(f => f instanceof PDFSignature)) {
      failure("unsupported_signature", "Flattening a PDF with a signature field requires a signature-aware engine.");
    }
    try { doc.getForm().flatten(); }
    catch { failure("unsupported_form", "Could not safely flatten the PDF form."); }
  } else {
    failure("unsupported_operation", "Unknown PDF operation: " + kind);
  }
  return doc;
}
export async function editPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  const input = await bytesFromPdf(nonempty(args.inputPath, "inputPath"), root);
  if (isSigned(input.bytes)) failure("signed_document", "Signed PDFs cannot be edited; edits would invalidate signatures.");
  const expected = args.expectedInputSha256;
  if (expected !== undefined && String(expected).toLowerCase() !== input.sha256) {
    failure("hash_mismatch", "Source SHA-256 does not match expectedInputSha256.");
  }
  const output = await outputPath(nonempty(args.outputPath, "outputPath"), root);
  if (input.file === output) failure("path_denied", "In-place edits are not allowed.");
  if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > MAX_OPERATIONS) {
    failure("invalid_input", "operations must contain 1..100 typed PDF operations.");
  }
  let doc = await pdfDoc(input.bytes);
  const beforePages = doc.getPageCount();
  const ops: string[] = [];
  const expectedFields = new Map<string, { kind: "text" | "checkbox" | "choice" | "options"; value: string | boolean | string[] }>();
  let flattenRequested = false;
  for (const raw of args.operations) {
    assertActive(signal);
    const op = record(raw);
    doc = await applyOperation(doc, op, root);
    if (op.op === "fill_form") {
      const fieldName = String(op.field);
      const field = doc.getForm().getField(fieldName);
      if (field instanceof PDFTextField) {
        expectedFields.set(fieldName, { kind: "text", value: field.getText() ?? "" });
      } else if (field instanceof PDFCheckBox) {
        expectedFields.set(fieldName, { kind: "checkbox", value: field.isChecked() });
      } else if (field instanceof PDFDropdown) {
        expectedFields.set(fieldName, { kind: "options", value: field.getSelected() });
      } else if (field instanceof PDFRadioGroup) {
        expectedFields.set(fieldName, { kind: "choice", value: field.getSelected() ?? "" });
      } else if (field instanceof PDFOptionList) {
        expectedFields.set(fieldName, { kind: "options", value: field.getSelected() });
      }
    } else if (op.op === "flatten_forms") {
      flattenRequested = true;
    }
    ops.push(String(op.op));
    if (doc.getPageCount() > MAX_PAGES) failure("page_limit", "Output exceeds 500 pages.");
  }
  if (args.dryRun === true) return { status: "preview", inputSha256: input.sha256, inputPageCount: beforePages, outputPageCount: doc.getPageCount(), operations: ops, outputWritten: false };
  const fresh = await fs.readFile(input.file);
  if (hash(fresh) !== input.sha256) failure("hash_mismatch", "Source changed during editing; no PDF published.");
  assertActive(signal);
  const result = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  const checked = await pdfDoc(result);
  let formVerification = "not_applicable";
  if (expectedFields.size > 0 || flattenRequested) {
    if (flattenRequested) {
      if (checked.getForm().getFields().length > 0) {
        failure("form_verification_failed", "Flattened PDF still contains interactive form fields.");
      }
      // Text values must be recoverable in a separate PDF.js extraction
      // before claiming that the flattened form was saved successfully.
      const textValues = [...expectedFields.values()]
        .filter(f => f.kind === "text" && typeof f.value === "string" && f.value.trim())
        .map(f => f.value as string);
      if (textValues.length) {
        const parsed = new PDFParse({ data: Uint8Array.from(result) });
        try {
          const extracted = await parsed.getText();
          if (textValues.some(text => !extracted.text.includes(text))) {
            failure("form_verification_failed", "Flattened form text is not independently extractable.");
          }
        } finally { await parsed.destroy(); }
      }
      formVerification = "flattened_fields_removed_and_text_extracted; visual_choice_appearance_not_certified";
    } else {
      for (const [name, expected] of expectedFields) {
        let field;
        try { field = checked.getForm().getField(name); }
        catch { failure("form_verification_failed", "Edited form field was missing after save."); }
        const actual = field instanceof PDFTextField ? field.getText() ?? "" :
          field instanceof PDFCheckBox ? field.isChecked() :
          field instanceof PDFDropdown ? field.getSelected() :
          field instanceof PDFRadioGroup ? field.getSelected() ?? "" :
          field instanceof PDFOptionList ? field.getSelected() : null;
        if (JSON.stringify(actual) !== JSON.stringify(expected.value)) {
          failure("form_verification_failed", "A PDF form value changed during save/reopen.");
        }
      }
      formVerification = "all_modified_fields_reopened_and_verified";
    }
  }
  const outputSha256 = await publish(output, result, signal);
  return {
    status: "verified",
    inputPath: input.file, outputPath: output,
    inputSha256: input.sha256, outputSha256,
    inputPageCount: beforePages, outputPageCount: checked.getPageCount(),
    operations: ops, outputWritten: true,
    formVerification,
    warnings: ops.some(s => ["reorder_pages", "extract_pages"].includes(s)) ? ["Page copying can omit some interactive PDF structures. Inspect any bookmarks/links manually."] : [],
    verificationScopes: { pdfParse: "verified", pageStructure: "verified", visualLayout: "not_verified", originalContentStreams: "not_verified" },
  };
}
export async function verifyPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const inspected = await inspectPdf(args, cwd, signal);
  if (args.expectedSha256 && inspected.sha256 !== args.expectedSha256) {
    failure("hash_mismatch", "Output SHA-256 does not match expectedSha256.");
  }
  if (args.expectedPageCount !== undefined && inspected.pageCount !== integer(args.expectedPageCount, "expectedPageCount", 1, MAX_PAGES)) {
    failure("page_mismatch", "Output page count differs from expectedPageCount.");
  }
  return { ...inspected, hashMatches: args.expectedSha256 ? true : null };
}
export async function splitPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  const input = await bytesFromPdf(nonempty(args.inputPath, "inputPath"), root);
  if (isSigned(input.bytes)) failure("signed_document", "Splitting signed PDFs invalidates signatures.");
  const doc = await pdfDoc(input.bytes);
  if (fields(doc).length) failure("unsupported_form_preservation", "Splitting PDFs containing forms requires field preservation.");
  const groups = args.groups;
  if (!Array.isArray(groups) || !groups.length || groups.length > 20) failure("invalid_input", "groups must be 1..20 arrays of page numbers.");
  const prefix = nonempty(args.outputPrefix, "outputPrefix");
  const outputNames = groups.map((_, i) => prefix + "-part-" + (i + 1) + ".pdf");
  const outputs = await Promise.all(outputNames.map(n => outputPath(n, root)));
  const staged: Uint8Array[] = [];
  for (const group of groups) {
    const pages = pageNumbers(group, doc.getPageCount());
    const out = await PDFDocument.create();
    const copies = await out.copyPages(doc, pages.map(p => p - 1));
    copies.forEach(p => out.addPage(p));
    const bytes = await out.save({ useObjectStreams: false });
    await pdfDoc(bytes);
    staged.push(bytes);
  }
  const files: Array<{ path: string; sha256: string; pageCount: number }> = [];
  try {
    for (let i = 0; i < outputs.length; i++) {
      assertActive(signal);
      files.push({ path: outputs[i], sha256: await publish(outputs[i], staged[i], signal), pageCount: (groups[i] as unknown[]).length });
    }
  } catch (error) {
    for (const item of files) {
      const existing = await fs.readFile(item.path).catch(() => null);
      if (existing && hash(existing) === item.sha256) await fs.unlink(item.path).catch(() => undefined);
    }
    throw error;
  }
  return { status: "verified", inputSha256: input.sha256, files };
}

/**
 * Secure raster redaction fallback: strip ALL original PDF content streams and
 * interactive objects by producing a fresh image-only PDF from page screenshots.
 * This differs from vector-preserving redaction; it is intentionally destructive
 * to selectable text, links and forms, and requires explicit acknowledgment.
 *
 * Regions are integer screenshot PIXEL coordinates, origin TOP-LEFT, scale=1.
 * A previous pdf_render preview at scale=1 can provide exact coordinates.
 */
const FORENSIC_METADATA_LABEL = "SuperAgent secure raster redaction";
const FORBIDDEN_RASTER_CATALOG_KEYS = [
  "AcroForm", "Names", "OpenAction", "AA", "OCProperties", "Outlines",
  "StructTreeRoot", "Metadata", "PieceInfo", "Perms", "Collection", "AF",
] as const;
const FORBIDDEN_RASTER_OBJECT_KEYS = new Set([
  "JS", "EmbeddedFiles", "EF", "Filespec", "FileAttachment", "RichMedia",
  "OCG", "OCMD", "Metadata", "AF", "OpenAction",
]);
const FORBIDDEN_ACTION_TYPES = new Set([
  "JavaScript", "Launch", "GoToR", "SubmitForm", "ImportData",
  "Rendition", "RichMediaExecute", "URI",
]);
function sanitizeRasterMetadata(doc: PDFDocument): void {
  doc.setProducer(FORENSIC_METADATA_LABEL);
  doc.setCreator(FORENSIC_METADATA_LABEL);
  // Avoid leaking the source document's title/author/subject/keywords and avoid
  // adding a wall-clock redaction timestamp to an otherwise deterministic scrub.
  const scrubEpoch = new Date("1970-01-01T00:00:00.000Z");
  doc.setCreationDate(scrubEpoch);
  doc.setModificationDate(scrubEpoch);
}
function verifyRasterForensicStructure(bytes: Uint8Array, doc: PDFDocument) {
  const catalogForbidden = FORBIDDEN_RASTER_CATALOG_KEYS.filter(
    key => doc.catalog.has(PDFName.of(key)),
  );
  if (catalogForbidden.length) {
    failure("verification_failed", "Raster-redacted output retained forbidden catalog entries: " + catalogForbidden.join(", "));
  }
  if (doc.getTitle() || doc.getAuthor() || doc.getSubject() || doc.getKeywords()) {
    failure("verification_failed", "Raster-redacted output retained descriptive source metadata.");
  }
  if (doc.getProducer() !== FORENSIC_METADATA_LABEL || doc.getCreator() !== FORENSIC_METADATA_LABEL) {
    failure("verification_failed", "Raster-redacted output metadata was not reset to the scrubbed producer/creator.");
  }

  let interactiveObjects = 0;
  let formXObjects = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : undefined;
    if (!dict) continue;
    const keys = dict.keys().map(key => key.decodeText());
    if (keys.some(key => FORBIDDEN_RASTER_OBJECT_KEYS.has(key))) interactiveObjects++;
    const action = dict.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();
    if (action && FORBIDDEN_ACTION_TYPES.has(action)) interactiveObjects++;
    const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
    if (subtype === "Form") formXObjects++;
    if (subtype && ["FileAttachment", "RichMedia", "Movie", "Sound", "Screen"].includes(subtype)) {
      interactiveObjects++;
    }
  }
  if (interactiveObjects || formXObjects) {
    failure("verification_failed", "Raster-redacted output retained interactive/hidden PDF objects.");
  }

  let annotations = 0;
  let imageXObjects = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.Annots, PDFArray);
    annotations += annots?.size() ?? 0;
    const resources = page.node.lookupMaybe(PDFName.Resources, PDFDict);
    if (!resources) failure("verification_failed", "Raster-redacted page is missing a resource dictionary.");
    for (const resourceName of ["Font", "ExtGState", "Properties", "Pattern", "Shading"]) {
      const dict = resources.lookupMaybe(PDFName.of(resourceName), PDFDict);
      if (dict && dict.keys().length) {
        failure("verification_failed", "Raster-redacted page retained non-image resource: " + resourceName);
      }
    }
    const xObjects = resources.lookupMaybe(PDFName.XObject, PDFDict);
    if (!xObjects || xObjects.keys().length !== 1) {
      failure("verification_failed", "Every raster-redacted page must contain exactly one image XObject.");
    }
    for (const key of xObjects.keys()) {
      const stream = xObjects.lookupMaybe(key, PDFStream);
      const subtype = stream?.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
      if (!stream || subtype !== "Image") {
        failure("verification_failed", "Raster-redacted page contains a non-image XObject.");
      }
      imageXObjects++;
    }
  }
  if (annotations) failure("verification_failed", "Raster-redacted output retained annotations.");

  const raw = Buffer.from(bytes).toString("latin1");
  const startXrefCount = (raw.match(/(?:^|[\r\n])startxref[\r\n]/g) || []).length;
  const eofCount = (raw.match(/%%EOF\s*(?:$|[\r\n])/g) || []).length;
  if (startXrefCount !== 1 || eofCount !== 1) {
    failure("verification_failed", "Raster-redacted output must be a single fresh PDF revision with one xref/EOF.");
  }
  return {
    catalogForbiddenEntries: 0,
    interactiveOrHiddenObjects: 0,
    annotations: 0,
    formXObjects: 0,
    imageXObjects,
    pageCount: doc.getPageCount(),
    sourceDescriptiveMetadataCopied: false,
    producer: FORENSIC_METADATA_LABEL,
    incrementalRevisionMarkers: { startxref: startXrefCount, eof: eofCount },
  };
}

export async function redactPdfRaster(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  if (args.confirmDestructiveRasterization !== true) {
    failure("confirmation_required", "Pass confirmDestructiveRasterization=true to acknowledge loss of all selectable text, links, forms and vector objects.");
  }
  const input = await bytesFromPdf(nonempty(args.inputPath, "inputPath"), root);
  if (isSigned(input.bytes)) failure("signed_document", "Cannot redact a digitally signed PDF.");
  if (!args.expectedInputSha256 || String(args.expectedInputSha256).toLowerCase() !== input.sha256) {
    failure("hash_mismatch", "A matching expectedInputSha256 from pdf_inspect is required for destructive raster redaction.");
  }
  const output = await outputPath(nonempty(args.outputPath, "outputPath"), root);
  const original = await pdfDoc(input.bytes);
  if (original.getPageCount() > MAX_RENDER_PAGES) {
    failure("page_limit", "Secure raster redaction currently supports at most 20 pages per document.");
  }
  if (!Array.isArray(args.regions) || args.regions.length === 0 || args.regions.length > 100) {
    failure("invalid_input", "regions must contain 1..100 reviewed pixel rectangles.");
  }
  const selections = (args.regions as unknown[]).map((raw, idx) => {
    const r = record(raw);
    return {
      page: integer(r.page, "regions[" + idx + "].page", 1, original.getPageCount()),
      x: integer(r.x, "x", 0, 100000),
      y: integer(r.y, "y", 0, 100000),
      width: integer(r.width, "width", 1, 100000),
      height: integer(r.height, "height", 1, 100000),
    };
  });
  // Crop/rotation change screenshot geometry; fail closed rather than guessing coordinate transforms.
  for (const page of original.getPages()) {
    const box = page.getCropBox();
    const media = page.getMediaBox();
    const normalized = [box.x, box.y, box.width, box.height];
    const expected = [media.x, media.y, media.width, media.height];
    if (page.getRotation().angle !== 0 || normalized.some((v, i) => Math.abs(v - expected[i]) > 0.01)) {
      failure("unsupported_geometry", "Raster redaction needs unrotated, uncropped pages. Normalize geometry and visually review before retrying.");
    }
  }
  // Destructive redaction must be tied to precisely the images reviewed
  // beforehand. Optional preview hashes previously permitted silent visual
  // drift between approval and publication.
  const expectedPreviews = args.expectedPreviewHashes;
  if (!expectedPreviews || typeof expectedPreviews !== "object" ||
      Array.isArray(expectedPreviews) ||
      Object.keys(expectedPreviews).length !== original.getPageCount() ||
      Array.from({ length: original.getPageCount() }, (_, i) => String(i + 1)).some(
        p => typeof (expectedPreviews as Record<string, unknown>)[p] !== "string" ||
          !/^[0-9a-f]{64}$/.test((expectedPreviews as Record<string, string>)[p]))) {
    failure("preview_required", "Secure raster redaction requires exact SHA-256 preview hashes for every page at scale=1 after visual review.");
  }
  const outputDoc = await PDFDocument.create();
  sanitizeRasterMetadata(outputDoc);
  const parser = new PDFParse({ data: Uint8Array.from(input.bytes) });
  let verifiedPixels = 0;
  const sourceRenders: Array<{ page: number; sha256: string }> = [];
  try {
    const pageList = Array.from({ length: original.getPageCount() }, (_, i) => i + 1);
    const render = await parser.getScreenshot({ partial: pageList, scale: 1, imageBuffer: true, imageDataUrl: false });
    if (render.pages.length !== pageList.length) failure("render_failed", "Renderer returned incomplete pages; nothing published.");

    for (let i = 0; i < pageList.length; i++) {
      assertActive(signal);
      const rendered = render.pages[i];
      if (rendered.pageNumber !== i + 1 || !rendered.data?.length) failure("render_failed", "Invalid raster output page.");
      if (rendered.width * rendered.height > 16_000_000) failure("size_limit", "Page is too large for secure rasterization.");
      const previewSha256 = hash(rendered.data);
      sourceRenders.push({ page: i + 1, sha256: previewSha256 });
      if ((expectedPreviews as Record<string, unknown>)[String(i + 1)] !== previewSha256) {
        failure("preview_mismatch", "Rendered preview changed or missing matching hash for page " + (i + 1));
      }
      const img = await loadImage(Buffer.from(rendered.data));
      const canvas = createCanvas(rendered.width, rendered.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, rendered.width, rendered.height);
      for (const r of selections.filter(s => s.page === i + 1)) {
        if (r.x + r.width > rendered.width || r.y + r.height > rendered.height) {
          failure("invalid_rectangle", "Redaction rectangle extends beyond rendered page " + (i + 1));
        }
        ctx.fillStyle = "#000000";
        ctx.fillRect(r.x, r.y, r.width, r.height);
        const data = ctx.getImageData(r.x, r.y, r.width, r.height).data;
        for (let k = 0; k < data.length; k += 4) {
          if (data[k] !== 0 || data[k + 1] !== 0 || data[k + 2] !== 0 || data[k + 3] !== 255) {
            failure("pixel_verification_failed", "At least one redacted pixel was not fully opaque black.");
          }
        }
        verifiedPixels += r.width * r.height;
      }
      const png = await outputDoc.embedPng(canvas.toBuffer("image/png"));
      const sourcePage = original.getPage(i);
      const finalPage = outputDoc.addPage([sourcePage.getWidth(), sourcePage.getHeight()]);
      finalPage.drawImage(png, { x: 0, y: 0, width: finalPage.getWidth(), height: finalPage.getHeight() });
    }
  } finally { await parser.destroy(); }
  if (!verifiedPixels) failure("invalid_input", "No pixels were redacted.");
  const save = await outputDoc.save({ useObjectStreams: false });
  const verifiedDoc = await pdfDoc(save);
  if (verifiedDoc.getPageCount() !== original.getPageCount()) {
    failure("verification_failed", "Reconstructed document does not preserve page count.");
  }
  // Do NOT call doc.getForm()/fields() here: pdf-lib materializes an empty
  // /AcroForm catalog entry as a side effect. The forensic verifier below
  // inspects the raw catalog/object graph without mutating it.
  const forensicStructure = verifyRasterForensicStructure(save, verifiedDoc);
  if (forensicStructure.imageXObjects !== original.getPageCount()) {
    failure("verification_failed", "Reconstructed document does not satisfy image-only structure.");
  }
  // PDF.js may transfer/detach its input buffer into a worker. Keep output bytes separate.
  const checker = new PDFParse({ data: Uint8Array.from(save) });
  try {
    const text = await checker.getText({ pageJoiner: "" });
    if (text.pages.some(p => p.text.trim())) {
      failure("verification_failed", "Output unexpectedly contains a selectable text layer.");
    }
  } finally { await checker.destroy(); }
  // Independent PDF.js render of both serialized documents. Verify all
  // selected pixels remain opaque black in the published representation
  // AND every pixel outside approved rectangles stays visually identical.
  // A black working canvas by itself does not prove a PDF re-renders black.
  const originalChecker = new PDFParse({ data: Uint8Array.from(input.bytes) });
  const outputChecker = new PDFParse({ data: Uint8Array.from(save) });
  let verifiedUntouchedPixels = 0;
  let verifiedPagesAfterSerialization = 0;
  try {
    const pageList = Array.from({ length: original.getPageCount() }, (_, i) => i+1);
    const [srcShots, outShots] = await Promise.all([
      originalChecker.getScreenshot({ partial: pageList, scale: 1, imageBuffer: true, imageDataUrl: false }),
      outputChecker.getScreenshot({ partial: pageList, scale: 1, imageBuffer: true, imageDataUrl: false }),
    ]);
    if (srcShots.pages.length !== pageList.length || outShots.pages.length !== pageList.length) {
      failure("verification_failed", "Rendered source/output page count mismatch.");
    }
    for (let i=0; i<pageList.length; i++) {
      assertActive(signal);
      const a=srcShots.pages[i], b=outShots.pages[i];
      if (!a.data || !b.data || a.pageNumber !== i+1 || b.pageNumber !== i+1 ||
          a.width !== b.width || a.height !== b.height ||
          a.width*a.height > 16_000_000) {
        failure("verification_failed", "Serialized redaction output changed page geometry.");
      }
      const first=await loadImage(Buffer.from(a.data));
      const second=await loadImage(Buffer.from(b.data));
      const firstCanvas=createCanvas(a.width,a.height);
      const secondCanvas=createCanvas(a.width,a.height);
      const firstContext=firstCanvas.getContext("2d");
      const secondContext=secondCanvas.getContext("2d");
      firstContext.drawImage(first,0,0);
      secondContext.drawImage(second,0,0);
      const before=firstContext.getImageData(0,0,a.width,a.height).data;
      const after=secondContext.getImageData(0,0,b.width,b.height).data;
      const redactions=selections.filter(r=>r.page===i+1);
      for(let y=0;y<a.height;y++) for(let x=0;x<a.width;x++) {
        const idx=(y*a.width+x)*4;
        const isRedacted=redactions.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
        if(isRedacted) {
          if(after[idx]!==0||after[idx+1]!==0||after[idx+2]!==0||after[idx+3]!==255) {
            failure("verification_failed", "Redacted pixels are not opaque black in the serialized PDF.");
          }
        } else {
          for(let channel=0;channel<4;channel++){
            if(Math.abs(before[idx+channel]-after[idx+channel])>1){
              failure("verification_failed", "Output differs outside authorized raster-redaction rectangles.");
            }
          }
          verifiedUntouchedPixels++;
        }
      }
      verifiedPagesAfterSerialization++;
    }
  } finally {
    await originalChecker.destroy().catch(()=>undefined);
    await outputChecker.destroy().catch(()=>undefined);
  }
  assertActive(signal);
  if (hash(await fs.readFile(input.file)) !== input.sha256) failure("hash_mismatch", "Input changed before final publish.");
  const outputSha256 = await publish(output, save, signal);
  return {
    status: "verified", inputSha256: input.sha256, outputSha256, outputPath: output,
    pageCount: original.getPageCount(), verifiedOpaqueBlackPixels: verifiedPixels,
    verifiedUntouchedPixels, verifiedPagesAfterSerialization,
    sourceRenders,
    forensicStructure,
    warnings: [
      "All pages converted to raster images; selectable text, links, bookmarks, annotations, form fields, accessibility structure, and vector fidelity are lost.",
      "Only submitted rectangles were covered. Check every visible occurrence of sensitive content in a rendered preview.",
      "Image-only reconstruction discards original page content streams; hidden layers and metadata are not copied.",
    ],
    verificationScopes: {
      originalContentStreams: "removed_by_reconstruction",
      sourceMetadataAttachmentsActionsLayers: "verified_not_copied_by_fresh_object_graph_reconstruction",
      annotationsAndFormXObjects: "verified_absent",
      incrementalHistory: "verified_single_fresh_xref_and_eof",
      pageXObjects: "exactly_one_image_xobject_per_page",
      outputTextLayer: "verified_absent",
      targetPixels: "verified_opaque_black_after_serialization_and_rerender",
      unaffectedPixels: "pixel_parity_checked_outside_authorized_rectangles",
      fullDocumentVisualReview: "required",
    },
  };
}
