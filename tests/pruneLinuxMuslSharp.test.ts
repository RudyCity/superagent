import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GNU_SHARP_PACKAGES, MUSL_SHARP_PACKAGES, GNU_CANVAS_PACKAGES,
  MUSL_CANVAS_PACKAGES, pruneMuslSharpFromLinuxStandalone,
} from "../scripts/prune-linux-musl-sharp.js";

function withStaging(fn: (root: string, img: string, napi: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-gnu-native-bundle-test-"));
  const img = path.join(root, "node_modules", "@img");
  const napi = path.join(root, "node_modules", "@napi-rs");
  fs.mkdirSync(img, { recursive: true });
  fs.mkdirSync(napi, { recursive: true });
  try { fn(root, img, napi); }
  finally { fs.rmSync(root, { force: true, recursive: true }); }
}
function makePackage(scope: string, name: string) {
  const dest = path.join(scope, name);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "sentinel"), name);
}
function allNative(img: string, napi: string) {
  for (const name of [...GNU_SHARP_PACKAGES, ...MUSL_SHARP_PACKAGES]) makePackage(img, name);
  for (const name of [...GNU_CANVAS_PACKAGES, ...MUSL_CANVAS_PACKAGES]) makePackage(napi, name);
}
const removedNames = [
  ...MUSL_SHARP_PACKAGES.map(name => `@img/${name}`),
  ...MUSL_CANVAS_PACKAGES.map(name => `@napi-rs/${name}`),
];

describe("GNU Linux standalone excludes only incompatible musl native addons", () => {
  it("keeps GNU sharp, libvips, canvas, and unrelated native dependencies", () => withStaging((root, img, napi) => {
    allNative(img, napi);
    makePackage(img, "sharp-linuxmusl-arm64");
    makePackage(napi, "other-native-addon");
    expect(pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toEqual(removedNames);
    for (const name of [...GNU_SHARP_PACKAGES, "sharp-linuxmusl-arm64"])
      expect(fs.existsSync(path.join(img, name, "sentinel"))).toBe(true);
    for (const name of [...GNU_CANVAS_PACKAGES, "other-native-addon"])
      expect(fs.existsSync(path.join(napi, name, "sentinel"))).toBe(true);
    for (const name of MUSL_SHARP_PACKAGES) expect(fs.existsSync(path.join(img, name))).toBe(false);
    for (const name of MUSL_CANVAS_PACKAGES) expect(fs.existsSync(path.join(napi, name))).toBe(false);
    expect(pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toEqual([]);
  }));

  it("leaves macOS and non-x64 platforms untouched", () => withStaging((root, img, napi) => {
    allNative(img, napi);
    expect(pruneMuslSharpFromLinuxStandalone(root, "darwin", "arm64")).toEqual([]);
    expect(pruneMuslSharpFromLinuxStandalone(root, "linux", "arm64")).toEqual([]);
    for (const name of MUSL_SHARP_PACKAGES) expect(fs.existsSync(path.join(img, name))).toBe(true);
    for (const name of MUSL_CANVAS_PACKAGES) expect(fs.existsSync(path.join(napi, name))).toBe(true);
  }));

  it("fails closed if GNU sharp or canvas counterpart is missing", () => withStaging((root, img, napi) => {
    allNative(img, napi);
    fs.rmSync(path.join(napi, GNU_CANVAS_PACKAGES[0]), { recursive: true });
    expect(() => pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toThrow("GNU native dependency missing");
    for (const name of MUSL_SHARP_PACKAGES) expect(fs.existsSync(path.join(img, name))).toBe(true);
    for (const name of MUSL_CANVAS_PACKAGES) expect(fs.existsSync(path.join(napi, name))).toBe(true);
  }));

  it("refuses unexpected paths without removing any other packages", () => withStaging((root, img, napi) => {
    allNative(img, napi);
    fs.rmSync(path.join(napi, MUSL_CANVAS_PACKAGES[0]), { recursive: true });
    fs.writeFileSync(path.join(napi, MUSL_CANVAS_PACKAGES[0]), "unexpected content");
    expect(() => pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toThrow("Unexpected musl native package path");
    expect(fs.existsSync(path.join(img, MUSL_SHARP_PACKAGES[0]))).toBe(true);
  }));

  it("handles a nested dependency's local musl canvas package", () => withStaging((root, img, napi) => {
    allNative(img, napi);
    const nested = path.join(root, "node_modules", "pdfjs-dist", "node_modules", "@napi-rs");
    fs.mkdirSync(nested, { recursive: true });
    for (const name of [...GNU_CANVAS_PACKAGES, ...MUSL_CANVAS_PACKAGES]) makePackage(nested, name);
    const removed = pruneMuslSharpFromLinuxStandalone(root, "linux", "x64");
    expect(removed.filter(x => x === "@napi-rs/canvas-linux-x64-musl")).toHaveLength(2);
    expect(fs.existsSync(path.join(nested, GNU_CANVAS_PACKAGES[0], "sentinel"))).toBe(true);
    expect(fs.existsSync(path.join(nested, MUSL_CANVAS_PACKAGES[0]))).toBe(false);
  }));
});
