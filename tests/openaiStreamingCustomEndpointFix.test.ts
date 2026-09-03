import { describe, it, expect } from "vitest";
import {
  synthesizeSseFromChatCompletion,
  transformSseText,
  reconstructChatCompletionFromSse,
} from "../src/core/config/openAiSseAdapter.js";
import { ContextManager } from "../src/core/context/ContextManager.js";

describe("synthesizeSseFromChatCompletion", () => {
  it("should convert a non-streaming ChatCompletion into valid SSE chunk stream", () => {
    const json = {
      id: "chatcmpl-test-123",
      object: "chat.completion",
      created: 1700000000,
      model: "qwen3.8-4b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from local model!",
          },
          finish_reason: "stop",
        },
      ],
    };

    const sse = synthesizeSseFromChatCompletion(json, "qwen3.8-4b");
    expect(sse).toContain("data: ");
    expect(sse).toContain("data: [DONE]");

    // Verify it contains content delta
    expect(sse).toContain("Hello from local model!");

    // Verify the reconstructed SSE matches the original content
    const reconstructed = reconstructChatCompletionFromSse(sse);
    expect(reconstructed.choices[0].message.content).toBe("Hello from local model!");
  });

  it("should wrap reasoning_content into think tags when synthesizing SSE", () => {
    const json = {
      id: "chatcmpl-reasoning-1",
      model: "qwen3.8-4b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The answer is 42.",
            reasoning_content: "Computing deeply about the meaning of life.",
          },
          finish_reason: "stop",
        },
      ],
    };

    const sse = synthesizeSseFromChatCompletion(json, "qwen3.8-4b");
    expect(sse).toContain("<think>");
    expect(sse).toContain("Computing deeply about the meaning of life.");
    expect(sse).toContain("</think>");
    expect(sse).toContain("The answer is 42.");
  });

  it("should synthesize SSE for tool calls properly", () => {
    const json = {
      id: "chatcmpl-tool-1",
      model: "custom",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: '{"command":"ls"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };

    const sse = synthesizeSseFromChatCompletion(json, "custom");
    expect(sse).toContain("call_1");
    expect(sse).toContain("bash");
    expect(sse).toContain("tool_calls");
  });

  it("should throw an error if ChatCompletion contains an error object", () => {
    const json = {
      error: {
        message: "Payment Required: balance depleted",
        type: "insufficient_quota",
        code: 402,
      },
    };
    expect(() => synthesizeSseFromChatCompletion(json, "custom")).toThrow(
      "Cannot synthesize SSE from error payload: Payment Required: balance depleted"
    );
  });

  it("should throw an error if choices array is missing or empty", () => {
    expect(() => synthesizeSseFromChatCompletion({}, "custom")).toThrow(
      "Invalid ChatCompletion object: missing choices array"
    );
    expect(() => synthesizeSseFromChatCompletion({ choices: [] }, "custom")).toThrow(
      "Invalid ChatCompletion object: missing choices array"
    );
  });
});

describe("transformSseText", () => {
  it("should map delta.reasoning_content to delta.content wrapped in think tags", () => {
    const rawSse = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Thinking step 1."}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":" Thinking step 2."}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Final answer."}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\n");

    const transformed = transformSseText(rawSse);
    expect(transformed).toContain("<think>Thinking step 1.");
    expect(transformed).toContain("Thinking step 2.");
    expect(transformed).toContain("</think>Final answer.");
  });

  it("should close think tags when finish_reason arrives without regular content", () => {
    const rawSse = [
      'data: {"id":"2","choices":[{"index":0,"delta":{"reasoning_content":"Only reasoned."}}]}',
      'data: {"id":"2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\n");

    const transformed = transformSseText(rawSse);
    expect(transformed).toContain("<think>Only reasoned.");
    expect(transformed).toContain("</think>");
  });
});

describe("reconstructChatCompletionFromSse with reasoning", () => {
  it("should preserve reasoning_content when delta.content is absent", () => {
    const rawSse = [
      'data: {"id":"3","choices":[{"index":0,"delta":{"reasoning_content":"I have reasoned."}}]}',
      'data: {"id":"3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\n");

    const result = reconstructChatCompletionFromSse(rawSse);
    expect(result.choices[0].message.content).toContain("<think>");
    expect(result.choices[0].message.content).toContain("I have reasoned.");
  });
});

describe("ContextManager calculateThreshold safeguards", () => {
  it("should calculate positive thresholds for small context limits like 8192", () => {
    const cm = new ContextManager({
      contextWindowLimit: 8192,
      model: "qwen3.8-4b",
    });

    const threshold = (cm as any).calculateThreshold();
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeGreaterThanOrEqual(4096); // At least 50%
  });

  it("should calculate positive thresholds for 4096 context window", () => {
    const cm = new ContextManager({
      contextWindowLimit: 4096,
      model: "custom-small",
    });

    const threshold = (cm as any).calculateThreshold();
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeGreaterThanOrEqual(2048);
  });

  it("should calculate appropriate thresholds for 128k context window", () => {
    const cm = new ContextManager({
      contextWindowLimit: 128000,
      model: "gpt-4o",
    });

    const threshold = (cm as any).calculateThreshold();
    expect(threshold).toBeGreaterThan(50000);
    expect(threshold).toBeLessThan(128000);
  });
});
