import { createCanvas } from "@napi-rs/canvas";


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
  const lines = text.split(/\r?\n/);
  const fontSize = 14;
  const lineHeight = 18;
  const padding = 15;

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

  // Draw background
  ctx.fillStyle = "rgb(30, 30, 30)";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw text
  ctx.fillStyle = "rgb(220, 220, 220)";
  ctx.font = `${fontSize}px Consolas, Courier New, Courier, monospace`;
  ctx.textBaseline = "top";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padding, padding + i * lineHeight);
  }

  const pngBuffer = canvas.toBuffer("image/png");
  return pngBuffer.toString("base64");
}
