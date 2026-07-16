import { createCanvas } from "@napi-rs/canvas";

/**
 * Normalize Windows-style backslash paths to forward slashes so that
 * AI vision models can reliably read paths from rendered PNG images.
 * Example: "C:\\Users\\foo" → "C:/Users/foo"
 */
export function normalizePathsForImage(text: string): string {
  // Match Windows absolute paths (drive letter + colon + backslash)
  // or relative paths with directory components, and convert only their backslashes.
  return text.replace(/([A-Za-z]:\\[^\s"'`<>|]*|(?:\.\.?|[a-zA-Z0-9_.()\[\]-]+)(?:\\[a-zA-Z0-9_.()\[\]-]+)+)/g, (match) => {
    return match.replace(/\\/g, "/");
  });
}


/**
 * Slice text into readable pages
 */
export function sliceTextIntoPages(text: string, maxLines = 150, maxPages = 100): string[] {
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
 * Minify and compress whitespace/newlines similar to pxpipe
 */
export function minifyTextForImage(text: string): string {
  return text
    // Replace trailing spaces on each line
    .replace(/[ \t]+$/gm, "")
    // Replace multiple consecutive empty lines with a single empty line
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Wrap lines longer than a max character limit.
 * Helps prevent WebP canvas dimension failures (WebP max is 16383px wide)
 * and keeps text legible for AI vision.
 */
export function wrapLongLines(text: string, maxCharsPerLine = 120): string {
  const lines = text.split(/\r?\n/);
  const wrappedLines: string[] = [];

  for (const line of lines) {
    if (line.length <= maxCharsPerLine) {
      wrappedLines.push(line);
    } else {
      let remaining = line;
      while (remaining.length > maxCharsPerLine) {
        let splitIndex = maxCharsPerLine;
        
        // Search backward for word boundaries or common delimiters to split cleanly
        const delimiters = [" ", "\t", ",", ";", "/", "\\", "|"];
        let bestIndex = -1;
        for (const delimiter of delimiters) {
          const idx = remaining.lastIndexOf(delimiter, maxCharsPerLine);
          if (idx > maxCharsPerLine - 25 && idx > bestIndex) {
            bestIndex = idx;
          }
        }
        
        if (bestIndex !== -1) {
          splitIndex = bestIndex + 1; // Include the delimiter on the current line
        }
        
        wrappedLines.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex);
      }
      if (remaining.length > 0) {
        wrappedLines.push(remaining);
      }
    }
  }

  return wrappedLines.join("\n");
}

/**
 * Render a text chunk into a WebP image synchronously and return its base64 data.
 */
export function renderTextToImageBase64(text: string): string {
  // Normalize paths before rendering so AI vision models read them correctly
  const normalized = normalizePathsForImage(text);
  // Wrap long lines to prevent WebP 16383px dimension limits and keep text readable
  const wrapped = wrapLongLines(normalized, 120);
  const lines = wrapped.split(/\r?\n/);
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

  const webpBuffer = canvas.toBuffer("image/webp");
  return webpBuffer.toString("base64");
}
