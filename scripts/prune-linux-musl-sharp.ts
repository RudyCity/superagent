import fs from "node:fs";
import path from "node:path";

/**
 * A frozen Bun install may retain musl native optional packages alongside GNU
 * packages. linuxdeploy inspects every bundled ELF and fails when it encounters
 * libc.musl-x86_64.so.1 or tries to run ldd on musl-only N-API modules.
 *
 * Keep GNU sharp/libvips and N-API canvas untouched; remove only the explicitly
 * known musl siblings from generated standalone dependencies on Linux x64.
 */
export const GNU_SHARP_PACKAGES = [
  "sharp-linux-x64",
  "sharp-libvips-linux-x64",
] as const;
export const MUSL_SHARP_PACKAGES = [
  "sharp-linuxmusl-x64",
  "sharp-libvips-linuxmusl-x64",
] as const;
export const GNU_CANVAS_PACKAGES = ["canvas-linux-x64-gnu"] as const;
export const MUSL_CANVAS_PACKAGES = ["canvas-linux-x64-musl"] as const;

const combinations = [
  { scope: "@img", gnu: GNU_SHARP_PACKAGES, musl: MUSL_SHARP_PACKAGES },
  { scope: "@napi-rs", gnu: GNU_CANVAS_PACKAGES, musl: MUSL_CANVAS_PACKAGES },
] as const;

function packageDirectories(standaloneRoot: string): string[] {
  const rootModules = path.join(standaloneRoot, "node_modules");
  const result: string[] = [];
  const pending: string[] = [rootModules];
  const visited = new Set<string>();
  while (pending.length) {
    const modules = pending.pop()!;
    if (!fs.existsSync(modules)) continue;
    const real = fs.realpathSync(modules);
    if (visited.has(real)) continue;
    visited.add(real);
    result.push(modules);
    for (const item of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const full = path.join(modules, item.name);
      const packages = item.name.startsWith("@")
        ? fs.readdirSync(full, { withFileTypes: true })
          .filter((child) => child.isDirectory()).map((child) => path.join(full, child.name))
        : [full];
      for (const pkg of packages) {
        const nested = path.join(pkg, "node_modules");
        if (fs.existsSync(nested)) pending.push(nested);
      }
    }
  }
  return result;
}

export function pruneMuslSharpFromLinuxStandalone(
  standaloneRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform !== "linux" || arch !== "x64") return [];
  const modulesRoots = packageDirectories(standaloneRoot);
  const removals: { name: string; absolute: string; directory: boolean }[] = [];
  for (const modules of modulesRoots) {
    for (const group of combinations) {
      const scope = path.join(modules, group.scope);
      if (!fs.existsSync(scope)) continue;
      const muslPresent = group.musl.filter(name => fs.existsSync(path.join(scope, name)));
      if (!muslPresent.length) continue;
      // Resolve all required GNU siblings before performing *any* removal.
      for (const gnu of group.gnu) {
        const required = path.join(scope, gnu);
        if (!fs.existsSync(required) || !fs.statSync(required).isDirectory()) {
          throw new Error("GNU native dependency missing in Linux standalone: " + required);
        }
      }
      for (const name of muslPresent) {
        const absolute = path.join(scope, name);
        const stat = fs.lstatSync(absolute);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          throw new Error("Unexpected musl native package path: " + absolute);
        }
        removals.push({ name: `${group.scope}/${name}`, absolute, directory: stat.isDirectory() });
      }
    }
  }
  for (const item of removals) fs.rmSync(item.absolute, { recursive: item.directory });
  return removals.map(item => item.name);
}
