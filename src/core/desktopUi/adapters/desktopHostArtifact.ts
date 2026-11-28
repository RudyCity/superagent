/**
 * desktopHostArtifact.ts — fixed, build-time discovery of the single native
 * Desktop UI host image. Mirrors windowsWgcArtifact.ts: never accepts a caller
 * path, never probes arbitrary directories, and treats an incomplete or
 * mismatched pair as a hard failure (the adapter converts that failure into a
 * silent fallback to the PowerShell carriers).
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopUiError } from "../errors.js";

export const DESKTOP_HOST_BACKEND = "win32-native-desktop-host";

export const DESKTOP_HOST_IMAGE_MIN_BYTES = 16 * 1024;
export const DESKTOP_HOST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const DESKTOP_HOST_DIGEST_MIN_BYTES = 64;
export const DESKTOP_HOST_DIGEST_MAX_BYTES = 80;

/**
 * Source module: <checkout>/src/core/desktopUi/adapters/desktopHostArtifact.ts
 * Built module:  <checkout>/dist/core/desktopUi/adapters/desktopHostArtifact.js
 * Both layouts resolve to the matching dist/native/desktop-host payload.
 */
export function resolveDesktopHostArtifactDirectory(modulePath: string): string {
  const adapterDir = path.dirname(modulePath);
  if (
    path.basename(adapterDir) !== "adapters" ||
    path.basename(path.dirname(adapterDir)) !== "desktopUi" ||
    path.basename(path.dirname(path.dirname(adapterDir))) !== "core"
  ) {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Unexpected Core module layout for the Desktop UI host.");
  }
  const treeRoot = path.resolve(adapterDir, "../../..");
  const treeType = path.basename(treeRoot);
  if (treeType === "dist") return path.join(treeRoot, "native", "desktop-host");
  if (treeType === "src") return path.join(path.dirname(treeRoot), "dist", "native", "desktop-host");
  throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Unknown Desktop UI host module layout.");
}

/**
 * Resolved on first use, never at import: the dist/scripts bundles import this
 * module transitively on startup paths that never touch the host, so an
 * unrecognised bundle layout must only fail closed when it is actually used.
 */
function desktopHostArtifactPaths(): { executable: string; digest: string } {
  const directory = resolveDesktopHostArtifactDirectory(fileURLToPath(import.meta.url));
  return {
    executable: path.join(directory, "desktop-host.exe"),
    digest: path.join(directory, "desktop-host.sha256"),
  };
}

function regularFile(name: string): boolean {
  try {
    const stat = lstatSync(name);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Bundled Desktop UI host artifact is not a regular file.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Verify one fixed executable/digest pair. Returns the executable path when the
 * pair is valid, `null` when neither file exists, and throws when the pair is
 * incomplete, out of bounds, not a Windows x64 PE image or digest-mismatched.
 */
export function verifyDesktopHostArtifactPair(exePath: string, digestPath: string): string | null {
  const exeExists = regularFile(exePath);
  const digestExists = regularFile(digestPath);
  if (!exeExists && !digestExists) return null;
  if (!exeExists || !digestExists) {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Bundled Desktop UI host manifest is incomplete.");
  }
  const digestStat = lstatSync(digestPath);
  const exeStat = lstatSync(exePath);
  if (
    digestStat.size < DESKTOP_HOST_DIGEST_MIN_BYTES ||
    digestStat.size > DESKTOP_HOST_DIGEST_MAX_BYTES ||
    exeStat.size < DESKTOP_HOST_IMAGE_MIN_BYTES ||
    exeStat.size > DESKTOP_HOST_IMAGE_MAX_BYTES
  ) {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Bundled Desktop UI host exceeds size bounds.");
  }
  const expected = readFileSync(digestPath, "ascii").trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Bundled Desktop UI host checksum is invalid.");
  }
  const binary = readFileSync(exePath);
  const peOffset = binary.length > 0x40 ? binary.readUInt32LE(0x3c) : 0;
  if (
    binary.toString("ascii", 0, 2) !== "MZ" ||
    peOffset < 0x40 ||
    peOffset > binary.length - 26 ||
    binary.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000" ||
    binary.readUInt16LE(peOffset + 4) !== 0x8664 ||
    binary.readUInt16LE(peOffset + 24) !== 0x20b
  ) {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Bundled Desktop UI host is not a Windows x64 executable.");
  }
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Bundled Desktop UI host checksum mismatch.");
  }
  return exePath;
}

let cachedArtifact: { resolved: boolean; path: string | null } = { resolved: false, path: null };

/**
 * Locate the verified host for this host platform. Returns `null` when the
 * optional artifact is absent so the adapter keeps its existing carriers.
 * Verification failures propagate; callers that want a silent fallback must
 * catch them (the Windows adapter does).
 */
export function locateVerifiedDesktopHost(): string | null {
  if (process.platform !== "win32") return null;
  if (cachedArtifact.resolved) return cachedArtifact.path;
  const { executable, digest } = desktopHostArtifactPaths();
  const verified = verifyDesktopHostArtifactPair(executable, digest);
  cachedArtifact = { resolved: true, path: verified };
  return verified;
}

/** Test seam: forget the memoized artifact decision. */
export function resetDesktopHostArtifactCache(): void {
  cachedArtifact = { resolved: false, path: null };
}
