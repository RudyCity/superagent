import { describe, it, expect } from "vitest";
import { fuzzyScore, filterSuggestions } from "../src/utils/text.js";

describe("Fuzzy Matching Utilities", () => {
  describe("fuzzyScore", () => {
    it("should return 0 for exact match (case insensitive)", () => {
      expect(fuzzyScore("/terminal", "/terminal")).toBe(0);
      expect(fuzzyScore("/TERMINAL", "/terminal")).toBe(0);
    });

    it("should return 1 for prefix match", () => {
      expect(fuzzyScore("/term", "/terminal")).toBe(1);
      expect(fuzzyScore("/TERM", "/terminal")).toBe(1);
    });

    it("should return 2 for substring match", () => {
      expect(fuzzyScore("minal", "/terminal")).toBe(2);
      expect(fuzzyScore("MINAL", "/terminal")).toBe(2);
    });

    it("should return 3 for fuzzy/subsequence match", () => {
      expect(fuzzyScore("trmnl", "/terminal")).toBe(3);
      expect(fuzzyScore("TRMNL", "/terminal")).toBe(3);
    });

    it("should return null for no match", () => {
      expect(fuzzyScore("xyz", "/terminal")).toBe(null);
    });

    it("should return 0 for empty query", () => {
      expect(fuzzyScore("", "/terminal")).toBe(0);
    });
  });

  describe("filterSuggestions", () => {
    it("should filter and sort possibilities by match quality and length", () => {
      const possibilities = [
        "/terminal preset",
        "/terminal bg",
        "/terminal init",
        "/terminal stop",
        "/tasks"
      ];

      // Exact/prefix match should be first
      const result = filterSuggestions(possibilities, "/terminal");
      expect(result).toContain("/terminal preset");
      expect(result).toContain("/terminal bg");
      expect(result).toContain("/terminal init");
      expect(result).toContain("/terminal stop");
      expect(result).not.toContain("/tasks");
      
      // Let's assert ranking order for specific prefix match
      const subResult = filterSuggestions(possibilities, "bg");
      expect(subResult[0]).toBe("/terminal bg"); // Prefix/contains should be ranked best
    });

    it("should perform subsequence fuzzy match ranking", () => {
      const possibilities = [
        "/checkpoint restore",
        "/checkpoint list",
        "/clear"
      ];

      // "cpr" should fuzzy match "/checkpoint restore"
      const result = filterSuggestions(possibilities, "cpr");
      expect(result).toEqual(["/checkpoint restore"]);

      // "cl" should match "/clear" (score 1/prefix) and "/checkpoint list" (score 3/fuzzy)
      const result2 = filterSuggestions(possibilities, "cl");
      expect(result2).toEqual(["/clear", "/checkpoint list"]);
    });
  });
});
