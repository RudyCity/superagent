/**
 * imageUtils.ts — Image handling utilities for Superagent terminal.
 *
 * Provides:
 *  - isImageFilePath()        : detect if a string is a path to an image file
 *  - readImageFromPath()      : read image file → base64 ImagePart
 *  - readImageFromClipboard() : cross-platform clipboard image reader
 *  - ImageAttachment          : UI attachment type used before message submission
 */
import type { ImagePart } from "../core/conversation.js";
export declare const SUPPORTED_IMAGE_EXTENSIONS: ReadonlyArray<string>;
export interface ImageAttachment {
    id: string;
    filename: string;
    mimeType: string;
    base64Data: string;
    sizeBytes: number;
    sourcePath?: string;
}
/**
 * Returns the MIME type for a given file extension, or null if unsupported.
 */
export declare function mimeForExtension(ext: string): string | null;
/**
 * Returns true when `str` looks like a filesystem path pointing to a supported
 * image file.  Does NOT check if the file actually exists — call
 * `readImageFromPath` for that.
 */
export declare function isImageFilePath(str: string): boolean;
/**
 * Reads an image file from disk and returns an `ImageAttachment`.
 * Throws if the file does not exist, cannot be read, or is not a supported type.
 */
export declare function readImageFromPath(filePath: string): Promise<ImageAttachment>;
/**
 * Attempts to read an image from the system clipboard using platform-native
 * tools.  Returns `null` if the clipboard does not contain an image.
 *
 * Platform strategies:
 *  - Windows : PowerShell — [System.Windows.Forms.Clipboard]::GetImage()
 *  - macOS   : `pngpaste` (preferred) or `osascript` fallback
 *  - Linux   : `xclip -t image/png` or `wl-paste --type image/png` (Wayland)
 */
export declare function readImageFromClipboard(): Promise<ImageAttachment | null>;
/**
 * Converts an `ImageAttachment` (UI layer) to an `ImagePart` (core layer).
 */
export declare function attachmentToImagePart(attachment: ImageAttachment): ImagePart;
/**
 * Format file size for display in terminal UI.
 */
export declare function formatFileSize(bytes: number): string;
//# sourceMappingURL=imageUtils.d.ts.map