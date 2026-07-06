import { createCanvas } from "@napi-rs/canvas";

/**
 * Normalize Windows-style backslash paths to forward slashes so that
 * AI vision models can reliably read paths from rendered PNG images.
 * Example: "C:\\Users\\foo" → "C:/Users/foo"
 */
export function normalizePathsForImage(text: string): string {
  // Match Windows absolute paths (drive letter + colon + backslash)
  // or relative paths with directory components, and convert only their backslashes.
  return text.replace(/([A-Za-z]:\\[^\s"'`<>|]*|(?:\.\.?|[a-zA-Z0-9_.-]+)(?:\\[a-zA-Z0-9_.-]+)+)/g, (match) => {
    return match.replace(/\\/g, "/");
  });
}


/**
 * Slice text into readable pages
 */
export function sliceTextIntoPages(text: string, maxLines = 150, maxPages = 3): string[] {
  const lines = text.split(/\r?\n/);
  const pages: string[] = [];
  
  for (let i = 0; i < lines.length && pages.length < maxPages; i += maxLines) {
    const chunk = lines.slice(i, i + maxLines).join("\n");
    pages.push(chunk);
  }
  
  if (lines.length > maxLines * maxPages) {
    const remaining = lines.length - (maxLines * maxPages);
    pages[pages.length - 1] += `\n\n--- [TRUNCATED - Remaining ${remaining} lines not shown to save context tokens] ---`;
  }
  
  return pages;
}

/**
 * Render a text chunk into a PNG image synchronously and return its base64 data.
 */
export function renderTextToImageBase64(text: string): string {
  // Normalize paths before rendering so AI vision models read them correctly
  const normalized = normalizePathsForImage(text);
  const lines = normalized.split(/\r?\n/);
  const fontSize = 15;
  const lineHeight = 20;
  const padding = 16;

  // Create temporary canvas to measure text
  const tempCanvas = createCanvas(1, 1);
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.font = `${fontSize}px Consolas, Courier New, Courier, monospace`;

  let maxLineWidth = 0;
  for (const line of lines) {
    const width = tempCtx.measureText(line).width;
    if (width > maxLineWidth) {
      maxLineWidth = width;
    }
  }

  const canvasWidth = Math.max(600, Math.ceil(maxLineWidth) + padding * 2);
  const canvasHeight = Math.ceil(lines.length * lineHeight) + padding * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // Draw background (high-contrast white for optimal AI vision/OCR performance)
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw text (high-contrast black for maximum legibility)
  ctx.fillStyle = "rgb(0, 0, 0)";
  ctx.font = `${fontSize}px Consolas, Courier New, Courier, monospace`;
  ctx.textBaseline = "top";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padding, padding + i * lineHeight);
  }

  const pngBuffer = canvas.toBuffer("image/png");
  return pngBuffer.toString("base64");
}
