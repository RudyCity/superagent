/** Formats provider MCP replies without double-counting equivalent text and structured data. */
function isEquivalentJsonText(text: string, structured: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(structured);
  } catch {
    return false;
  }
}

export function formatRemoteMcpResult(value: unknown): string {
  const response = value && typeof value === "object"
    ? value as { content?: readonly unknown[]; structuredContent?: unknown; isError?: boolean }
    : {};
  const rendered = Array.isArray(response.content)
    ? response.content.map((item: unknown) => {
        if (!item || typeof item !== "object") return JSON.stringify(item);
        const block = item as { type?: string; text?: string; mimeType?: string };
        if (block.type === "text") return block.text || "";
        if (block.type === "image") {
          return "[Image Content (" + (block.mimeType || "image/png") + "); binary data unavailable in text-only tool adapter]";
        }
        return JSON.stringify(item);
      }).join("\n")
    : "";
  const structured = response.structuredContent === undefined
    ? "" : JSON.stringify(response.structuredContent);
  const extraStructured = structured && !isEquivalentJsonText(rendered.trim(), response.structuredContent)
    ? structured : "";
  const text = [rendered, extraStructured].filter(Boolean).join("\n");
  return response.isError ? "MCP tool error: " + text : text || JSON.stringify(value);
}
