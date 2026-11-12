import fs from "node:fs";
import path from "node:path";

/**
 * A Bun frozen production install can retain both GNU and musl optional sharp
 * variants.  linuxdeploy scans every ELF under the AppDir, then fails when it
 * sees musl's libc.musl-x86_64.so.1 in a GNU/Linux standalone bundle.
 *
 * Keep GNU sharp and libvips intact, and remove ONLY their incompatible musl
 * counterparts from the generated Linux x64 standalone staging directory.
 * macOS, Windows and source node_modules must never be modified.
 */
export const GNU_SHARP_PACKAGES = [
  "sharp-linux-x64",
  "sharp-libvips-linux-x64",
] as const;
export const MUSL_SHARP_PACKAGES = [
  "sharp-linuxmusl-x64",
  "sharp-libvips-linuxmusl-x64",
] as const;

export function pruneMuslSharpFromLinuxStandalone(
  standaloneRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform !== "linux" || arch !== "x64") return [];
  const modules = path.join(standaloneRoot, "node_modules", "@img");
  for (const name of GNU_SHARP_PACKAGES) {
    const required = path.join(modules, name);
    if (!fs.existsSync(required) || !fs.statSync(required).isDirectory()) {
      throw new Error("GNU sharp dependency missing in Linux standalone: " + name);
    }
  }

  const removed: string[] = [];
  for (const name of MUSL_SHARP_PACKAGES) {
    const incompatible = path.join(modules, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(incompatible); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error("Unexpected musl sharp package path: " + incompatible);
    }
    fs.rmSync(incompatible, { recursive: stat.isDirectory() });
    removed.push(name);
  }
  return removed;
}
