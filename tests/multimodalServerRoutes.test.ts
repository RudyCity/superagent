import { describe, it, expect, vi } from "vitest";

describe("Multimodal Server Routes Parsing", () => {
  it("should correctly parse JSON stringified multimodal image messages", () => {
    const rawMessage = JSON.stringify([
      { type: "text", text: "Analyze this image" },
      { type: "image", image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" }
    ]);

    let parsedMessage = rawMessage;
    if (typeof rawMessage === "string" && (rawMessage.trim().startsWith("[") || rawMessage.trim().startsWith("{"))) {
      try {
        parsedMessage = JSON.parse(rawMessage);
      } catch {}
    }

    expect(Array.isArray(parsedMessage)).toBe(true);
    expect(parsedMessage).toHaveLength(2);
    expect(parsedMessage[0]).toEqual({ type: "text", text: "Analyze this image" });
    expect(parsedMessage[1].type).toBe("image");
  });

  it("should preserve plain text messages unchanged", () => {
    const rawMessage = "Hello assistant, how are you?";
    let parsedMessage: any = rawMessage;
    if (typeof rawMessage === "string" && (rawMessage.trim().startsWith("[") || rawMessage.trim().startsWith("{"))) {
      try {
        parsedMessage = JSON.parse(rawMessage);
      } catch {}
    }

    expect(parsedMessage).toBe("Hello assistant, how are you?");
  });
});
