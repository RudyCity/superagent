import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { ocrPdfPretrained } from "../src/core/pdf/pdfOcrAdvanced.js";
import { pdfOcrTool } from "../src/core/tools/pdfTools.js";
import { inspectPdf } from "../src/core/pdf/pdfEngine.js";

let dir: string;
const runtime = path.join(os.homedir(), ".superagent-r", "venvs", "pdf-ocr-rapid",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const models = path.join(os.homedir(), ".superagent-r", "models", "pdf-ocr-v6");
const enabled = fsSync.existsSync(runtime) && fsSync.existsSync(path.join(models, "small", "PP-OCRv6_rec_small.onnx"));

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-real-rapid-ocr-"));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([600, 200]).drawText("SELECTABLE NATIVE TEXT", { font, x: 30, y: 130, size: 22 });
  const canvas = createCanvas(1100, 270);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1100, 270);
  ctx.fillStyle = "black";
  ctx.font = "42px Arial";
  ctx.fillText("FAKULTAS AGROINDUSTRI BRAWIJAYA", 25, 130);
  const img = await doc.embedPng(canvas.toBuffer("image/png"));
  const scan = doc.addPage([550, 135]);
  scan.drawImage(img, { x: 0, y: 0, width: 550, height: 135 });
  await fs.writeFile(path.join(dir, "mixed.pdf"), await doc.save({ useObjectStreams: false }));
});
afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

describe("Offline pretrained OCR tool contract", () => {
  it("reads native text without running models, even with a configured engine", async () => {
    const result = await ocrPdfPretrained({ inputPath: "mixed.pdf", pages: [1], engine: "small" }, dir);
    expect(result.status).toBe("verified");
    expect(result.ocrPerformed).toBe(false);
    expect(result.text).toContain("SELECTABLE NATIVE TEXT");
    expect(result.backend).toBe("pdf-text-layer");
    expect(result.scannedPages).toEqual([]);
  });

  it("fails closed for invalid engine, stale source and path traversal", async () => {
    const info = await inspectPdf({inputPath: "mixed.pdf"},dir);
    await expect(ocrPdfPretrained({inputPath:"mixed.pdf",engine:"hacked",pages:[2]},dir))
      .rejects.toMatchObject({code:"invalid_input"});
    await expect(ocrPdfPretrained({inputPath:"mixed.pdf",expectedInputSha256:"bad",pages:[2]},dir))
      .rejects.toMatchObject({code:"hash_mismatch"});
    await expect(ocrPdfPretrained({inputPath:"../other.pdf",pages:[1]},dir))
      .rejects.toMatchObject({code:"path_denied"});
    await expect(ocrPdfPretrained({inputPath:"mixed.pdf",pages:[0],expectedInputSha256:info.sha256},dir))
      .rejects.toMatchObject({code:"invalid_input"});
  });

  it.skipIf(!enabled)("runs real ONNX pretrained Small on a scanned PDF page; returns coordinates, hashes and provenance", async () => {
    const info = await inspectPdf({inputPath:"mixed.pdf"},dir);
    const result = await ocrPdfPretrained({
      inputPath:"mixed.pdf", pages:[2], engine:"small",language:"id",
      expectedInputSha256:info.sha256,
    },dir);
    expect(result.status).toBe("verified");
    expect(result.ocrPerformed).toBe(true);
    expect(result.backend).toContain("PP-OCRv6-small");
    expect(result.scannedPages).toEqual([2]);
    expect(result.pages[0].text).toContain("FAKULTAS");
    expect(result.pages[0].imageWidth).toBeGreaterThan(600);
    expect(result.pages[0].lines).not.toHaveLength(0);
    expect(result.modelHashes).toHaveProperty("PP-OCRv6_det_small");
    expect(result.modelHashes).toHaveProperty("PP-OCRv6_rec_small");
    expect(result.metrics?.observedRssBytes).toBeGreaterThan(10_000_000);
  }, 90_000);

  it.skipIf(!enabled)("executes actual Tiny and Tesseract through the registered PDF tool, not mocked fallback", async () => {
    for (const engine of ["tiny", "tesseract"]) {
      const raw = await pdfOcrTool.execute({inputPath:"mixed.pdf",pages:[2],engine,language:"id"},dir);
      const result = JSON.parse(raw);
      expect(result.status).toBe("verified");
      expect(result.ocrPerformed).toBe(true);
      expect(result.pages[0].backend).toMatch(engine === "tiny" ? /PP-OCRv6-tiny/ : /tesseract/);
      expect(result.text).toContain("FAKULTAS");
      expect(result.pages[0].lines[0].quad).toHaveLength(4);
    }
  }, 90_000);

  it.skipIf(!enabled)("OCRs mixed native + scanned pages without falsely claiming native page OCR", async () => {
    const result=await ocrPdfPretrained({inputPath:"mixed.pdf",engine:"medium",pages:[1,2]},dir);
    expect(result.status).toBe("verified");
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].ocrPerformed).toBe(false);
    expect(result.pages[1].ocrPerformed).toBe(true);
    expect(result.text).toContain("SELECTABLE NATIVE TEXT");
    expect(result.pages[1].backend).toContain("PP-OCRv6-medium");
  }, 90_000);
});
