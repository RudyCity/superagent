import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, PDFArray, PDFString, PDFNumber, PDFOperator, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, moveText } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fontkit from "@pdf-lib/fontkit";
import { editPdfVectorExact } from "../src/core/pdf/pdfVector.js";
import { inspectPdf } from "../src/core/pdf/pdfEngine.js";

const embeddedFontPath=path.join(os.homedir(),".superagent-r/models/pdf-ocr-v6/fonts/NotoSans-Regular.ttf");
const embeddedFontReady=fsSync.existsSync(embeddedFontPath);
let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-vector-pdf-test-"));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 570]);
  page.drawText("PRIVATE NOTE", { x: 40, y: 500, font, size: 15 });
  page.drawText("Public information", { x: 40, y: 450, font, size: 15 });
  page.drawRectangle({ x: 30, y: 410, width: 330, height: 2, color: rgb(0, 0.2, 0.8) });
  await fs.writeFile(path.join(dir, "input.pdf"), await doc.save({ useObjectStreams: false }));
  const complex = await PDFDocument.create();
  const pg = complex.addPage([400, 570]);
  pg.drawText("PRIVATE NOTE", {x:40,y:500,font:await complex.embedFont(StandardFonts.Helvetica),size:15});
  pg.drawText("PRIVATE NOTE", {x:40,y:460,size:15});
  await fs.writeFile(path.join(dir, "ambiguous.pdf"), await complex.save());
  const tjDoc=await PDFDocument.create();
  const tjPage=tjDoc.addPage([400,570]);
  const tjFont=await tjDoc.embedFont(StandardFonts.Helvetica);
  const tjFontKey=tjPage.node.newFontDictionary(tjFont.name,tjFont.ref);
  const tjArray=PDFArray.withContext(tjDoc.context);
  tjArray.push(PDFString.of("PRIVATE"));
  tjArray.push(PDFNumber.of(-20));
  tjArray.push(PDFString.of(" NOTE"));
  tjPage.pushOperators(
    pushGraphicsState(),beginText(),setFontAndSize(tjFontKey,15),
    moveText(40,500),PDFOperator.of("TJ",[tjArray]),endText(),popGraphicsState(),
  );
  // Register the font in the page's resource dictionary using pdf-lib's
  // public page writer, so independent parsers can decode the custom TJ.
  tjPage.drawText("Public information",{x:40,y:450,font:tjFont,size:15});
  tjPage.drawRectangle({ x: 30, y: 410, width: 330, height: 2, color: rgb(0, 0.2, 0.8) });
  await fs.writeFile(path.join(dir,"tj-input.pdf"),await tjDoc.save({useObjectStreams:false}));
  const unsafeDoc=await PDFDocument.create();
  const unsafePage=unsafeDoc.addPage([400,570]);
  const unsafeFont=await unsafeDoc.embedFont(StandardFonts.Helvetica);
  const unsafeKey=unsafePage.node.newFontDictionary(unsafeFont.name,unsafeFont.ref);
  const unsafeArray=PDFArray.withContext(unsafeDoc.context);
  unsafeArray.push(PDFString.of("PRIVATE NOTE"));
  unsafeArray.push(PDFNumber.of(5000));
  unsafePage.pushOperators(
    pushGraphicsState(),beginText(),setFontAndSize(unsafeKey,15),
    moveText(40,500),PDFOperator.of("TJ",[unsafeArray]),endText(),popGraphicsState(),
  );
  await fs.writeFile(path.join(dir,"tj-unsafe.pdf"),await unsafeDoc.save({useObjectStreams:false}));
  if (embeddedFontReady) {
    const unicodeDoc=await PDFDocument.create();
    unicodeDoc.registerFontkit(fontkit);
    const embedded=await unicodeDoc.embedFont(await fs.readFile(embeddedFontPath),{subset:true});
    const unicodePage=unicodeDoc.addPage([640,300]);
    unicodePage.drawText("Pendidikan – Cafe Ké",{x:40,y:190,size:20,font:embedded});
    await fs.writeFile(path.join(dir,"unicode-embedded.pdf"),await unicodeDoc.save({useObjectStreams:false}));
  }
  const metadata=await PDFDocument.create();
  const mpage=metadata.addPage([400,570]);
  mpage.drawText("PRIVATE NOTE",{x:40,y:500,font:await metadata.embedFont(StandardFonts.Helvetica),size:15});
  metadata.setTitle("PRIVATE NOTE");
  await fs.writeFile(path.join(dir,"metadata-secret.pdf"),await metadata.save({useObjectStreams:false}));
  const attached=await PDFDocument.create();
  attached.addPage([400,570]).drawText("PRIVATE NOTE",{x:40,y:500,font:await attached.embedFont(StandardFonts.Helvetica),size:15});
  await attached.attach(new TextEncoder().encode("hidden private attachment"),"attachment.txt",{
    mimeType:"text/plain",description:"Test attachment containing private data",
  });
  await fs.writeFile(path.join(dir,"attached-secret.pdf"),await attached.save({useObjectStreams:false}));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function preview(file: string) {
  const parser = new PDFParse({ data: Uint8Array.from(await fs.readFile(path.join(dir, file))) });
  try {
    const shots = await parser.getScreenshot({ partial: [1], scale: 1, imageBuffer: true, imageDataUrl: false });
    const img = await loadImage(Buffer.from(shots.pages[0].data));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return { width: img.width, height: img.height, rgba: ctx.getImageData(0, 0, img.width, img.height).data };
  } finally { await parser.destroy(); }
}

