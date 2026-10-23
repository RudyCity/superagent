import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts } from "@napi-rs/canvas";
import { MOTION_BUNDLED_FONT_FAMILIES } from "../schema/fontCatalog.js";

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
