import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { inspectMediaFormat } from "../src/core/media/mediaFormatGuard.js";
import { mediaConvert, mediaInspect, mediaTransform } from "../src/core/media/mediaEngine.js";

const roots: string[] = [];
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-format-guard-"));
  roots.push(root);
  return root;
}
async function makeDocx(extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types />");
  zip.file("word/document.xml", "<document />");
  for (const [name, body] of Object.entries(extra)) zip.file(name, body);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}
afterAll(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }).catch(() => {})));
});
describe("Media archive and output security", () => {
  it("accepts a minimal OpenXML document, including ZIP directory entries", async () => {
    const cwd = await setup();
    const file = path.join(cwd, "ok.docx");
    await fs.writeFile(file, await makeDocx({ "word/media/a.png": "data" }));
    expect(await inspectMediaFormat(file)).toBe(".docx");
  });
  it("rejects a renamed generic ZIP with no corresponding Office document part", async () => {
    const cwd = await setup();
    const zip = new JSZip();
    zip.file("readme.txt", "I am not a document");
    const file = path.join(cwd, "fake.docx");
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(mediaInspect({ inputPath: "fake.docx" }, cwd)).rejects.toMatchObject({ code: "invalid_office_document" });
  });
  it("rejects malformed archives that only copy the ZIP header", async () => {
    const cwd = await setup();
    const file = path.join(cwd, "fake.xlsx");
    await fs.writeFile(file, Buffer.from("504b030400000000", "hex"));
    await expect(inspectMediaFormat(file)).rejects.toMatchObject({ code: "invalid_archive" });
  });
  it("rejects compressed Office ZIP bombs before passing them to a backend", async () => {
    const cwd = await setup();
    const file = path.join(cwd, "bomb.docx");
    await fs.writeFile(file, await makeDocx({ "word/media/huge.txt": "Z".repeat(3_000_000) }));
    await expect(mediaInspect({ inputPath: "bomb.docx" }, cwd)).rejects.toMatchObject({ code: "archive_limit_exceeded" });
  });
  it("rejects active external link artifact in Office container", async () => {
    const cwd = await setup();
    const file = path.join(cwd, "links.docx");
    await fs.writeFile(file, await makeDocx({ "word/externalLinks/link1.xml": "<link />" }));
    await expect(inspectMediaFormat(file)).rejects.toMatchObject({ code: "unsupported_office_features" });
  });
  it("rejects disguised raster extensions", async () => {
    const cwd = await setup();
    await sharp({ create: { width: 12, height: 12, channels: 3, background: "#ffffff" } }).png().toFile(path.join(cwd, "real.png"));
    await fs.copyFile(path.join(cwd, "real.png"), path.join(cwd, "fake.jpg"));
    await expect(mediaInspect({ inputPath: "fake.jpg" }, cwd)).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(mediaTransform({ inputPath: "fake.jpg", outputPath: "out.webp", operation: "convert" }, cwd)).rejects.toMatchObject({ code: "invalid_signature" });
  });
  it("rejects NUL binary and unknown input extensions", async () => {
    const cwd = await setup();
    await fs.writeFile(path.join(cwd, "binary.csv"), Buffer.from("612c620000000000", "hex"));
    await fs.writeFile(path.join(cwd, "payload.exe"), Buffer.from("4d5a11223344", "hex"));
    await expect(mediaConvert({ inputPath: "binary.csv", outputPath: "table.xlsx" }, cwd)).rejects.toMatchObject({ code: "invalid_text" });
    await expect(mediaInspect({ inputPath: "payload.exe" }, cwd)).rejects.toMatchObject({ code: "unsupported_format" });
  });
  it("prevents output promotion after an invalid path or backend output", async () => {
    const cwd = await setup();
    await fs.writeFile(path.join(cwd, "nonimage.png"), Buffer.from("PK-not-image"));
    await expect(mediaConvert({ inputPath: "nonimage.png", outputPath: "result.pdf" }, cwd)).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(fs.stat(path.join(cwd, "result.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
