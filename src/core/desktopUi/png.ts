import { createHash } from "node:crypto";
import { DesktopUiError } from "./errors.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readPngSize(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native screenshot is not a valid PNG.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native screenshot reported invalid dimensions.");
  }
  return { width, height };
}
