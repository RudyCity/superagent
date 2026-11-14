/**
 * Fixed macOS 14+ ScreenCaptureKit artifact lookup. A local operator must
 * explicitly opt in; no user input or IPC can select a helper executable.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopUiError } from "../errors.js";

export const SCK_HELPER_BACKEND = "darwin-sck-exact-cgwindow";

export function resolveMacSckArtifactDirectory(modulePath: string): string {
  const adapterDir = path.dirname(modulePath);
  if (path.basename(adapterDir) !== "adapters" ||
      path.basename(path.dirname(adapterDir)) !== "desktopUi" ||
      path.basename(path.dirname(path.dirname(adapterDir))) !== "core") {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Unknown macOS SCK module path.");
  }
  const root = path.resolve(adapterDir, "../../..");
  if (path.basename(root) === "dist") return path.join(root, "native", "desktop-live-sck");
  if (path.basename(root) === "src") return path.join(path.dirname(root), "dist", "native", "desktop-live-sck");
  throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Unknown macOS SCK artifact layout.");
}

export function verifyMacSckArtifactPair(binary: string, receipt: string): string | null {
  const stat = (file: string) => {
    try {
      const value = lstatSync(file);
      if (!value.isFile() || value.isSymbolicLink())
        throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "macOS SCK artifact is not a regular file.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const binStat = stat(binary);
  const receiptStat = stat(receipt);
  if (!binStat && !receiptStat) return null;
  if (!binStat || !receiptStat || binStat.size < 65536 || binStat.size > 8388608 ||
      receiptStat.size < 64 || receiptStat.size > 80) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Incomplete or oversized macOS SCK bundle.");
  }
  const expected = readFileSync(receipt, "ascii").trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "macOS SCK checksum receipt invalid.");
  }
  const contents = readFileSync(binary);
  // Mach-O 64-bit little-endian arm64, with no universal/FAT fallback.
  if (contents.readUInt32LE(0) !== 0xfeedfacf || contents.readUInt32LE(4) !== 0x0100000c ||
      contents.readUInt32LE(12) !== 2) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "macOS SCK helper must be an ARM64 executable.");
  }
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== expected) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "macOS SCK helper checksum mismatch.");
  }
  return binary;
}

export function locateVerifiedMacSckHelper(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  const dir = resolveMacSckArtifactDirectory(fileURLToPath(import.meta.url));
  return verifyMacSckArtifactPair(path.join(dir, "sck"), path.join(dir, "sck.sha256"));
}
