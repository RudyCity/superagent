import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { inspectPdf, extractPdf } from "../src/core/pdf/pdfEngine.js";
import { createSearchablePdf, loadVerifiedUnicodeOcrFont } from "../src/core/pdf/pdfSearchable.js";

const enabled = fsSync.existsSync(path.join(os.homedir(), ".superagent-r", "models", "pdf-ocr-v6", "small", "PP-OCRv6_rec_small.onnx"));
const unicodeEnabled = fsSync.existsSync(path.join(os.homedir(), ".superagent-r", "models", "pdf-ocr-v6", "fonts", "NotoSans-Regular.ttf"));
let dir = "";
let original: Buffer;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-searchable-qa-"));
  const pdf = await PDFDocument.create();
  const canvas = createCanvas(1100, 270);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1100, 270);
  ctx.fillStyle = "black";
  ctx.font = "42px Arial";
  ctx.fillText("FAKULTAS AGROINDUSTRI BRAWIJAYA", 25, 130);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  pdf.addPage([550, 135]).drawImage(image, { x: 0, y: 0, width: 550, height: 135 });
  original = Buffer.from(await pdf.save({useObjectStreams:false}));
  await fs.writeFile(path.join(dir, "scan.pdf"), original);
  const digital = await PDFDocument.create();
  const page = digital.addPage([550,135]);
  page.drawText("NATIVE DIGITAL TEXT", { x: 20, y: 80, size: 18,
    font: await digital.embedFont(StandardFonts.Helvetica) });
  await fs.writeFile(path.join(dir, "digital.pdf"), await digital.save());
});
afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

async function pixels(bytes: Uint8Array): Promise<Uint8ClampedArray> {
  const parser = new PDFParse({ data: Uint8Array.from(bytes) });
  try {
    const png = (await parser.getScreenshot({ partial: [1], scale: 1, imageBuffer: true, imageDataUrl: false })).pages[0].data;
    const image = await loadImage(Buffer.from(png));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image,0,0);
    return ctx.getImageData(0,0,image.width,image.height).data;
  } finally {
    await parser.destroy();
  }
}
describe.skipIf(!unicodeEnabled)("Pinned Unicode OCR font", () => {
  it("embeds transparent Indonesian punctuation and accented text without changing visible pixels", async () => {
    // Do not save and then mutate the *same* pdf-lib object: a prior save
    // finalizes resources and is not a valid before/after mutation oracle.
    async function base() {
      const doc=await PDFDocument.create();
      const page=doc.addPage([480,160]);
      page.drawRectangle({x:20,y:40,width:260,height:30,color:rgb(0.9,0.94,0.98)});
      return {doc,page};
    }
    const beforeDoc=await base();
    const before=await beforeDoc.doc.save({useObjectStreams:false});
    const afterDoc=await base();
    const text="Pendidikan – Café, Tahun 2026";
    const font=await loadVerifiedUnicodeOcrFont(afterDoc.doc,text);
    afterDoc.page.drawText(text,{x:30,y:60,font,size:15,opacity:0});
    const after=await afterDoc.doc.save({useObjectStreams:false});
    const parser=new PDFParse({data:Uint8Array.from(after)});
    try {
      const extracted=await parser.getText({partial:[1]});
      expect(extracted.text).toContain(text);
    } finally {await parser.destroy();}
    expect(Buffer.from(await pixels(before)).equals(Buffer.from(await pixels(after)))).toBe(true);
  },30000);
  it("rejects unsupported glyphs rather than substituting missing characters",async()=>{
    const doc=await PDFDocument.create();
    doc.addPage([480,160]);
    await expect(loadVerifiedUnicodeOcrFont(doc,"Simbol 🦄")).rejects.toMatchObject({code:"unsupported_unicode"});
  });
});

describe.skipIf(!enabled)("Additive searchable PDF from pretrained OCR", () => {
  it("creates a new searchable image PDF, verifies text and pixel parity, leaves source untouched", async () => {
    const inspected = await inspectPdf({inputPath:"scan.pdf"},dir);
    const res = await createSearchablePdf({
      inputPath:"scan.pdf",outputPath:"scan.searchable.pdf",
      expectedInputSha256:inspected.sha256,engine:"small",language:"id",
    },dir);
    expect(res.status).toBe("verified");
    expect(res.newSearchablePages).toEqual([1]);
    expect(res.mappedTextLines).toBeGreaterThanOrEqual(1);
    expect(res.verificationScopes.originalVisiblePixels).toBe("pixel_parity_verified_for_modified_pages");
    const text = await extractPdf({inputPath:"scan.searchable.pdf"},dir);
    expect(text.text).toContain("FAKULTAS AGROINDUSTRI BRAWIJAYA");
    expect((await fs.readFile(path.join(dir, "scan.pdf"))).equals(original)).toBe(true);
    const output = await fs.readFile(path.join(dir, "scan.searchable.pdf"));
    expect(output.subarray(0, 5).toString()).toBe("%PDF-");
  }, 60000);

  it("rejects native selectable text, stale hashes and original overwrite", async () => {
    const digital=await inspectPdf({inputPath:"digital.pdf"},dir);
    await expect(createSearchablePdf({
      inputPath:"digital.pdf",outputPath:"skip.pdf",expectedInputSha256:digital.sha256,
      engine:"small",
    },dir)).rejects.toMatchObject({code:"not_scanned"});
    await expect(createSearchablePdf({
      inputPath:"scan.pdf",outputPath:"wrong.pdf",expectedInputSha256:"f".repeat(64),
      engine:"small",
    },dir)).rejects.toMatchObject({code:"hash_mismatch"});
    const scan=await inspectPdf({inputPath:"scan.pdf"},dir);
    await expect(createSearchablePdf({
      inputPath:"scan.pdf",outputPath:"scan.pdf",expectedInputSha256:scan.sha256,engine:"small",
    },dir)).rejects.toMatchObject({code:"already_exists"});
  },60000);
});
