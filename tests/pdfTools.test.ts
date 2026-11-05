import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inspectPdf, editPdf, splitPdf, extractPdf, renderPdf, verifyPdf, redactPdfRaster, PdfOperationError } from "../src/core/pdf/pdfEngine.js";
import { pdfEditTool, pdfInspectTool } from "../src/core/tools/pdfTools.js";
import { allTools } from "../src/core/tools/index.js";
import { masterToolset, subagentToolsets, superagentToolset } from "../src/core/tools/toolsets.js";

let dir: string;
let original: Uint8Array;
async function makePdf(file: string, count = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= count; i++) {
    const p = doc.addPage([400, 600]);
    p.drawText("Example " + i, { x: 45, y: 540, size: 18, font });
  }
  const out = await doc.save({ useObjectStreams: false });
  await fs.writeFile(path.join(dir, file), out);
  return out;
}
function op(inputPath: string, outputPath: string, operations: unknown[]) {
  return { inputPath, outputPath, operations };
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-test-"));
  original = await makePdf("input.pdf");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
function codeOf(err: unknown) { return err instanceof PdfOperationError ? err.code : String(err); }

describe("SuperAgent PDF editing toolset", () => {
  it("registers read tools for Master and read-write for coder, not researcher", () => {
    expect(allTools.find(t => t.name === "pdf_edit")).toBeDefined();
    expect(superagentToolset.find(t => t.name === "pdf_edit")).toBeDefined();
    expect(masterToolset.find(t => t.name === "pdf_inspect")).toBeDefined();
    expect(masterToolset.find(t => t.name === "pdf_edit")).toBeUndefined();
    expect(subagentToolsets.researcher.find(t => t.name === "pdf_edit")).toBeUndefined();
    expect(subagentToolsets.coder.find(t => t.name === "pdf_edit")).toBeDefined();
  });

  it("inspects pages and preserves original while rotating + stamping", async () => {
    const initial = await inspectPdf({ inputPath: "input.pdf" }, dir);
    expect(initial.pageCount).toBe(3);
    expect(initial.pages[0].width).toBe(400);
    const result = await editPdf(op("input.pdf", "edited.pdf", [
      { op: "rotate_pages", pages: [2], degrees: 90 },
      { op: "add_text", pages: [1], text: "REVIEWED", x: 45, y: 490 },
      { op: "set_metadata", title: "Edited Example" },
    ]), dir);
    expect(result.status).toBe("verified");
    expect(result.outputWritten).toBe(true);
    expect((await fs.readFile(path.join(dir, "input.pdf"))).equals(Buffer.from(original))).toBe(true);
    const inspected = await inspectPdf({ inputPath: "edited.pdf" }, dir);
    expect(inspected.pageCount).toBe(3);
    expect(inspected.pages[1].rotation).toBe(90);
    expect(inspected.title).toBe("Edited Example");
    const text = await extractPdf({ inputPath: "edited.pdf", pages: [1] }, dir);
    expect(text.text).toContain("REVIEWED");
  });

  it("renders Indonesian Unicode overlays with a workspace-scoped embedded font when available", async () => {
    const candidates = [
      "C:/Windows/Fonts/arial.ttf",
      "C:/Windows/Fonts/segoeui.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    let sourceFont: string | undefined;
    for (const candidate of candidates) {
      try { await fs.stat(candidate); sourceFont = candidate; break; }
      catch { /* not installed on this OS */ }
    }
    if (!sourceFont) return;
    await fs.copyFile(sourceFont, path.join(dir, "local-font.ttf"));
    const result = await editPdf(op("input.pdf", "unicode.pdf", [
      { op: "add_text", pages: [1], text: "Dokumen revisi – pendidikan", fontPath: "local-font.ttf", x: 40, y: 500 },
    ]), dir);
    expect(result.status).toBe("verified");
    const resultText = await extractPdf({ inputPath: "unicode.pdf", pages: [1] }, dir);
    expect(resultText.text).toContain("Dokumen revisi");
    await expect(editPdf(op("input.pdf", "font-outside.pdf", [
      { op: "add_text", pages: [1], text: "test", fontPath: sourceFont },
    ]), dir)).rejects.toMatchObject({ code: "path_denied" });
  });

  it("bounds total extracted page text to the requested character limit", async () => {
    const result = await extractPdf({ inputPath: "input.pdf", maxChars: 10 }, dir);
    expect(result.status).toBe("partial");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(10);
    expect(result.pages.reduce((sum, page) => sum + page.text.length, 0)).toBeLessThanOrEqual(10);
  });

  it("splits files and reorders selected pages correctly", async () => {
    const result = await splitPdf({ inputPath: "input.pdf", outputPrefix: "subset", groups: [[3, 1], [2]] }, dir);
    expect(result.files).toHaveLength(2);
    expect((await inspectPdf({ inputPath: "subset-part-1.pdf" }, dir)).pageCount).toBe(2);
    const text = await extractPdf({ inputPath: "subset-part-1.pdf" }, dir);
    expect(text.text.indexOf("Example 3")).toBeLessThan(text.text.indexOf("Example 1"));
  });

  it("merges pages, removes pages, and rejects removing every page", async () => {
    await makePdf("other.pdf", 2);
    const result = await editPdf(op("input.pdf", "combined.pdf", [
      { op: "merge_pdf", sourcePath: "other.pdf", pages: [1, 2] },
      { op: "delete_pages", pages: [1] },
      { op: "page_numbers" },
    ]), dir);
    expect(result.outputPageCount).toBe(4);
    await expect(editPdf(op("input.pdf", "empty.pdf", [
      { op: "delete_pages", pages: [1, 2, 3] },
    ]), dir)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fills and flattens a PDF form", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const field = doc.getForm().createTextField("fullName");
    field.addToPage(page, { x: 30, y: 510, width: 220, height: 24 });
    await fs.writeFile(path.join(dir, "form.pdf"), await doc.save());
    const form = await editPdf(op("form.pdf", "form-filled.pdf", [
      { op: "fill_form", field: "fullName", value: "Rudy Example" },
      { op: "flatten_forms" },
    ]), dir);
    expect(form.status).toBe("verified");
    expect((await inspectPdf({ inputPath: "form-filled.pdf" }, dir)).forms).toHaveLength(0);
    const text = await extractPdf({ inputPath: "form-filled.pdf" }, dir);
    expect(text.text).toContain("Rudy Example");
  });

  it("rejects overwritten output, traversal, and hash mismatches", async () => {
    await expect(editPdf(op("input.pdf", "input.pdf", [{ op: "page_numbers" }]), dir))
      .rejects.toMatchObject({ code: "already_exists" });
    await expect(inspectPdf({ inputPath: "../outside.pdf" }, dir)).rejects.toMatchObject({ code: "path_denied" });
    await expect(editPdf({ ...op("input.pdf", "new.pdf", [{ op: "page_numbers" }]), expectedInputSha256: "fake" }, dir))
      .rejects.toMatchObject({ code: "hash_mismatch" });
    await expect(fs.stat(path.join(dir, "new.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dry runs without creating a PDF, and refuses fake redaction/text replacement", async () => {
    const dry = await editPdf({ ...op("input.pdf", "dry.pdf", [{ op: "rotate_pages", pages: [1], degrees: 180 }]), dryRun: true }, dir);
    expect(dry.outputWritten).toBe(false);
    await expect(fs.stat(path.join(dir, "dry.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const forbidden of ["redact", "replace_text"]) {
      await expect(editPdf(op("input.pdf", "forbidden.pdf", [{ op: forbidden, text: "secret" }]), dir))
        .rejects.toMatchObject({ code: "unsupported_exact_edit" });
    }
  });

  it("renders PNG to a new file and verifies checksum", async () => {
    const shot = await renderPdf({ inputPath: "input.pdf", outputPrefix: "rendered", pages: [1], scale: 0.8 }, dir);
    expect(shot.images).toHaveLength(1);
    const buffer = await fs.readFile(path.join(dir, "rendered-page-1.png"));
    expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const info = await verifyPdf({ inputPath: "input.pdf", expectedPageCount: 3 }, dir);
    expect(info.pageCount).toBe(3);
    expect(info.hashMatches).toBeNull();
  });

  it("requires explicit hash + confirmation before destructive raster redaction", async () => {
    const info = await inspectPdf({ inputPath: "input.pdf" }, dir);
    const args = {
      inputPath: "input.pdf", outputPath: "redacted.pdf",
      expectedInputSha256: info.sha256,
      regions: [{ page: 1, x: 38, y: 34, width: 205, height: 46 }],
    };
    await expect(redactPdfRaster(args, dir)).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(redactPdfRaster({ ...args, confirmDestructiveRasterization: true }, dir))
      .rejects.toMatchObject({ code: "preview_required" });
    const preview = await renderPdf({ inputPath: "input.pdf", outputPrefix: "raster-review", scale: 1, pages: [1,2,3] }, dir);
    const expectedPreviewHashes = Object.fromEntries(preview.images.map(img => [String(img.page), img.sha256]));
    const outcome = await redactPdfRaster({ ...args, expectedPreviewHashes, confirmDestructiveRasterization: true }, dir);
    expect(outcome.status).toBe("verified");
    expect(outcome.verifiedOpaqueBlackPixels).toBeGreaterThan(0);
    expect(outcome.verifiedUntouchedPixels).toBeGreaterThan(0);
    expect(outcome.verifiedPagesAfterSerialization).toBe(3);
    expect(outcome.verificationScopes.targetPixels).toBe("verified_opaque_black_after_serialization_and_rerender");
    expect(outcome.verificationScopes.unaffectedPixels).toBe("pixel_parity_checked_outside_authorized_rectangles");
    const extracted = await extractPdf({ inputPath: "redacted.pdf" }, dir);
    expect(extracted.pages.every(page => page.text.trim() === "")).toBe(true);
    expect((await inspectPdf({ inputPath: "redacted.pdf" }, dir)).pageCount).toBe(3);
    expect((await fs.readFile(path.join(dir, "input.pdf"))).equals(Buffer.from(original))).toBe(true);
  });

  it("denies raster redaction when preview hash mismatches", async () => {
    const info = await inspectPdf({ inputPath: "input.pdf" }, dir);
    const review = await renderPdf({ inputPath: "input.pdf", outputPrefix: "mismatch-review", scale: 1, pages: [1,2,3] }, dir);
    const expectedPreviewHashes = Object.fromEntries(review.images.map(img => [String(img.page), img.sha256]));
    expectedPreviewHashes["1"] = "f".repeat(64);
    await expect(redactPdfRaster({
      inputPath: "input.pdf", outputPath: "unpublished.pdf",
      expectedInputSha256: info.sha256, confirmDestructiveRasterization: true,
      expectedPreviewHashes,
      regions: [{ page: 1, x: 20, y: 30, width: 70, height: 30 }],
    }, dir)).rejects.toMatchObject({ code: "preview_mismatch" });
    await expect(fs.stat(path.join(dir, "unpublished.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes structured errors rather than claiming failed edits succeeded", async () => {
    const text = await pdfEditTool.execute(op("input.pdf", "wrong.pdf", [{ op: "redact" }]), dir);
    expect(JSON.parse(text)).toMatchObject({ status: "failed", code: "unsupported_exact_edit" });
    const info = await pdfInspectTool.execute({ inputPath: "input.pdf" }, dir);
    expect(JSON.parse(info).pageCount).toBe(3);
  });
});
