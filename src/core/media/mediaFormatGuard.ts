/** Strict, bounded signature and OpenXML container validation for local media inputs/outputs.
 * Reject archive bombs and disguised ZIP payloads before Office/Python renders them.
 */
import fs from "node:fs/promises";
import path from "node:path";

const OFFICE_PARTS: Record<string, string> = {
  ".docx": "word/document.xml",
  ".xlsx": "xl/workbook.xml",
  ".pptx": "ppt/presentation.xml",
};
const RASTER_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".tif", ".tiff", ".bmp", ".gif"]);
const MAX_ZIP_ENTRIES = 4000;
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES = 120 * 1024 * 1024;
const MAX_RATIO = 200;

function invalid(code: string, description: string): never {
  throw Object.assign(new Error(description), { code });
}
function prefix(buffer: Buffer, bytes: number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
}
function checkRasterSignature(header: Buffer, ext: string): boolean {
  switch (ext) {
    case ".png": return prefix(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg": return prefix(header, [0xff, 0xd8, 0xff]);
    case ".gif": return header.subarray(0, 6).toString("ascii") === "GIF89a"
      || header.subarray(0, 6).toString("ascii") === "GIF87a";
    case ".bmp": return header.subarray(0, 2).toString("ascii") === "BM";
    case ".tif":
    case ".tiff": return prefix(header, [0x49, 0x49, 0x2a, 0x00])
      || prefix(header, [0x4d, 0x4d, 0x00, 0x2a]);
    case ".webp": return header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP";
    case ".avif": return header.subarray(4, 8).toString("ascii") === "ftyp"
      && (header.subarray(8, 16).toString("ascii").includes("avif")
        || header.subarray(8, 32).toString("ascii").includes("avif"));
    default: return false;
  }
}

/** Read-only central-directory validation. Handles normal ZIP32; ZIP64 deliberately fails closed.
 * ZIP entry bodies are not decompressed. Everything is read with a strict compressed-byte ceiling.
 */
function validateOpenXmlBytes(buffer: Buffer, ext: string): void {
  if (!prefix(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    invalid("invalid_signature", "Office document must start with a ZIP local-file header");
  }
  const min = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let cursor = buffer.length - 22; cursor >= min; cursor--) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + buffer.readUInt16LE(cursor + 20) === buffer.length) {
      eocd = cursor;
      break;
    }
  }
  if (eocd < 0) invalid("invalid_archive", "Office container lacks a valid ZIP end-of-directory");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const count = buffer.readUInt16LE(eocd + 10);
  const countDisk = buffer.readUInt16LE(eocd + 8);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || countDisk !== count) invalid("unsupported_archive", "Multi-disk ZIP containers are unsupported");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalid("unsupported_archive", "ZIP64 containers are not accepted");
  if (count > MAX_ZIP_ENTRIES || count === 0) invalid("archive_limit_exceeded", "Office ZIP entry count exceeds limit");
  if (centralOffset + centralSize !== eocd || centralOffset >= buffer.length) invalid("invalid_archive", "ZIP central-directory bounds are inconsistent");
  const entries = new Set<string>();
  let uncompressedTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) invalid("invalid_archive", "ZIP central directory is truncated");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLen + extraLen + commentLen;
    if (next > eocd || nameLen === 0) invalid("invalid_archive", "Office archive has an invalid central entry");
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    const normalizedName = name.endsWith("/") ? name.slice(0, -1) : name;
    if (name.includes("\0") || name.startsWith("/") || /^(?:[A-Za-z]:|\.\.?(?:\/|$))/.test(name)
      || normalizedName.split("/").some(part => part === ".." || part === "." || !part)) {
      invalid("unsafe_archive", "Office archive contains unsafe entry names");
    }
    if (entries.has(name.toLowerCase())) invalid("unsafe_archive", "Office archive contains duplicate entries");
    entries.add(name.toLowerCase());
    if ((externalAttributes >>> 16 & 0xf000) === 0xa000) invalid("unsafe_archive", "ZIP symlink entries are unsupported");
    if (flags & 0x1 || ![0, 8].includes(method)) invalid("unsupported_archive", "Encrypted or uncommon ZIP methods are unsupported");
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) invalid("unsupported_archive", "ZIP64 entry is unsupported");
    if (uncompressed > MAX_ENTRY_BYTES || (compressed === 0 && uncompressed > 0)
      || (compressed > 0 && uncompressed / compressed > MAX_RATIO)) {
      invalid("archive_limit_exceeded", "Office archive entry exceeds its decompression budget");
    }
    uncompressedTotal += uncompressed;
    if (uncompressedTotal > MAX_UNCOMPRESSED) invalid("archive_limit_exceeded", "Office archive exceeds 500 MiB uncompressed");
    if (localOffset + 30 >= centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      invalid("invalid_archive", "ZIP entry points outside its local file region");
    }
    cursor = next;
  }
  if (cursor !== eocd) invalid("invalid_archive", "ZIP central directory entry count mismatch");
  const required = OFFICE_PARTS[ext];
  if (!entries.has("[content_types].xml") || !entries.has(required)) {
    invalid("invalid_office_document", "OpenXML container lacks required " + ext + " document parts");
  }
  if ([...entries].some(name => name.endsWith("vbaproject.bin") || name.includes("/externallinks/"))) {
    invalid("unsupported_office_features", "Macro or external link artifacts are not eligible for local conversion");
  }
}

export async function inspectMediaFormat(file: string, maximumSize = 100 * 1024 * 1024): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (!RASTER_TYPES.has(ext) && !Object.hasOwn(OFFICE_PARTS, ext)
    && ![".pdf", ".csv", ".tsv"].includes(ext)) invalid("unsupported_format", "Unsupported media extension: " + ext);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > maximumSize) invalid("input_invalid", "Media file size is empty or exceeds its bounded limit");
  const handle = await fs.open(file, "r");
  let header: Buffer;
  try {
    header = Buffer.alloc(32);
    await handle.read(header, 0, 32, 0);
  } finally { await handle.close(); }
  if (RASTER_TYPES.has(ext)) {
    if (!checkRasterSignature(header, ext)) invalid("invalid_signature", "Raster signature does not match declared extension");
  } else if (ext === ".pdf") {
    if (!prefix(header, [0x25, 0x50, 0x44, 0x46, 0x2d])) invalid("invalid_signature", "Invalid PDF header");
  } else if (Object.hasOwn(OFFICE_PARTS, ext)) {
    validateOpenXmlBytes(await fs.readFile(file), ext);
  } else {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      const decoded = decoder.decode(await fs.readFile(file));
      if (decoded.includes("\0")) invalid("invalid_text", "Delimited text file contains NUL bytes");
    } catch (error) {
      if ((error as { code?: string }).code === "invalid_text") throw error;
      invalid("invalid_text", "Delimited text must contain valid UTF-8");
    }
  }
  return ext;
}
