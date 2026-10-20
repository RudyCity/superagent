import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { motionWorkspaceRoot } from "../project/projectStore.js";
import type { MotionProject } from "../schema/types.js";

const ASSET_RE = /^asset-[a-f0-9]{64}$/;
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_PIXELS = 4_000_000;
export function assertMotionAssetId(id: string): void {
  if (!ASSET_RE.test(id)) throw new Error("Invalid Motion asset ID");
}
async function assetDirectory(workspace: string, create = false): Promise<string> {
  const root = await motionWorkspaceRoot(workspace);
  let current = root;
  for (const part of [".superagent", "motion", "assets"]) {
    current = path.join(current, part);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) throw new Error("Motion asset not found");
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Motion asset storage path");
  }
  return current;
}
export async function readMotionAsset(workspace: string, id: string): Promise<Buffer> {
  assertMotionAssetId(id);
  const file = path.join(await assetDirectory(workspace), id + ".png");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_UPLOAD_BYTES || stat.size < 24) throw new Error("Invalid Motion asset file");
  const bytes = await fs.readFile(file);
  if ("asset-" + crypto.createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("Motion asset checksum mismatch");
  return bytes;
}
/** Check compressed image headers BEFORE decoding to bound decompression allocation. */
function sourceDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid Motion PNG header");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error("Invalid Motion JPEG header");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    throw new Error("Invalid Motion JPEG dimensions");
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.length >= 30) {
    const type = bytes.toString("ascii", 12, 16);
    if (type === "VP8X") return {
      width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3),
    };
    if (type === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (type === "VP8L" && bytes[20] === 0x2f) return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
    throw new Error("Invalid Motion WebP dimensions");
  }
  throw new Error("Unsupported Motion image format (PNG/JPEG/WebP only)");
}
export async function importMotionAsset(workspace: string, source: Buffer): Promise<{ id: string; bytes: number; width: number; height: number }> {
  if (!Buffer.isBuffer(source) || source.length < 24 || source.length > MAX_UPLOAD_BYTES) throw new Error("Invalid Motion image upload size (max 1 MB)");
  const dimensions = sourceDimensions(source);
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 4096 || dimensions.height > 4096 ||
      dimensions.width * dimensions.height > MAX_PIXELS) throw new Error("Motion image dimensions exceed limits");
  const image = await loadImage(source).catch(() => { throw new Error("Invalid Motion image contents"); });
  if (image.width !== dimensions.width || image.height !== dimensions.height) throw new Error("Motion image header mismatch");
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const encoded = canvas.toBuffer("image/png");
  if (encoded.length > MAX_UPLOAD_BYTES) throw new Error("Normalized Motion PNG exceeds 1 MB");
  const id = "asset-" + crypto.createHash("sha256").update(encoded).digest("hex");
  const dir = await assetDirectory(workspace, true);
  const file = path.join(dir, id + ".png");
  try { await fs.writeFile(file, encoded, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readMotionAsset(workspace, id);
    if (!existing.equals(encoded)) throw new Error("Motion asset ID collision");
  }
  return { id, bytes: encoded.length, width: image.width, height: image.height };
}
export async function resolveMotionAssets(workspace: string, project: MotionProject): Promise<Map<string, Buffer>> {
  const ids = [...new Set(project.composition.layers.filter(layer => layer.kind === "image").map(layer => layer.assetId))];
  if (ids.length > 16) throw new Error("Motion project exceeds 16 distinct image assets");
  const values = await Promise.all(ids.map(async id => [id, await readMotionAsset(workspace, id)] as const));
  return new Map(values);
}
