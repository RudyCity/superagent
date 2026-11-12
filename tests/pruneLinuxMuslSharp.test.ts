import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GNU_SHARP_PACKAGES, MUSL_SHARP_PACKAGES, pruneMuslSharpFromLinuxStandalone,
} from "../scripts/prune-linux-musl-sharp.js";

function withStaging(fn: (root: string, modules: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-sharp-bundle-test-"));
  const modules = path.join(root, "node_modules", "@img");
  fs.mkdirSync(modules, { recursive: true });
  try { fn(root, modules); }
  finally { fs.rmSync(root, { force: true, recursive: true }); }
}
function makePackage(modules: string, name: string) {
  const dest = path.join(modules, name);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "sentinel"), name);
}

describe("GNU Linux standalone excludes only the incompatible musl sharp optionals", () => {
  it("keeps both GNU packages and all unrelated native dependencies", () => withStaging((root, modules) => {
    for (const name of [...GNU_SHARP_PACKAGES, ...MUSL_SHARP_PACKAGES, "sharp-linuxmusl-arm64", "unrelated-native-addon"]) makePackage(modules, name);
    expect(pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toEqual([...MUSL_SHARP_PACKAGES]);
    for (const name of [...GNU_SHARP_PACKAGES, "sharp-linuxmusl-arm64", "unrelated-native-addon"])
      expect(fs.existsSync(path.join(modules, name, "sentinel"))).toBe(true);
    for (const name of MUSL_SHARP_PACKAGES) expect(fs.existsSync(path.join(modules, name))).toBe(false);
    expect(pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toEqual([]);
  }));

  it("leaves macOS and non-x64 platforms untouched", () => withStaging((root, modules) => {
    for (const name of MUSL_SHARP_PACKAGES) makePackage(modules, name);
    expect(pruneMuslSharpFromLinuxStandalone(root, "darwin", "arm64")).toEqual([]);
    expect(pruneMuslSharpFromLinuxStandalone(root, "linux", "arm64")).toEqual([]);
    for (const name of MUSL_SHARP_PACKAGES) expect(fs.existsSync(path.join(modules, name))).toBe(true);
  }));

  it("fails closed without GNU sharp rather than removing optional files", () => withStaging((root, modules) => {
    for (const name of MUSL_SHARP_PACKAGES) makePackage(modules, name);
    expect(() => pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toThrow("GNU sharp dependency missing");
    for (const name of MUSL_SHARP_PACKAGES) expect(fs.existsSync(path.join(modules, name))).toBe(true);
  }));

  it("does not delete files unexpectedly placed at the musl package directory path", () => withStaging((root, modules) => {
    for (const name of GNU_SHARP_PACKAGES) makePackage(modules, name);
    fs.writeFileSync(path.join(modules, MUSL_SHARP_PACKAGES[0]), "unexpected content");
    expect(() => pruneMuslSharpFromLinuxStandalone(root, "linux", "x64")).toThrow("Unexpected musl sharp package path");
    expect(fs.existsSync(path.join(modules, MUSL_SHARP_PACKAGES[0]))).toBe(true);
  }));
});
