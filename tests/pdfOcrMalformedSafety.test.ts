import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { inspectPdf } from "../src/core/pdf/pdfEngine.js";

vi.mock("../src/core/pdf/pdfOcrAdvanced.js", () => ({
  ocrPdfPretrained: vi.fn(),
}));
import { ocrPdfPretrained } from "../src/core/pdf/pdfOcrAdvanced.js";
import { createSearchablePdf } from "../src/core/pdf/pdfSearchable.js";

let root = "";
let sha = "";
const sample = () => ({
  status: "verified", truncated: false, scannedPages: [1], backend: "rapidocr-onnx-PP-OCRv6-tiny",
  pages: [{
    page: 1, ocrPerformed: true, text: "HELLO", lineCount: 1,
    imageWidth: 300, imageHeight: 300,
    lines: [{text:"HELLO", quad:[[10,10],[130,10],[130,30],[10,30]],confidence:0.9}],
  }],
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(),"superagent-malformed-ocr-"));
  const doc=await PDFDocument.create();
  doc.addPage([300,300]);
  await fs.writeFile(path.join(root,"image.pdf"),await doc.save());
  sha=(await inspectPdf({inputPath:"image.pdf"},root)).sha256;
});
afterAll(async()=>{if(root) await fs.rm(root,{recursive:true,force:true});});
beforeEach(()=>vi.mocked(ocrPdfPretrained).mockReset());

async function refused(outputPath:string, mockedResult:Record<string,unknown>) {
  vi.mocked(ocrPdfPretrained).mockResolvedValue(mockedResult as never);
  await expect(createSearchablePdf({
    inputPath:"image.pdf",outputPath,expectedInputSha256:sha,
    engine:"tiny",language:"id",
  },root)).rejects.toMatchObject({code:"ocr_incomplete"});
  await expect(fs.stat(path.join(root,outputPath))).rejects.toMatchObject({code:"ENOENT"});
}

describe("Searchable PDF never publishes incomplete OCR",()=>{
  it("refuses partial/truncated response",async()=>{
    await refused("partial.pdf",{...sample(),status:"partial",truncated:true});
  });
  it("refuses missing text geometry and silently omitted OCR lines",async()=>{
    const missing=sample();
    missing.pages[0].lineCount=2;
    await refused("missing-line.pdf",missing);
    const malformed=sample();
    malformed.pages[0].lines[0].quad=[[10,10],[130,10],[130,30]] as never;
    await refused("malformed-quad.pdf",malformed);
  });
  it("refuses blank text and blank line content without publishing a PDF",async()=>{
    const blank=sample();
    blank.pages[0].lines[0].text="";
    await refused("blank-line.pdf",blank);
    const noText=sample();
    noText.pages[0].text="";
    await refused("blank-page.pdf",noText);
  });
});
