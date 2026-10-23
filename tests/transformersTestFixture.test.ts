import { describe, expect, it } from "vitest";
import { env, pipeline } from "@huggingface/transformers";
import { OptimizedLocalTextEmbeddingProvider } from "../src/core/rmemoryUtil.js";

describe("offline transformer test fixture", () => {
  it("exposes the ONNX environment read by RMemory", () => {
    expect(env).toBeDefined();
    expect(env.backends.onnx).toBeDefined();
    expect(env.allowRemoteModels).toBe(false);
  });

  it("produces correctly shaped vectors for single and batched embeddings without downloading models", async () => {
    const provider = new OptimizedLocalTextEmbeddingProvider({ modelName: "test-fixture-embedding" });
    const single = await provider.embedText("fixture-single-vector-1022");
    const batch = await provider.embedTexts(["fixture-batch-a-1022", "fixture-batch-b-1022"]);
    expect(single).toHaveLength(384);
    expect(batch).toHaveLength(2);
    expect(batch.every(vector => vector.length === 384 && vector.every(Number.isFinite))).toBe(true);

    const extractor = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5");
    const tensor = await extractor(["a", "b"]);
    expect(tensor.data).toHaveLength(2 * 768);
    tensor.dispose();
  });
});
