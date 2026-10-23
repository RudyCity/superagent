/**
 * Smoke test for bundled Studio fonts (src/core/motion/assets/fonts).
 * Registers them into the native canvas font registry, asserts every catalog
 * family produces real metrics (i.e. did not silently fall back), validates a
 * project that uses every bundled family, and renders a contact-sheet PNG.
 *
 * Usage: bun scripts/verify-bundled-fonts.ts [out.png]
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { ensureMotionFontsRegistered } from "../src/core/motion/assets/motionFonts.js";
import { MOTION_BUNDLED_FONT_FAMILIES } from "../src/core/motion/schema/fontCatalog.js";
import { MotionValidationError, validateMotionProject } from "../src/core/motion/schema/validation.js";

const out = process.argv[2] ?? path.join(import.meta.dir, "..", "tmp", "bundled-fonts.png");
const now = new Date().toISOString();
let failures = 0;

ensureMotionFontsRegistered();

// 1) Registry + metrics: a family that silently fell back to the default font
// would still measure > 0, so also compare widths across families.
const probe = createCanvas(64, 32).getContext("2d");
const widths = new Map<string, number>();
for (const family of MOTION_BUNDLED_FONT_FAMILIES) {
  const known = GlobalFonts.has(family);
  probe.font = `64px "${family}"`;
  const width = probe.measureText("SuperAgent Studio 123").width;
  widths.set(family, width);
  if (!known) {
    failures++;
    console.error(`FAIL: ${family} is not registered in the native font registry`);
  }
  console.log(`${family.padEnd(18)} registered=${known} width@64px=${width.toFixed(1)}`);
}
const distinct = new Set(widths.values()).size;
if (distinct < MOTION_BUNDLED_FONT_FAMILIES.length - 2) {
  failures++;
  console.error("FAIL: nearly identical metrics across families; bundled fonts did not load");
}

// 2) Validator accepts a project that uses every bundled family.
const project = {
  schemaVersion: 1,
  id: "font-smoke",
  workspaceRoot: "studio://local",
  name: "Bundled Fonts Smoke",
  revision: 1,
  createdAt: now,
  updatedAt: now,
  composition: {
    width: 1920,
    height: 1080,
    fps: { numerator: 30, denominator: 1 },
    durationFrames: 30,
    background: "#171B28",
    layers: MOTION_BUNDLED_FONT_FAMILIES.map((family, i) => ({
      id: `font-${i}`,
      kind: "text",
      x: 64,
      y: 32 + i * 48,
      width: 1200,
      height: 80,
      rotation: 0,
      opacity: 1,
      fill: "#F7F8FF",
      text: family,
      fontSize: 40,
      fontFamily: family,
      tracks: [],
    })),
  },
};
try {
  validateMotionProject(project);
  console.log(`validator: OK - ${MOTION_BUNDLED_FONT_FAMILIES.length} bundled families accepted`);
} catch (error) {
  failures++;
  if (error instanceof MotionValidationError) console.error("validator FAIL:", error.diagnostics);
  else throw error as Error;
}

// 3) Contact sheet PNG for eyeballing.
const cols = 2;
const rows = Math.ceil(MOTION_BUNDLED_FONT_FAMILIES.length / cols);
const sheet = createCanvas(1280, rows * 104);
const ctx = sheet.getContext("2d");
ctx.fillStyle = "#171B28";
ctx.fillRect(0, 0, 1280, rows * 104);
MOTION_BUNDLED_FONT_FAMILIES.forEach((family, i) => {
  const x = 28 + (i % cols) * 640;
  const y = Math.floor(i / cols) * 104;
  ctx.fillStyle = "#8B93A7";
  ctx.font = '17px "JetBrains Mono"';
  ctx.fillText(family, x, y + 26);
  ctx.fillStyle = "#F7F8FF";
  ctx.font = `38px "${family}"`;
  ctx.fillText("SuperAgent Studio 123", x, y + 70);
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheet.toBuffer("image/png"));
console.log(`contact sheet: ${out}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ALL FONT CHECKS PASSED");
