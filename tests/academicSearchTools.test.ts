import { describe, it, expect, vi } from "vitest";
import { searchJournalTool } from "../src/core/tools/academicSearchTools.js";

describe("searchJournalTool", () => {
  it("should have correct metadata and parameter definition", () => {
    expect(searchJournalTool.name).toBe("search_journal");
    expect(searchJournalTool.parameters.required).toContain("query");
    expect(searchJournalTool.description).toContain("Semantic Scholar");
  });

  it("should format OpenAlex query with per-page instead of limit", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("openalex.org")) {
        expect(url).toContain("per-page=3");
        expect(url).not.toContain("&limit=");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                title: "Deep Residual Learning",
                authorships: [{ author: { display_name: "Kaiming He" } }],
                publication_year: 2016,
                doi: "https://doi.org/10.1109/cvpr.2016.90"
              }
            ]
          })
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({})
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const result = await searchJournalTool.execute({
        query: "deep residual learning",
        provider: "openalex",
        limit: 3
      }, process.cwd());

      expect(result).toContain("--- OpenAlex Results ---");
      expect(result).toContain("Deep Residual Learning");
      expect(result).toContain("Kaiming He");
      expect(result).toContain("2016");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should handle provider failures gracefully in auto mode", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("crossref.org")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              items: [
                {
                  title: ["Attention Is All You Need"],
                  author: [{ given: "Ashish", family: "Vaswani" }],
                  created: { "date-parts": [[2017]] },
                  DOI: "10.48550/arXiv.1706.03762"
                }
              ]
            }
          })
        });
      }
      return Promise.reject(new Error("Network timeout"));
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const result = await searchJournalTool.execute({
        query: "attention is all you need",
        provider: "auto",
        limit: 2
      }, process.cwd());

      expect(result).toContain("--- Crossref Results ---");
      expect(result).toContain("Attention Is All You Need");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
