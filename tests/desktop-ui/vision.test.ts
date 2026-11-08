import { describe, expect, it, vi } from "vitest";
import { createLocalUiDetrVisionDetector } from "../../src/core/desktopUi/vision.js";

describe("local UI-DETR desktop fallback", () => {
  it("is disabled by default so screenshots are not sent to an arbitrary loopback service", () => {
    expect(() => createLocalUiDetrVisionDetector()).toThrowError(/disabled/);
  });

  it("accepts only loopback endpoints even after explicit screenshot-upload opt-in", () => {
    expect(() => createLocalUiDetrVisionDetector({
      endpoint: "http://192.168.1.20:8095",
      allowScreenshotUpload: true,
    })).toThrowError(/loopback/);
  });

  it("filters low-confidence and unsafe roles and does not fabricate OCR text", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      elements: [
        { label: "Button", score: 0.91, box: [1, 2, 11, 12] },
        { label: "Button", score: 0.2, box: [20, 2, 30, 12] },
        { label: "Password", score: 0.99, box: [40, 2, 50, 12] },
        { label: "broken", score: "high", box: [0, 0, 1, 1] },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const detector = createLocalUiDetrVisionDetector({
      endpoint: "http://127.0.0.1:8095",
      fetchImpl: fetchMock as typeof fetch,
      allowScreenshotUpload: true,
    });
    const detections = await detector.detect(new Uint8Array([1, 2, 3]));

    expect(detections).toEqual([
      { role: "button", score: 0.91, box: [1, 2, 11, 12] },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8095/detect"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("allows an authenticated local endpoint without a separate opt-in flag", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      elements: [],
    }), { status: 200 }));

    const detector = createLocalUiDetrVisionDetector({
      authorizationToken: "local-secret",
      fetchImpl: fetchMock as typeof fetch,
    });
    await detector.detect(new Uint8Array([1]));

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8095/detect"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-secret" }),
      }),
    );
  });
});
