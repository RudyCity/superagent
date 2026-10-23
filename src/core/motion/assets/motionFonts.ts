import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { GlobalFonts } from "@napi-rs/canvas";
import { MOTION_BUNDLED_FONT_FAMILIES, MOTION_FONT_FAMILIES } from "../schema/fontCatalog.js";
import { studioStorageRoot } from "../project/projectStore.js";

/**
 * Bundled SIL Open Font License 1.1 font files (see fonts/LICENSES.md).
 * Maps a catalog family name to its file inside src/core/motion/assets/fonts.
 * Exactly one weight per family ships on purpose: the declarative renderer
 * issues `fontSize px "Family"` without a weight, so the file's own weight
 * defines the look.
 */
export const MOTION_FONT_FILES: Readonly<Record<string, string>> = {
  "Inter": "inter-latin-400.ttf",
  "Space Grotesk": "space-grotesk-latin-500.ttf",
  "Montserrat": "montserrat-latin-700.ttf",
  "Poppins": "poppins-latin-600.ttf",
  "Oswald": "oswald-latin-500.ttf",
  "Anton": "anton-latin-400.ttf",
  "Bebas Neue": "bebas-neue-latin-400.ttf",
  "Archivo Black": "archivo-black-latin-400.ttf",
  "Bungee": "bungee-latin-400.ttf",
  "Playfair Display": "playfair-display-latin-700.ttf",
  "Merriweather": "merriweather-latin-400.ttf",
  "JetBrains Mono": "jetbrains-mono-latin-400.ttf",
  "Caveat": "caveat-latin-500.ttf",
  "Press Start 2P": "press-start-2p-latin-400.ttf",
};

const unmapped = MOTION_BUNDLED_FONT_FAMILIES.filter((family) => !MOTION_FONT_FILES[family]);
if (unmapped.length > 0) {
  throw new Error("motionFonts: catalog families without a bundled file: " + unmapped.join(", "));
}

const builtInFontFamilies = new Set<string>(MOTION_FONT_FAMILIES);
const customRegisteredFonts = new Set<string>();

export function isAllowedMotionFont(family: string): boolean {
  return builtInFontFamilies.has(family) || customRegisteredFonts.has(family);
}

export function registerCustomFont(family: string, fontPath: string): boolean {
  if (existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, family);
    customRegisteredFonts.add(family);
    return true;
  }
  return false;
}

let registered = false;

/**
 * Registers every bundled font into the native canvas font registry.
 * Safe to call on every render: the work happens once per process, and a
 * missing file degrades silently to the platform fallback instead of failing
 * the render (e.g. when running from a compiled dist without assets).
 */
export function ensureMotionFontsRegistered(): void {
  if (registered) return;
  registered = true;
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fonts");
  for (const [family, file] of Object.entries(MOTION_FONT_FILES)) {
    const fontPath = join(dir, file);
    if (existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, family);
  }
}

/**
 * Imports a custom TTF or OTF font file into workspace storage and registers
 * it dynamically with the native canvas renderer.
 */
export async function importMotionFont(
  workspace: string,
  familyName: string,
  source: Buffer,
): Promise<{ family: string; bytes: number; path: string }> {
  if (!Buffer.isBuffer(source) || source.length < 12 || source.length > 5 * 1024 * 1024) {
    throw new Error("Invalid Motion font file (max 5 MB TTF/OTF)");
  }
  const name = familyName.trim();
  if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(name)) {
    throw new Error("Invalid font family name (1–64 alphanumeric characters, spaces or hyphens)");
  }
  const tag = source.toString("ascii", 0, 4);
  const isTtf = source.readUInt32BE(0) === 0x00010000 || tag === "OTTO" || tag === "true";
  if (!isTtf) {
    throw new Error("Invalid font format: valid TrueType (.ttf) or OpenType (.otf) required");
  }

  const root = await studioStorageRoot(workspace, true);
  const fontsDir = join(root, "fonts");
  await fs.mkdir(fontsDir, { recursive: true, mode: 0o700 });

  const hash = crypto.createHash("sha256").update(source).digest("hex");
  const fontFile = join(fontsDir, `font-${hash}.ttf`);
  await fs.writeFile(fontFile, source, { mode: 0o600 });

  GlobalFonts.registerFromPath(fontFile, name);
  customRegisteredFonts.add(name);

  return { family: name, bytes: source.length, path: fontFile };
}
