/**
 * imageUtils.ts — Image handling utilities for Superagent terminal.
 *
 * Provides:
 *  - isImageFilePath()        : detect if a string is a path to an image file
 *  - readImageFromPath()      : read image file → base64 ImagePart
 *  - readImageFromClipboard() : cross-platform clipboard image reader
 *  - ImageAttachment          : UI attachment type used before message submission
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import type { ImagePart } from "../core/conversation.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUPPORTED_IMAGE_EXTENSIONS: ReadonlyArray<string> = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
];

const MIME_MAP: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".bmp":  "image/bmp",
  ".tiff": "image/tiff",
  ".tif":  "image/tiff",
};

// ---------------------------------------------------------------------------
// UI Attachment type (used in app state before building the CoreMessage)
// ---------------------------------------------------------------------------

export interface ImageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  sizeBytes: number;
  sourcePath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw string that may contain surrounding quotes or escape chars
 * (common when terminal pastes a Windows Explorer path).
 */
function normalisePath(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

/**
 * Returns the MIME type for a given file extension, or null if unsupported.
 */
export function mimeForExtension(ext: string): string | null {
  return MIME_MAP[ext.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// isImageFilePath
// ---------------------------------------------------------------------------

/**
 * Returns true when `str` looks like a filesystem path pointing to a supported
 * image file.  Does NOT check if the file actually exists — call
 * `readImageFromPath` for that.
 */
export function isImageFilePath(str: string): boolean {
  const normalised = normalisePath(str);
  const ext = path.extname(normalised).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) return false;

  // Must look like an absolute path or a relative path with directory component
  const isAbsolute = path.isAbsolute(normalised);
  const hasSlash = normalised.includes("/") || normalised.includes("\\");
  return isAbsolute || hasSlash;
}

// ---------------------------------------------------------------------------
// readImageFromPath
// ---------------------------------------------------------------------------

/**
 * Reads an image file from disk and returns an `ImageAttachment`.
 * Throws if the file does not exist, cannot be read, or is not a supported type.
 */
export async function readImageFromPath(filePath: string): Promise<ImageAttachment> {
  const normalised = normalisePath(filePath);
  const ext = path.extname(normalised).toLowerCase();
  const mimeType = mimeForExtension(ext);

  if (!mimeType) {
    throw new Error(`Unsupported image extension: ${ext}`);
  }

  const buf = await fs.readFile(normalised);
  const base64Data = buf.toString("base64");

  return {
    id: crypto.randomUUID(),
    filename: path.basename(normalised),
    mimeType,
    base64Data,
    sizeBytes: buf.byteLength,
    sourcePath: normalised,
  };
}

// ---------------------------------------------------------------------------
// readImageFromClipboard — platform-native implementations
// ---------------------------------------------------------------------------

/**
 * Attempts to read an image from the system clipboard using platform-native
 * tools.  Returns `null` if the clipboard does not contain an image.
 *
 * Platform strategies:
 *  - Windows : PowerShell — [System.Windows.Forms.Clipboard]::GetImage()
 *  - macOS   : `pngpaste` (preferred) or `osascript` fallback
 *  - Linux   : `xclip -t image/png` or `wl-paste --type image/png` (Wayland)
 */
export async function readImageFromClipboard(): Promise<ImageAttachment | null> {
  const platform = process.platform;

  try {
    if (platform === "win32") {
      return await readClipboardWindows();
    } else if (platform === "darwin") {
      return await readClipboardMacOS();
    } else {
      return await readClipboardLinux();
    }
  } catch {
    // Any error means no image in clipboard
    return null;
  }
}

// ── Windows ─────────────────────────────────────────────────────────────────

async function readClipboardWindows(): Promise<ImageAttachment | null> {
  const tmpFile = path.join(os.tmpdir(), `superagent-clip-${Date.now()}.png`);

  // PowerShell script: read clipboard image and save as PNG
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "if ($img -eq $null) { exit 1 };",
    `$img.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "exit 0",
  ].join(" ");

  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], { timeout: 8000 });
  } catch {
    return null;
  }

  try {
    const buf = await fs.readFile(tmpFile);
    await fs.unlink(tmpFile).catch(() => {});
    return {
      id: crypto.randomUUID(),
      filename: "clipboard.png",
      mimeType: "image/png",
      base64Data: buf.toString("base64"),
      sizeBytes: buf.byteLength,
    };
  } catch {
    return null;
  }
}

// ── macOS ────────────────────────────────────────────────────────────────────

async function readClipboardMacOS(): Promise<ImageAttachment | null> {
  const tmpFile = path.join(os.tmpdir(), `superagent-clip-${Date.now()}.png`);

  // Try pngpaste first (brew install pngpaste)
  try {
    await execFileAsync("pngpaste", [tmpFile], { timeout: 5000 });
    const buf = await fs.readFile(tmpFile);
    await fs.unlink(tmpFile).catch(() => {});
    return {
      id: crypto.randomUUID(),
      filename: "clipboard.png",
      mimeType: "image/png",
      base64Data: buf.toString("base64"),
      sizeBytes: buf.byteLength,
    };
  } catch {
    // pngpaste not available or no image — fall through to osascript
  }

  // Fallback: osascript
  const script = [
    "tell application \"System Events\"",
    `  set theFile to POSIX file "${tmpFile}"`,
    "  set theData to the clipboard as «class PNGf»",
    "  set fileRef to open for access theFile with write permission",
    "  write theData to fileRef",
    "  close access fileRef",
    "end tell",
  ].join("\n");

  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 8000 });
    const buf = await fs.readFile(tmpFile);
    await fs.unlink(tmpFile).catch(() => {});
    return {
      id: crypto.randomUUID(),
      filename: "clipboard.png",
      mimeType: "image/png",
      base64Data: buf.toString("base64"),
      sizeBytes: buf.byteLength,
    };
  } catch {
    return null;
  }
}

// ── Linux ────────────────────────────────────────────────────────────────────

async function readClipboardLinux(): Promise<ImageAttachment | null> {
  // Try Wayland first (wl-paste), then X11 (xclip)
  const tmpFile = path.join(os.tmpdir(), `superagent-clip-${Date.now()}.png`);

  // wl-paste (Wayland)
  try {
    const { stdout } = await execFileAsync(
      "wl-paste",
      ["--type", "image/png", "--no-newline"],
      { timeout: 5000, encoding: "buffer" } as any,
    );
    if (stdout && (stdout as Buffer).byteLength > 0) {
      const buf = stdout as unknown as Buffer;
      return {
        id: crypto.randomUUID(),
        filename: "clipboard.png",
        mimeType: "image/png",
        base64Data: buf.toString("base64"),
        sizeBytes: buf.byteLength,
      };
    }
  } catch {
    // wl-paste not available or no image
  }

  // xclip (X11)
  try {
    const { stdout } = await execFileAsync(
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      { timeout: 5000, encoding: "buffer" } as any,
    );
    if (stdout && (stdout as Buffer).byteLength > 0) {
      const buf = stdout as unknown as Buffer;
      return {
        id: crypto.randomUUID(),
        filename: "clipboard.png",
        mimeType: "image/png",
        base64Data: buf.toString("base64"),
        sizeBytes: buf.byteLength,
      };
    }
  } catch {
    // xclip not available or no image
  }

  // xsel (X11 alternative)
  try {
    await execFileAsync(
      "xsel",
      ["--clipboard", "--output"],
      { timeout: 5000 },
    );
    // xsel doesn't support image/png output natively — fall through
  } catch {
    // ignore
  }

  return null;
}

// ---------------------------------------------------------------------------
// Conversion helper
// ---------------------------------------------------------------------------

/**
 * Converts an `ImageAttachment` (UI layer) to an `ImagePart` (core layer).
 */
export function attachmentToImagePart(attachment: ImageAttachment): ImagePart {
  return {
    type: "image",
    image: attachment.base64Data,
    mimeType: attachment.mimeType,
  };
}

/**
 * Format file size for display in terminal UI.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