describe("Strict vector-preserving PDF text modification", () => {
  it.skipIf(!embeddedFontReady)("replaces original embedded Type0 Identity-H Unicode glyphs without overlay",async()=>{
    const info=await inspectPdf({inputPath:"unicode-embedded.pdf"},dir);
    const original="Pendidikan – Cafe Ké";
    const replacement="Pendidikan – Café Ke";
    const result=await editPdfVectorExact({
      inputPath:"unicode-embedded.pdf",outputPath:"unicode-edited.pdf",
      expectedInputSha256:info.sha256,page:1,mode:"replace_exact",
      targetText:original,replacementText:replacement,fontPolicy:"embedded_subset",
    },dir);
    expect(result.status).toBe("verified");
    expect(result.verificationScopes.fontPolicy).toBe("embedded_subset");
    const parser=new PDFParse({data:Uint8Array.from(await fs.readFile(path.join(dir,"unicode-edited.pdf")))});
    try{
      const extracted=(await parser.getText()).text;
      expect(extracted).toContain(replacement);
      expect(extracted).not.toContain(original);
    }finally{await parser.destroy()}
    const before=await preview("unicode-embedded.pdf");
    const after=await preview("unicode-edited.pdf");
    expect(before.width).toBe(after.width);
    expect(before.height).toBe(after.height);
    const [x0,y0,x1,y1]=result.originalBoundingBox as number[];
    let changedOutside=0;
    for(let y=0;y<before.height;y++)for(let x=0;x<before.width;x++){
      if(x>=x0-2&&x<=x1+2&&y>=before.height-y1-2&&y<=before.height-y0+2) continue;
      const i=(y*before.width+x)*4;
      if(Math.abs(before.rgba[i]-after.rgba[i])>3) changedOutside++;
    }
    expect(changedOutside).toBeLessThan(10);
  },30000);

  it.skipIf(!embeddedFontReady)("rejects new missing embedded glyph and refuses embedded redaction",async()=>{
    const info=await inspectPdf({inputPath:"unicode-embedded.pdf"},dir);
    const base={inputPath:"unicode-embedded.pdf",expectedInputSha256:info.sha256,
      page:1,targetText:"Pendidikan – Cafe Ké",fontPolicy:"embedded_subset"};
    await expect(editPdfVectorExact({...base,outputPath:"unicode-missing.pdf",
      mode:"replace_exact",replacementText:"Pendidikan – Cafe Zé"},dir))
      .rejects.toMatchObject({code:"missing_glyph"});
    await expect(editPdfVectorExact({...base,outputPath:"unicode-redaction.pdf",
      mode:"redact_exact",confirmRedact:true},dir))
      .rejects.toMatchObject({code:"unsupported_content"});
    await expect(fs.stat(path.join(dir,"unicode-missing.pdf"))).rejects.toMatchObject({code:"ENOENT"});
  },30000);
  it("replaces an exact Standard-14 Tj text operator without moving other vectors", async () => {
    const source = await inspectPdf({ inputPath: "input.pdf" }, dir);
    const result = await editPdfVectorExact({
      inputPath: "input.pdf", outputPath: "replaced.pdf", expectedInputSha256: source.sha256,
      page: 1, mode: "replace_exact", targetText: "PRIVATE NOTE", replacementText: "PUBLIC NOTE",
    }, dir);
    expect(result.status).toBe("verified");
    expect(result.vectorGraphicsPreserved).toBe(true);
    const parser = new PDFParse({ data: Uint8Array.from(await fs.readFile(path.join(dir, "replaced.pdf"))) });
    try {
      const content = await parser.getText();
      expect(content.text).not.toContain("PRIVATE NOTE");
      expect(content.text).toContain("PUBLIC NOTE");
      expect(content.text).toContain("Public information");
    } finally { await parser.destroy(); }
    const before = await preview("input.pdf");
    const after = await preview("replaced.pdf");
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    const [x0, y0, x1, y1] = result.originalBoundingBox as number[];
    let changedOutside = 0;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        if (x >= x0 - 4 && x <= x1 + 15 && y >= before.height - y1 - 4 && y <= before.height - y0 + 4) continue;
        const p = (y * before.width + x) * 4;
        if (Math.abs(before.rgba[p] - after.rgba[p]) > 3 ||
            Math.abs(before.rgba[p + 1] - after.rgba[p + 1]) > 3 ||
            Math.abs(before.rgba[p + 2] - after.rgba[p + 2]) > 3) changedOutside++;
      }
    }
    expect(changedOutside).toBeLessThan(15);
  }, 30_000);

  it("replaces one fragmented Standard-14 TJ array while preserving unaffected vector pixels",async()=>{
    const source=await inspectPdf({inputPath:"tj-input.pdf"},dir);
    const result=await editPdfVectorExact({
      inputPath:"tj-input.pdf",outputPath:"tj-replaced.pdf",expectedInputSha256:source.sha256,
      page:1,mode:"replace_exact",targetText:"PRIVATE NOTE",replacementText:"PUBLIC NOTE",
    },dir);
    expect(result.status).toBe("verified");
    expect(result.verificationScopes.matchedTextOperator).toBe("unique_Tj_or_bounded_TJ");
    const parser=new PDFParse({data:Uint8Array.from(await fs.readFile(path.join(dir,"tj-replaced.pdf")))});
    try {
      const text=(await parser.getText({partial:[1]})).text;
      expect(text).toContain("PUBLIC NOTE");
      expect(text).not.toContain("PRIVATE NOTE");
    } finally {await parser.destroy();}
    const before=await preview("tj-input.pdf");
    const after=await preview("tj-replaced.pdf");
    const [x0,y0,x1,y1]=result.originalBoundingBox as number[];
    let outside=0;
    for(let y=0;y<before.height;y++)for(let x=0;x<before.width;x++){
      if(x>=x0-4&&x<=x1+15&&y>=before.height-y1-4&&y<=before.height-y0+4)continue;
      const idx=(y*before.width+x)*4;
      if(Math.abs(before.rgba[idx]-after.rgba[idx])>3)outside++;
    }
    expect(outside).toBeLessThan(15);
  },30000);

  it("removes all TJ fragments in strict vector redaction without leaving source text",async()=>{
    const source=await inspectPdf({inputPath:"tj-input.pdf"},dir);
    const result=await editPdfVectorExact({
      inputPath:"tj-input.pdf",outputPath:"tj-redacted.pdf",expectedInputSha256:source.sha256,
      page:1,mode:"redact_exact",targetText:"PRIVATE NOTE",confirmRedact:true,
    },dir);
    expect(result.status).toBe("verified");
    const pdf=await fs.readFile(path.join(dir,"tj-redacted.pdf"));
    const parser=new PDFParse({data:Uint8Array.from(pdf)});
    try {
      expect((await parser.getText()).text).not.toContain("PRIVATE NOTE");
    }finally{await parser.destroy();}
    expect(pdf.toString("latin1")).not.toContain("PRIVATE");
  },30000);

  it("refuses oversized TJ kerning instead of guessing source layout",async()=>{
    const info=await inspectPdf({inputPath:"tj-unsafe.pdf"},dir);
    await expect(editPdfVectorExact({
      inputPath:"tj-unsafe.pdf",outputPath:"tj-unsafe-output.pdf",
      expectedInputSha256:info.sha256,page:1,mode:"redact_exact",
      targetText:"PRIVATE NOTE",confirmRedact:true,
    },dir)).rejects.toMatchObject({code:"unsupported_content"});
    await expect(fs.stat(path.join(dir,"tj-unsafe-output.pdf"))).rejects.toMatchObject({code:"ENOENT"});
  },30000);

  it("removes a text-show operator and adds an opaque vector blackout", async () => {
    const source = await inspectPdf({ inputPath: "input.pdf" }, dir);
    const result = await editPdfVectorExact({
      inputPath: "input.pdf", outputPath: "vector-redacted.pdf", expectedInputSha256: source.sha256,
      page: 1, mode: "redact_exact", targetText: "PRIVATE NOTE", confirmRedact: true,
    }, dir);
    expect(result.status).toBe("verified");
    const pdf = await fs.readFile(path.join(dir,"vector-redacted.pdf"));
    expect(pdf.toString("latin1")).not.toContain("PRIVATE NOTE");
    expect(pdf.toString("latin1").toLowerCase()).not.toContain(Buffer.from("PRIVATE NOTE").toString("hex").toLowerCase());
    const parser = new PDFParse({data: Uint8Array.from(pdf)});
    try {
      const text = await parser.getText();
      expect(text.text).not.toContain("PRIVATE NOTE");
      expect(text.text).toContain("Public information");
    } finally {await parser.destroy();}
    const after = await preview("vector-redacted.pdf");
    const [x0,y0,x1,y1] = result.originalBoundingBox as number[];
    const centerX = Math.floor((x0+x1)/2), centerY = Math.floor(after.height - (y0+y1)/2);
    const p = (centerY*after.width+centerX)*4;
    expect([...after.rgba.slice(p,p+3)]).toEqual([0,0,0]);
  }, 30_000);

  it("fails closed for ambiguous text or missing destructive approval", async () => {
    const source = await inspectPdf({inputPath:"input.pdf"},dir);
    await expect(editPdfVectorExact({
      inputPath:"input.pdf",outputPath:"no-redaction.pdf",expectedInputSha256:source.sha256,
      page:1,mode:"redact_exact",targetText:"PRIVATE NOTE",
    },dir)).rejects.toMatchObject({code:"confirmation_required"});
    const other=await inspectPdf({inputPath:"ambiguous.pdf"},dir);
    await expect(editPdfVectorExact({
      inputPath:"ambiguous.pdf",outputPath:"ambiguous-out.pdf",expectedInputSha256:other.sha256,
      page:1,mode:"replace_exact",targetText:"PRIVATE NOTE",replacementText:"OTHER TEXT",
    },dir)).rejects.toMatchObject({code:"ambiguous_text"});
    await expect(fs.stat(path.join(dir,"ambiguous-out.pdf"))).rejects.toMatchObject({code:"ENOENT"});
  });

  it("refuses redaction when selected source text is also present in metadata", async () => {
    const source=await inspectPdf({inputPath:"metadata-secret.pdf"},dir);
    await expect(editPdfVectorExact({
      inputPath:"metadata-secret.pdf",outputPath:"metadata-redacted.pdf",
      expectedInputSha256:source.sha256,page:1,mode:"redact_exact",
      targetText:"PRIVATE NOTE",confirmRedact:true,
    },dir)).rejects.toMatchObject({code:"metadata_target"});
    await expect(fs.stat(path.join(dir,"metadata-redacted.pdf"))).rejects.toMatchObject({code:"ENOENT"});
  },30000);

  it("refuses redaction on a PDF with an embedded attachment rather than falsely claiming all data was scrubbed", async () => {
    const source=await inspectPdf({inputPath:"attached-secret.pdf"},dir);
    await expect(editPdfVectorExact({
      inputPath:"attached-secret.pdf",outputPath:"attached-redacted.pdf",
      expectedInputSha256:source.sha256,page:1,mode:"redact_exact",
      targetText:"PRIVATE NOTE",confirmRedact:true,
    },dir)).rejects.toMatchObject({code:"unsupported_sensitive_container"});
    await expect(fs.stat(path.join(dir,"attached-redacted.pdf"))).rejects.toMatchObject({code:"ENOENT"});
  },30000);

  it("denies non-ASCII exact replacement and stale source hashes", async () => {
    const base={inputPath:"input.pdf",outputPath:"invalid.pdf",expectedInputSha256:"not-a-real-hash",page:1,mode:"replace_exact",targetText:"PRIVATE NOTE",replacementText:"public"};
    await expect(editPdfVectorExact(base,dir)).rejects.toMatchObject({code:"hash_mismatch"});
    await expect(editPdfVectorExact({...base,replacementText:"Pendidikan – revisi"},dir))
      .rejects.toMatchObject({code:"unsupported_unicode"});
  });
});
