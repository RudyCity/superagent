import path from "node:path";
import { validateGlobPattern } from "./globPatternGuard.js";

/** Bun-native glob scanning: no fast-glob/micromatch/braces in agent runtime. */
// SuperAgent runs under Bun, but the application keeps Node-compatible
// global TypeScript definitions for the rest of its dependencies.
interface NativeBunGlob {
  match(file: string): boolean;
  scan(options: {
    cwd: string; onlyFiles: boolean; followSymlinks: boolean;
    dot: boolean; absolute: boolean;
  }): AsyncIterable<string>;
}
const BunRuntime = (globalThis as unknown as {
  Bun: { Glob: new (pattern: string) => NativeBunGlob }
}).Bun;
const IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist"]);
const clean = (relative: string): string => relative.replace(/\\/g, "/");

export function createWorkspaceGlobMatcher(pattern: string): (relativeFile: string) => boolean {
  // Compile a pattern only once when filtering a cached file listing.
  const native = new BunRuntime.Glob(validateGlobPattern(pattern));
  return (relativeFile: string): boolean => {
    const normalized = clean(relativeFile);
    return !normalized.split("/").some(part => IGNORED_SEGMENTS.has(part))
      && native.match(normalized);
  };
}

export function matchesWorkspaceGlob(pattern: string, relativeFile: string): boolean {
  return createWorkspaceGlobMatcher(pattern)(relativeFile);
}

export async function scanWorkspaceGlob(
  pattern: string,
  cwd: string,
  absolute = false,
): Promise<string[]> {
  const matcher = new BunRuntime.Glob(validateGlobPattern(pattern));
  const files: string[] = [];
  for await (const file of matcher.scan({
    cwd,
    onlyFiles: true,
    followSymlinks: false,
    dot: false,
    absolute: false,
  })) {
    const normalized = clean(file);
    if (normalized.split("/").some(part => IGNORED_SEGMENTS.has(part))) continue;
    files.push(absolute ? path.resolve(cwd, file) : normalized);
  }
  return files.sort();
}
