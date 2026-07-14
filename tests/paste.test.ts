import { describe, expect, it } from "vitest";
import { updatePasteState } from "../src/utils/text.js";

describe("updatePasteState", () => {
  it("detects initial paste and transitions to isPasted: true", () => {
    const input = "";
    const sanitizedVal = "This is a very long text pasted into the console that exceeds fifteen characters.";
    const state = { isPasted: false, pastePrefixLength: 0, pasteSuffixLength: 0 };

    const result = updatePasteState(input, sanitizedVal, state);
    expect(result.isPasted).toBe(true);
    expect(result.pastePrefixLength).toBe(0);
    expect(result.pasteSuffixLength).toBe(0);
  });

  it("absorbs subsequent paste chunks into the paste block", () => {
    const input = "CHUNK1";
    const state = { isPasted: true, pastePrefixLength: 0, pasteSuffixLength: 0 };
    
    const sanitizedVal = "CHUNK1CHUNK2";
    const result = updatePasteState(input, sanitizedVal, state);

    expect(result.isPasted).toBe(true);
    expect(result.pastePrefixLength).toBe(0);
    expect(result.pasteSuffixLength).toBe(0);
  });

  it("handles user typing at the end of the paste block by treating it as suffix", () => {
    const input = "CHUNK1";
    const state = { isPasted: true, pastePrefixLength: 0, pasteSuffixLength: 0 };
    
    const sanitizedVal = "CHUNK1a";
    const result = updatePasteState(input, sanitizedVal, state);

    expect(result.isPasted).toBe(true);
    expect(result.pastePrefixLength).toBe(0);
    expect(result.pasteSuffixLength).toBe(1);
  });

  it("keeps paste intact when user typed prefix before the paste block", () => {
    const input = "CHUNK1";
    const state = { isPasted: true, pastePrefixLength: 0, pasteSuffixLength: 0 };
    
    const sanitizedVal = "aCHUNK1";
    const result = updatePasteState(input, sanitizedVal, state);

    expect(result.isPasted).toBe(true);
    expect(result.pastePrefixLength).toBe(1);
    expect(result.pasteSuffixLength).toBe(0);
  });

  it("clears paste state if the paste block is modified inside", () => {
    const input = "CHUNK1";
    const state = { isPasted: true, pastePrefixLength: 0, pasteSuffixLength: 0 };
    
    const sanitizedVal = "CHNK1";
    const result = updatePasteState(input, sanitizedVal, state);

    expect(result.isPasted).toBe(false);
  });
});
