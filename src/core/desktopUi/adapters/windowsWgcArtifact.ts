/**
 * Fixed, build-time WGC artifact discovery. Never accepts an arbitrary
 * executable path from an HTTP request, WebView, environment variable or
 * model-selected command. A missing helper is compatibility-only; an
 * incomplete/mismatched helper is a hard failure, not a silent fallback.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopUiError } from "../errors.js";

export const WGC_HELPER_BACKEND = "win32-wgc-exact-hwnd";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ARTIFACT_DIRECTORY = path.join(SOURCE_ROOT, "dist", "native", "desktop-live-wgc");
const EXECUTABLE_PATH = path.join(ARTIFACT_DIRECTORY, "wgc.exe");
const DIGEST_PATH = path.join(ARTIFACT_DIRECTORY, "wgc.sha256");

function regularFile(name: string): boolean {
  try {
    const stat = lstatSync(name);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Bundled WGC artifact is not a regular file.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function verifyWindowsWgcArtifactPair(exePath: string, digestPath: string): string | null {
  const exeExists = regularFile(exePath);
  const digestExists = regularFile(digestPath);
  if (!exeExists && !digestExists) return null;
  if (!exeExists || !digestExists) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Bundled WGC helper manifest is incomplete.");
  }
  const digestStat = lstatSync(digestPath);
  const exeStat = lstatSync(exePath);
  if (digestStat.size < 64 || digestStat.size > 80 ||
      exeStat.size < 64 * 1024 || exeStat.size > 2 * 1024 * 1024) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Bundled WGC helper exceeds size bounds.");
  }
  const expected = readFileSync(digestPath, "ascii").trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Bundled WGC checksum is invalid.");
  }
  const binary = readFileSync(exePath);
  const peOffset = binary.length > 0x40 ? binary.readUInt32LE(0x3c) : 0;
  if (binary.toString("ascii", 0, 2) !== "MZ" ||
      peOffset < 0x40 || peOffset > binary.length - 26 ||
      binary.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000" ||
      binary.readUInt16LE(peOffset + 4) !== 0x8664 ||
      binary.readUInt16LE(peOffset + 24) !== 0x20b) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Bundled WGC helper is not a Windows x64 executable.");
  }
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Bundled WGC checksum mismatch.");
  }
  return exePath;
}

export function locateVerifiedWindowsWgcHelper(): string | null {
  if (process.platform !== "win32") return null;
  return verifyWindowsWgcArtifactPair(EXECUTABLE_PATH, DIGEST_PATH);
}
