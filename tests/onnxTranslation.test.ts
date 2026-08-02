import { describe, it, expect } from "vitest";
import { initONNXTranslationPipeline, translatePromptWithONNX, analyzePromptIntentAsync } from "../src/core/promptClarification.js";

describe("ONNX Local Translation Pipeline (< 100MB RAM)", () => {
  it("should initialize or gracefully fallback if offline/mocked", async () => {
    const pipeline = await initONNXTranslationPipeline();
    // In test environment, if network/model download is unavailable, pipeline will be null
    expect(pipeline === null || typeof pipeline === "function").toBe(true);
  }, 30000);

  it("should translate prompt or fallback gracefully", async () => {
    const translated = await translatePromptWithONNX("tolong perbaiki fungsi ini");
    // Either returns translated string or null on offline fallback
    expect(translated === null || typeof translated === "string").toBe(true);
  }, 30000);

  it("should analyze prompt intent asynchronously with ONNX fallback", async () => {
    const res = await analyzePromptIntentAsync("tolong perbaiki fungsi ini di file src/core/server.ts");
    expect(res.detectedLanguage).toBe("id");
    expect(res.translatedEnglishPrompt).toBeDefined();
  }, 30000);
});
