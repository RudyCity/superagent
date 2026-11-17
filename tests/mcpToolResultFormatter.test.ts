import { describe, expect, it } from "vitest";
import { formatRemoteMcpResult } from "../src/core/mcp/mcpToolResultFormatter.js";

describe("remote MCP response formatter", () => {
  it("keeps ordinary tool output unchanged", () => {
    expect(formatRemoteMcpResult({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });
  it("deduplicates equivalent structured payloads even when text is pretty-printed", () => {
    const reply = { content: [{ type: "text", text: '{\n  "ok": true,\n  "count": 2\n}' }], structuredContent: { ok: true, count: 2 } };
    expect(formatRemoteMcpResult(reply)).toBe(reply.content[0].text);
  });
  it("preserves non-equivalent text and structured data", () => {
    expect(formatRemoteMcpResult({ content: [{ type: "text", text: "Completed" }], structuredContent: { id: 1 } }))
      .toBe('Completed\n{"id":1}');
  });
  it("preserves SDK task-result envelopes that have no content property", () => {
    expect(formatRemoteMcpResult({ toolResult: { status: "pending" } }))
      .toBe('{"toolResult":{"status":"pending"}}');
  });
  it("supports structured-only, image placeholders, and error responses", () => {
    expect(formatRemoteMcpResult({ structuredContent: { status: "ok" } })).toBe('{"status":"ok"}');
    expect(formatRemoteMcpResult({ content: [{ type: "image", mimeType: "image/jpeg" }] }))
      .toContain("binary data unavailable");
    expect(formatRemoteMcpResult({ content: [{ type: "text", text: "denied" }], isError: true }))
      .toBe("MCP tool error: denied");
  });
});
