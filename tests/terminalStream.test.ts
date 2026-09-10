import { describe, it, expect } from "vitest";
import { resolveCarriageReturns, getTerminalTailLines } from "../src/utils/terminalStream.js";

describe("terminalStream", () => {
  describe("resolveCarriageReturns", () => {
    it("returns plain text unchanged when no carriage return is present", () => {
      const input = "Line 1\nLine 2\nLine 3";
      expect(resolveCarriageReturns(input)).toBe(input);
    });

    it("normalizes CRLF to LF", () => {
      const input = "Line 1\r\nLine 2\r\nLine 3";
      expect(resolveCarriageReturns(input)).toBe("Line 1\nLine 2\nLine 3");
    });

    it("resolves progress bar updates with carriage returns", () => {
      const input = "Downloading: 10%\rDownloading: 50%\rDownloading: 100%\nDone!";
      expect(resolveCarriageReturns(input)).toBe("Downloading: 100%\nDone!");
    });

    it("handles trailing carriage returns without clearing text", () => {
      const input = "Running benchmark...\r";
      expect(resolveCarriageReturns(input)).toBe("Running benchmark...");
    });

    it("overlays shorter overwrite segments on existing text", () => {
      const input = "Hello World\rHi";
      expect(resolveCarriageReturns(input)).toBe("Hillo World");
    });
  });

  describe("getTerminalTailLines", () => {
    it("returns empty array for empty string", () => {
      expect(getTerminalTailLines("")).toEqual([]);
    });

    it("returns tail lines up to maxLines", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
      const tail = getTerminalTailLines(lines, 5);
      expect(tail).toEqual(["Line 16", "Line 17", "Line 18", "Line 19", "Line 20"]);
    });

    it("resolves carriage returns before slicing tail lines", () => {
      const stream = "Compiling...\rCompiling [1/2]\rCompiling [2/2]\nDone\nReady";
      const tail = getTerminalTailLines(stream, 3);
      expect(tail).toEqual(["Compiling [2/2]", "Done", "Ready"]);
    });
  });
});
