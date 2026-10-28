import { describe, it, expect } from "bun:test";
import {
  sanitizeActivityOutput,
  sanitizeActivityError,
  sanitizeActivityArgs,
  serializeBoundedJournalEntry,
  detectBase64Media,
  MAX_ACTIVITY_OUTPUT_PREVIEW,
  MAX_ACTIVITY_ERROR_PREVIEW,
  MAX_ACTIVITY_ARGS_PREVIEW,
  MAX_ACTIVITY_RECORD_BYTES,
} from "../src/core/mcp/mcpLogSanitizer.js";

describe("MCP Activity Payload Bounds (M1)", () => {
  it("preserves 10 KB normal output without truncation and computes sha256", () => {
    const text = "A".repeat(10 * 1024);
    const { preview, meta } = sanitizeActivityOutput(text, "cmd_123");

    expect(meta.originalBytes).toBe(10 * 1024);
    expect(meta.truncated).toBe(false);
    expect(meta.sha256).toHaveLength(64);
    expect(meta.artifactRef).toBe("cmd_123");
    expect(preview).toBe(text);
  });

  it("bounds a 1 MB output to configured MAX_ACTIVITY_OUTPUT_PREVIEW (16 KB)", () => {
    const text = "B".repeat(1024 * 1024);
    const { preview, meta } = sanitizeActivityOutput(text);

    expect(meta.originalBytes).toBe(1024 * 1024);
    expect(meta.truncated).toBe(true);
    expect(meta.sha256).toHaveLength(64);
    expect(preview.length).toBeLessThan(MAX_ACTIVITY_OUTPUT_PREVIEW + 200);
    expect(preview).toContain("output truncated");
  });

  it("handles a synthetic 100 MB output safely without crashing or leaking full output", () => {
    // Generate 100 MB string in chunks
    const chunk = "X".repeat(1024 * 1024);
    const parts: string[] = [];
    for (let i = 0; i < 100; i++) parts.push(chunk);
    const hugeText = parts.join("");

    const { preview, meta } = sanitizeActivityOutput(hugeText);

    expect(meta.originalBytes).toBe(100 * 1024 * 1024);
    expect(meta.truncated).toBe(true);
    expect(meta.sha256).toHaveLength(64);
    expect(preview.length).toBeLessThan(MAX_ACTIVITY_OUTPUT_PREVIEW + 200);
  });

  it("detects and redacts raw base64 and data URI media payloads", () => {
    // Data URI image
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const dataUri = `data:image/png;base64,${fakeBase64.repeat(20)}`;
    const result1 = sanitizeActivityOutput(dataUri);

    expect(result1.meta.truncated).toBe(true);
    expect(result1.preview).toContain("[base64 media:");
    expect(result1.preview).toContain("mime=image/png");
    expect(result1.preview).not.toContain("iVBORw0KGgoAAAANSUhEUg");

    // Pure raw base64 payload starting with known image prefix (PNG: iVBORw0KGgo)
    const rawB64 = "iVBORw0KGgo" + "A".repeat(1000) + "==";
    expect(detectBase64Media(rawB64).isMedia).toBe(true);
    const result2 = sanitizeActivityOutput(rawB64);
    expect(result2.meta.truncated).toBe(true);
    expect(result2.preview).toContain("[base64 media:");
    expect(result2.preview).not.toContain(rawB64);
  });

  it("bounds huge error messages to MAX_ACTIVITY_ERROR_PREVIEW", () => {
    const hugeError = "E".repeat(500_000);
    const sanitized = sanitizeActivityError(hugeError);

    expect(sanitized.length).toBeLessThan(MAX_ACTIVITY_ERROR_PREVIEW + 100);
    expect(sanitized).toContain("error truncated");
  });

  it("bounds oversized arguments to MAX_ACTIVITY_ARGS_PREVIEW", () => {
    // Construct args whose sanitized JSON exceeds MAX_ACTIVITY_ARGS_PREVIEW
    const hugeArgs: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      hugeArgs[`prop_${i.toString().padStart(4, "0")}`] = "V".repeat(200);
    }
    const sanitized = sanitizeActivityArgs(hugeArgs) as any;

    expect(sanitized._truncated).toBe(true);
    expect(sanitized.summary.length).toBeLessThanOrEqual(MAX_ACTIVITY_ARGS_PREVIEW + 100);
  });

  it("enforces hard maximum serialized entry size <= 64 KB", () => {
    const entry = {
      ts: Date.now(),
      pid: 1234,
      chatLine: "L".repeat(20_000),
      event: {
        type: "tool_call",
        tool: "superagent_exec_command",
        args: { cmd: "C".repeat(20_000) },
        output: "O".repeat(40_000),
        error: "E".repeat(40_000),
      },
    };

    const serialized = serializeBoundedJournalEntry(entry, MAX_ACTIVITY_RECORD_BYTES);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_ACTIVITY_RECORD_BYTES);

    const parsed = JSON.parse(serialized);
    expect(parsed.event.tool).toBe("superagent_exec_command");
  });

  it("ADVERSARIAL: enforces hard 64 KB cap for arbitrary oversized fields matching manual audit probe", () => {
    // Exact shape that previously produced 400,306 bytes
    const probe = {
      ts: Date.now(),
      pid: 41424,
      workspace: "W".repeat(100_000),
      chatLine: "C".repeat(50_000),
      event: {
        type: "tool_call",
        tool: "superagent_exec_command",
        args: { command: "echo " + "A".repeat(80_000) },
        output: "O".repeat(100_000),
        outputMeta: { preview: "P".repeat(100_000), originalBytes: 100_000, truncated: true, sha256: "abc" },
        error: "E".repeat(50_000),
      },
      unknownMetadata: {
        giantBlob: "X".repeat(200_000),
        nested: { array: Array.from({ length: 500 }, (_, i) => "item_" + i.toString().repeat(50)) },
      },
    };

    const rawBytes = Buffer.byteLength(JSON.stringify(probe), "utf8");
    expect(rawBytes).toBeGreaterThan(400_000);

    const serialized = serializeBoundedJournalEntry(probe, MAX_ACTIVITY_RECORD_BYTES);
    const resultBytes = Buffer.byteLength(serialized, "utf8");

    expect(resultBytes).toBeLessThanOrEqual(MAX_ACTIVITY_RECORD_BYTES);
    const parsed = JSON.parse(serialized);
    expect(parsed).toBeDefined();
    expect(parsed.ts).toBeDefined();
    expect(parsed.pid).toBe(41424);
  });

  it("ADVERSARIAL: handles arbitrary huge unknown field (500 KB string)", () => {
    const hugeUnknown = {
      ts: Date.now(),
      pid: 9999,
      someCompletelyUnknownKey: "Z".repeat(500_000),
    };

    const serialized = serializeBoundedJournalEntry(hugeUnknown, MAX_ACTIVITY_RECORD_BYTES);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_ACTIVITY_RECORD_BYTES);
    const parsed = JSON.parse(serialized);
    expect(parsed).toBeDefined();
  });

  it("UNICODE BYTE-SAFE: enforces preview byte cap on multi-byte emoji inputs", () => {
    // 10,000 fire emojis (🔥 is 4 UTF-8 bytes = 40,000 bytes)
    const emojiText = "🔥".repeat(10_000);
    expect(Buffer.byteLength(emojiText, "utf8")).toBe(40_000);

    const { preview, meta } = sanitizeActivityOutput(emojiText);

    // Byte length must strictly be <= MAX_ACTIVITY_OUTPUT_PREVIEW (16,384 bytes)
    const previewBytes = Buffer.byteLength(preview, "utf8");
    expect(previewBytes).toBeLessThanOrEqual(MAX_ACTIVITY_OUTPUT_PREVIEW);

    const metaPreviewBytes = Buffer.byteLength(meta.preview || "", "utf8");
    expect(metaPreviewBytes).toBeLessThanOrEqual(MAX_ACTIVITY_OUTPUT_PREVIEW);

    expect(meta.originalBytes).toBe(40_000);
    expect(meta.truncated).toBe(true);

    // Multi-byte Unicode error must also strictly adhere to MAX_ACTIVITY_ERROR_PREVIEW
    const emojiError = "💥".repeat(10_000);
    const sanitizedError = sanitizeActivityError(emojiError);
    const errorBytes = Buffer.byteLength(sanitizedError, "utf8");
    expect(errorBytes).toBeLessThanOrEqual(MAX_ACTIVITY_ERROR_PREVIEW);
  });
});
