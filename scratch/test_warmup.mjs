// Simulate the warmUpClassifier test
import { vi } from "vitest";

const mockClassifierPipeline = vi.fn();
vi.doMock("@huggingface/transformers", () => {
  return {
    pipeline: vi.fn().mockResolvedValue((prompt) => mockClassifierPipeline(prompt)),
    env: undefined,
  };
});

const { warmUpClassifier } = await import("../src/core/requestClassifier.js");

// Check what pipeline looks like
const mod = await import("@huggingface/transformers");
console.log("pipeline:", typeof mod.pipeline);
console.log("pipeline.mock:", !!mod.pipeline.mock);
console.log("pipeline._isMockFunction:", !!mod.pipeline._isMockFunction);
console.log("pipeline.mockImplementation:", typeof mod.pipeline.mockImplementation);

await warmUpClassifier();
console.log("After warmUp, pipeline.mock.calls.length:", mod.pipeline.mock.calls.length);
console.log("Calls:", mod.pipeline.mock.calls);
