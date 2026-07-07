import { describe, it, expect } from "vitest";
import { extractJSON } from "../src/core/config/models.js";

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
