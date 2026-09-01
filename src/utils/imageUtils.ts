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

/**
 * Validates if a base64 string actually represents valid image binary data.
 * Protects against treating mock data, code fixtures, or short stubs (e.g. "data:image/png;base64,fake-qr")
 * as real images which would cause 400 Bad Request errors from LLM APIs.
 */
export function isValidBase64Image(base64Data: string, mimeType?: string): boolean {
  if (!base64Data || typeof base64Data !== "string") return false;
  const clean = base64Data.replace(/\s+/g, "");
  // Minimum length check: Real images are at least ~64 base64 chars
  if (clean.length < 64) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return false;

  try {
    const buffer = Buffer.from(clean.slice(0, 64), "base64");
    if (buffer.length < 4) return false;

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return true;
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return true;
    }
    // GIF: 47 49 46 (GIF87a or GIF89a)
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return true;
    }
    // WebP: RIFF ... WEBP
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    ) {
      const fullHeader = Buffer.from(clean.slice(0, 32), "base64").toString("ascii");
      if (fullHeader.includes("WEBP")) {
        return true;
      }
    }
    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return true;
    }
    // SVG: <svg or <?xml
    const asciiPrefix = buffer.toString("utf8").trimStart().toLowerCase();
    if (asciiPrefix.startsWith("<svg") || asciiPrefix.startsWith("<?xml")) {
      return true;
    }

    if (mimeType && (mimeType.includes("icon") || mimeType.includes("tiff") || mimeType.includes("heic"))) {
      return buffer.length >= 16;
    }
  } catch {
    return false;
  }

  return false;
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
  const safeTmpFile = tmpFile.replace(/'/g, "''");

  // PowerShell script: read clipboard image or file drop list
  // MUST use -sta (Single-Threaded Apartment) mode for System.Windows.Forms.Clipboard
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "if ([System.Windows.Forms.Clipboard]::ContainsImage()) {",
    "  $img = [System.Windows.Forms.Clipboard]::GetImage();",
    `  $img.Save('${safeTmpFile}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "  Write-Output 'SAVED_RAW';",
    "  exit 0;",
    "}",
    "if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {",
    "  $files = [System.Windows.Forms.Clipboard]::GetFileDropList();",
    "  if ($files.Count -gt 0) {",
    "    $file = $files[0];",
    "    $ext = [System.IO.Path]::GetExtension($file).ToLower();",
    "    if ($ext -eq '.png' -or $ext -eq '.jpg' -or $ext -eq '.jpeg' -or $ext -eq '.gif' -or $ext -eq '.webp' -or $ext -eq '.bmp' -or $ext -eq '.tiff' -or $ext -eq '.tif') {",
    "      Write-Output \"FILE:$file\";",
    "      exit 0;",
    "    }",
    "  }",
    "}",
    "exit 1;",
  ].join(" ");

  let result = "";
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-sta", "-NoProfile", "-NonInteractive", "-Command", script,
    ], { timeout: 8000 });
    result = stdout.trim();
  } catch {
    return null;
  }

  if (result === "SAVED_RAW") {
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
  } else if (result.startsWith("FILE:")) {
    const filePath = result.slice(5);
    try {
      return await readImageFromPath(filePath);
    } catch {
      return null;
    }
  }

  return null;
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
