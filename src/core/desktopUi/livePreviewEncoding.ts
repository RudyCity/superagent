/**
 * Local-only bounded preview image encoder. Native capture is already
 * authorized and scoped to one window before this file can be invoked.
 * Encoding never writes pixels to disk or opens a network connection.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { DesktopUiError } from "./errors.js";
import { readPngSize } from "./png.js";

export const MAX_PREVIEW_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_JPEG_BYTES = 512 * 1024;
export const MAX_PREVIEW_SOURCE_PIXELS = 16_000_000;

export interface JpegPreviewSettings {
  maxWidth: number;
  quality: number;
}

export function validateJpegSettings(input: { maxWidth?: unknown; quality?: unknown }): JpegPreviewSettings {
  const maxWidth = input.maxWidth ?? 1280;
  const quality = input.quality ?? 65;
  if (!Number.isSafeInteger(maxWidth) || Number(maxWidth) < 320 || Number(maxWidth) > 1920 ||
      !Number.isSafeInteger(quality) || Number(quality) < 40 || Number(quality) > 85) {
    throw new DesktopUiError("INVALID_ACTION", "JPEG settings exceed the bounded local preview policy.");
  }
  return { maxWidth: Number(maxWidth), quality: Number(quality) };
}

export async function encodeJpegPreview(
  source: Uint8Array,
  settings: JpegPreviewSettings,
): Promise<{ format: "jpeg"; jpeg: string; width: number; height: number }> {
  if (source.byteLength < 24 || source.byteLength > MAX_PREVIEW_SOURCE_BYTES) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native screenshot exceeds the preview source limit.");
  }
  const size = readPngSize(source);
  if (size.width > 8192 || size.height > 8192 ||
      size.width * size.height > MAX_PREVIEW_SOURCE_PIXELS) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native screenshot dimensions exceed the preview limit.");
  }

  // Lazy allocation: do not decode large images until the source is validated.
  const image = await loadImage(Buffer.from(source));
  if (image.width !== size.width || image.height !== size.height) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Decoded native screenshot dimensions mismatch.");
  }
  // Detect the characteristic fully black/transparent native capture returned
  // for some protected or GPU-only surfaces instead of showing misleading
  // pixels as a successful capture. An intentionally all-black app may also
  // fail closed; users must choose a different source rather than a
  // desktop-wide fallback that could expose unrelated windows.
  const probe = createCanvas(16, 16);
  const probeContext = probe.getContext("2d");
  probeContext.drawImage(image, 0, 0, 16, 16);
  const pixels = probeContext.getImageData(0, 0, 16, 16).data;
  let containsNonBlack = false;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 8 && (pixels[i] > 5 || pixels[i + 1] > 5 || pixels[i + 2] > 5)) {
      containsNonBlack = true;
      break;
    }
  }
  if (!containsNonBlack) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native capture is black or transparent and cannot be verified.");
  }

  const candidates = [settings.maxWidth, 1024, 768, 560, 400]
    .filter(width => width <= settings.maxWidth)
    .map(width => Math.min(size.width, width))
    .filter((width, index, all) => all.indexOf(width) === index);
  for (const width of candidates) {
    const height = Math.max(1, Math.round(size.height * width / size.width));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    for (const quality of [settings.quality, 55, 42]) {
      const jpeg = await canvas.encode("jpeg", Math.min(settings.quality, quality));
      if (jpeg.byteLength > 0 && jpeg.byteLength <= MAX_PREVIEW_JPEG_BYTES &&
          jpeg[0] === 0xff && jpeg[1] === 0xd8) {
        return { format: "jpeg", jpeg: Buffer.from(jpeg).toString("base64"), width, height };
      }
    }
  }
  throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Compressed native screenshot exceeds the preview limit.");
}
