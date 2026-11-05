import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

vi.mock("../src/core/setup/ocrSetup.js", () => ({
  isPaddleOcrAvailable: vi.fn(async () => true),
  runPaddleOcrOnPdf: vi.fn(async () => "INVOICE SCAN SAMPLE 123"),
}));

import { readDocumentTool } from "../src/core/tools/documentReadTools.js";
import { pdfOcrTool } from "../src/core/tools/pdfTools.js";
import { pdfInspectTool } from "../src/core/tools/pdfTools.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-ocr-"));
  const canvas = createCanvas(500, 150);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 500, 150);
  ctx.fillStyle = "#000000";
  ctx.font = "26px sans-serif";
  ctx.fillText("INVOICE SCAN SAMPLE 123", 8, 90);
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(canvas.toBuffer("image/png"));
  pdf.addPage([500, 150]).drawImage(img, { x: 0, y: 0, width: 500, height: 150 });
  await fs.writeFile(path.join(root, "scanned.pdf"), await pdf.save());
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("Image-only PDF OCR fallback", () => {
  it("returns real OCR text instead of only pdf-parse page headers", async () => {
    const content = await readDocumentTool.execute({filePath: "scanned.pdf"}, root);
    expect(content).toContain("via OCR Engine");
    expect(content).toContain("INVOICE SCAN SAMPLE 123");
  });
  it("the pdf_ocr tool reports OCR actually performed", async () => {
    const raw = await pdfOcrTool.execute({inputPath: "scanned.pdf", engine: "legacy"}, root);
    const data = JSON.parse(raw);
    expect(data).toMatchObject({
      status: "partial",
      backend: "local_ocr_fallback",
      ocrPerformed: true,
    });
    expect(data.text).toContain("INVOICE SCAN SAMPLE 123");
  });
  it("rejects OCR paths escaping the authorized workspace before reading", async () => {
    const raw = await pdfOcrTool.execute({inputPath: "../not-in-workspace.pdf"}, root);
    const data = JSON.parse(raw);
    expect(data).toMatchObject({status: "failed", code: "path_denied"});
  });
});
