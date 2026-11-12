import fs from "node:fs";
import path from "node:path";

/**
 * Bun's frozen production install may retain optional native libraries for
 * other architectures/libcs. linuxdeploy scans EVERY ELF under the AppDir,
 * including unused musl addons, and aborts when ldd cannot load them.
 *
 * Keep GNU Linux x64 variants of sharp, libvips, canvas and tokenizers.
 * Prune only explicit incompatible variants inside generated standalone
 * node_modules. Never mutate source dependencies or other target platforms.
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
export const GNU_TOKENIZERS_BINARY = "tokenizers.linux-x64-gnu.node";

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

interface Removal {
  name: string;
  absolute: string;
  directory: boolean;
}

export function pruneMuslSharpFromLinuxStandalone(
  standaloneRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform !== "linux" || arch !== "x64") return [];
  const modulesRoots = packageDirectories(standaloneRoot);
  const removals: Removal[] = [];
  for (const modules of modulesRoots) {
    for (const group of combinations) {
      const scope = path.join(modules, group.scope);
      if (!fs.existsSync(scope)) continue;
      const muslPresent = group.musl.filter(name => fs.existsSync(path.join(scope, name)));
      if (!muslPresent.length) continue;
      // Validate every required GNU sibling before scheduling any removal.
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

    // tokenizers ships native N-API binaries for *13* platforms in one package.
    // All incompatible variants are unused on GNU x64, but linuxdeploy runs
    // ldd on them anyway, including tokenizers.linux-x64-musl.node.
    const tokenizers = path.join(modules, "tokenizers");
    if (fs.existsSync(tokenizers)) {
      if (!fs.statSync(tokenizers).isDirectory()) {
        throw new Error("Unexpected tokenizers package path: " + tokenizers);
      }
      const natives = fs.readdirSync(tokenizers, { withFileTypes: true })
        .filter(entry => /^tokenizers\.[a-z0-9-]+\.node$/.test(entry.name));
      const required = path.join(tokenizers, GNU_TOKENIZERS_BINARY);
      if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
        throw new Error("GNU tokenizers native binary missing in Linux standalone: " + required);
      }
      for (const entry of natives) {
        if (entry.name === GNU_TOKENIZERS_BINARY) continue;
        if (!entry.isFile()) {
          throw new Error("Unexpected native tokenizers file type: " + entry.name);
        }
        removals.push({
          name: "tokenizers/" + entry.name,
          absolute: path.join(tokenizers, entry.name),
          directory: false,
        });
      }
    }
  }
  // This two-phase plan ensures a bad dependency cannot partially prune the bundle.
  for (const item of removals) fs.rmSync(item.absolute, { recursive: item.directory });
  return removals.map(item => item.name);
}
