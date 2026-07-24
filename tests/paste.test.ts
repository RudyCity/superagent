import { describe, expect, it, beforeEach } from "vitest";
import { updatePasteState, resetPasteDetection } from "../src/utils/text.js";

describe("updatePasteState", () => {
  beforeEach(() => {
    resetPasteDetection();
  });

  it("should detect paste when pasting a large string of 300 characters", () => {
    const input = "";
    const pasted = "a".repeat(300);
    const state = { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    const nextState = updatePasteState(input, pasted, state);
    expect(nextState.isPasted).toBe(true);
    expect(nextState.pastePrefixLength).toBe(0);
    expect(nextState.pasteSuffixLength).toBe(0);
  });

  it("should NOT detect paste when typing 1 character", () => {
    const input = "abc";
    const nextVal = "abcd";
    const state = { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    const nextState = updatePasteState(input, nextVal, state);
    expect(nextState.isPasted).toBe(false);
  });

  it("should handle multi-chunk paste continuation", () => {
    const input1 = "";
    const chunk1 = "a".repeat(200);
    const state1 = { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    const state2 = updatePasteState(input1, chunk1, state1);
    expect(state2.isPasted).toBe(true);

    const chunk2 = chunk1 + "b".repeat(200);
    const state3 = updatePasteState(chunk1, chunk2, state2);
    expect(state3.isPasted).toBe(true);
    expect(state3.pastePrefixLength).toBe(0);
    expect(state3.pasteSuffixLength).toBe(0);
  });

  it("should detect paste when pasting 300 characters character-by-character", () => {
    let input = "";
    let state = { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };
    for (let i = 0; i < 300; i++) {
      const nextVal = input + "a";
      state = updatePasteState(input, nextVal, state);
      input = nextVal;
    }
    expect(state.isPasted).toBe(true);
  });
});
