/**
 * Canonical SuperAgent Studio font catalog. Browser-safe: no filesystem access.
 *
 * MOTION_SYSTEM_FONT_FAMILIES are platform-safe CSS families that require no
 * bundling. MOTION_BUNDLED_FONT_FAMILIES ship as SIL Open Font License 1.1
 * files in src/core/motion/assets/fonts (attribution in fonts/LICENSES.md) and
 * are registered into the native canvas renderer by assets/motionFonts.ts.
 * Scenes may still only reference names from this catalog; arbitrary or
 * user-supplied font families remain rejected by validation.
 */
export const MOTION_SYSTEM_FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Georgia",
  "Verdana",
  "sans-serif",
  "serif",
  "monospace",
] as const;

export const MOTION_BUNDLED_FONT_FAMILIES = [
  "Inter",
  "Space Grotesk",
  "Montserrat",
  "Poppins",
  "Oswald",
  "Anton",
  "Bebas Neue",
  "Archivo Black",
  "Bungee",
  "Playfair Display",
  "Merriweather",
  "JetBrains Mono",
  "Caveat",
  "Press Start 2P",
] as const;

export const MOTION_FONT_FAMILIES = [
  ...MOTION_SYSTEM_FONT_FAMILIES,
  ...MOTION_BUNDLED_FONT_FAMILIES,
] as const;

export type MotionFontFamily = (typeof MOTION_FONT_FAMILIES)[number];
