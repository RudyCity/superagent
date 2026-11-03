/**
 * Decode only structured JSON values from older SQLite chat history rows.
 *
 * Rows may also contain markdown starting with "[" (e.g. "[RMemory] ...")
 * or "{" and must be returned verbatim, without spurious console errors.
 * An invalid JSON-looking payload is also preserved as text: the history
 * endpoint is a reader and must never reinterpret or rewrite user content.
 */
export function parseStoredHistoryContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const leading = content.trimStart();
  // JSON objects start with a quoted key or are empty. Markdown and
  // other bracket-prefixed text must not go through JSON.parse.
  const looksLikeObject = /^\{\s*(?:"|\})/.test(leading);
  // A JSON array may start with an object, nested array, string, number,
  // true / false / null, or be empty.
  const looksLikeArray = /^\[\s*(?:\{|\[|"|-?\d|true\b|false\b|null\b|\])/.test(leading);
  if (!looksLikeObject && !looksLikeArray) return content;
  try {
    const decoded: unknown = JSON.parse(leading);
    return decoded !== null && typeof decoded === "object" ? decoded : content;
  } catch {
    return content;
  }
}
