/**
 * Deterministic Chrome PNG icons generated from a single original vector.
 * Run from the repository root: node chrome-extension-chatgpt-lite/generate-icons.mjs
 */
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const directory = dirname(fileURLToPath(import.meta.url));
const svg = await readFile(join(directory, "icons", "icon.svg"));
await mkdir(join(directory, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(svg, { density: 288 })
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(join(directory, "icons", `icon-${size}.png`));
  console.log(`Generated icons/icon-${size}.png`);
}
