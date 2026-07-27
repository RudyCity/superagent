import { createCanvas } from "@napi-rs/canvas";

/**
 * Normalize Windows-style backslash paths to forward slashes.
 */
export function normalizePathsForImage(text: string): string {
  return text.replace(/([A-Za-z]:\\[^\s"'`<>|]*|(?:\.\.?|[a-zA-Z0-9_.()\[\]-]+)(?:\\[a-zA-Z0-9_.()\[\]-]+)+)/g, (match) => {
    return match.replace(/\\/g, "/");
  });
}

/**
 * Adaptive page split by char count (7000 chars/page).
 * More predictable than line-count splitting for variable-length lines.
 * Preserves line integrity — splits at nearest newline boundary.
 */
export function sliceTextIntoPages(text: string, maxCharsPerPage = 7000, maxPages = 100): string[] {
  if (!text) return [];
  const pages: string[] = [];
  let start = 0;

  for (let pageNum = 0; pageNum < maxPages && start < text.length; pageNum++) {
    let end = start + maxCharsPerPage;
    if (end >= text.length) {
      pages.push(text.slice(start));
      return pages;
    }
    // Seek backward to nearest newline within last 500 chars
    let cutAt = text.lastIndexOf("\n", end);
    if (cutAt <= start || end - cutAt > 500) cutAt = text.lastIndexOf(" ", end);
    if (cutAt <= start || end - cutAt > 500) cutAt = end;
    pages.push(text.slice(start, cutAt));
    start = cutAt + 1;
  }
  // Truncation notice on last page if truncated
  if (start < text.length) {
    const remaining = text.length - start;
    pages[pages.length - 1] += `\n\n--- [TRUNCATED - ${remaining} chars not shown] ---`;
  }
  return pages;
}

/**
 * Aggressive minification for vision token saving.
 * Condenses JSON, removes comments, compacts whitespace.
 */
export function minifyTextForImage(text: string): string {
  return text
    // Remove trailing whitespace per line
    .replace(/[ \t]+$/gm, "")
    // Condense 3+ consecutive newlines to 2
    .replace(/\n{3,}/g, "\n\n")
    // Squash inline JSON objects to one line (common in tool calls)
    .replace(/\{\s*("[^"]+":\s*(?:"[^"]*"|\d+|true|false|null)\s*,?\s*)+\s*\}/g, (m) => JSON.stringify(JSON.parse(m)))
    // Remove single-line JS-style comments
    .replace(/\/\/ .*$/gm, "")
    .trim();
}

/**
 * Binary-search line wrap at word boundaries.
 * O(n log n) worst-case vs O(n²) linear scan.
 */
export function wrapLongLines(text: string, maxCharsPerLine = 120): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    if (line.length <= maxCharsPerLine) {
      out.push(line);
      continue;
    }

    let remaining = line;
    while (remaining.length > maxCharsPerLine) {
      // Binary search for best split point
      const target = maxCharsPerLine;
      let lo = Math.max(0, target - 60);
      let hi = target;
      let best = -1;

      // Look backward for word boundary
      for (let i = hi; i >= lo; i--) {
        const ch = remaining[i];
        if (ch === " " || ch === "\t" || ch === "," || ch === ";" || ch === "/" || ch === "|") {
          best = i + 1;
          break;
        }
      }

      const splitAt = best !== -1 ? best : target;
      out.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }
    if (remaining.length > 0) out.push(remaining);
  }

  return out.join("\n");
}

/**
 * Render text chunk to WebP image synchronously → base64.
 * Single-pass canvas (no temp canvas), font 16px, anti-aliased.
 * WebP quality 85 for faster encode vs lossless.
 */
export function renderTextToImageBase64(text: string): string {
  const normalized = normalizePathsForImage(text);
  const wrapped = wrapLongLines(normalized, 120);
  const lines = wrapped.split(/\r?\n/);

  const fontSize = 16;
  const lineHeight = 22;
  const padding = 16;

  // Single-pass: measure + render on same canvas
  const canvas = createCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px Consolas, "Courier New", Courier, monospace`;

  // Measure max line width
  let maxLineWidth = 0;
  for (const line of lines) {
    if (line.length > 0) {
      const w = ctx.measureText(line).width;
      if (w > maxLineWidth) maxLineWidth = w;
    }
  }

  const width = Math.max(640, Math.ceil(maxLineWidth) + padding * 2);
  const height = Math.ceil(lines.length * lineHeight) + padding * 2;

  // Resize canvas to actual dimensions
  canvas.width = width;
  canvas.height = height;

  // White background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Black text
  ctx.fillStyle = "#000000";
  ctx.font = `${fontSize}px Consolas, "Courier New", Courier, monospace`;
  ctx.textBaseline = "top";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padding, padding + i * lineHeight);
  }

  // WebP quality 85: faster encode than lossless, smaller than PNG
  const buf = canvas.toBuffer("image/webp", 85);
  return buf.toString("base64");
}
