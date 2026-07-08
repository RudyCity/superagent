import { describe, it, expect } from "vitest";
import { extractJSON, reconstructChatCompletionFromSse } from "../src/core/config/models.js";

describe("extractJSON", () => {
  it("should extract clean JSON from a standard JSON string", () => {
    const input = '{"id":"id-123","choices":[{"text":"hello"}]}';
    expect(extractJSON(input)).toBe(input);
  });

  it("should extract JSON and strip trailing non-whitespace characters", () => {
    const input = '{"id":"id-123","choices":[{"text":"hello"}]} trailing_garbage';
    expect(extractJSON(input)).toBe('{"id":"id-123","choices":[{"text":"hello"}]}');
  });

  it("should extract JSON and strip leading/trailing characters", () => {
    const input = 'data: {"id":"id-123","choices":[{"text":"hello"}]} \n\n';
    expect(extractJSON(input)).toBe('{"id":"id-123","choices":[{"text":"hello"}]}');
  });

  it("should ignore brackets and braces inside string literals", () => {
    const input = '{"id":"foo { bar [ baz ] }","choices":[{"text":"hello}"}]} trailing }';
    expect(extractJSON(input)).toBe('{"id":"foo { bar [ baz ] }","choices":[{"text":"hello}"}]}');
  });

  it("should handle nested arrays and objects correctly", () => {
    const input = '{"a":{"b":[1,2,{"c":3}]}}';
    expect(extractJSON(input)).toBe(input);
  });

  it("should return original text if no brace or bracket is found", () => {
    const input = 'plain text without json';
    expect(extractJSON(input)).toBe(input);
  });

  it("should return original text if brace or bracket is not closed", () => {
    const input = '{"id":"id-123"';
    expect(extractJSON(input)).toBe(input);
  });

  it("should extract arrays", () => {
    const input = '[1, 2, 3] trailing';
    expect(extractJSON(input)).toBe('[1, 2, 3]');
  });
});

describe("reconstructChatCompletionFromSse", () => {
  it("should reconstruct standard content stream successfully", () => {
    const sse = [
      'data: {"id":"chat-1","choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"id":"chat-1","choices":[{"delta":{"content":"world!"}}]}',
      "data: [DONE]"
    ].join("\n");

    const result = reconstructChatCompletionFromSse(sse);
    expect(result).toMatchObject({
      id: "chat-1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello world!"
          },
          finish_reason: "stop"
        }
      ]
    });
  });

  it("should reconstruct tool calls from chunks successfully", () => {
    const sse = [
      'data: {"id":"chat-2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search"}}]}}]}',
      'data: {"id":"chat-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"qu"}}]}}]}',
      'data: {"id":"chat-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\":\\"foo\\"}"}}]}}]}',
      "data: [DONE]"
    ].join("\n");

    const result = reconstructChatCompletionFromSse(sse);
    expect(result).toMatchObject({
      id: "chat-2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "search",
                  arguments: '{"query":"foo"}'
                }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
  });
});
