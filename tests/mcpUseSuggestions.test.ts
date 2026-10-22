import { describe, expect, it } from "vitest";
import { getDashboardSuggestions, getSuggestionDescriptions } from "../src/utils/dashboardSuggestions.js";
import { MCP_USE_SUGGESTIONS } from "../src/core/commands/commandCatalog.js";

describe("MCP tool exposure command suggestions", () => {
  it("includes gateway, full and status under /mcp use and its trailing-space form", () => {
    for (const input of ["/mcp use", "/mcp use "]) {
      const suggestions = getDashboardSuggestions(input, input.length);
      expect(suggestions).toEqual(expect.arrayContaining([...MCP_USE_SUGGESTIONS]));
      expect(suggestions.every((value) => value.startsWith("/mcp use "))).toBe(true);
      expect(suggestions).not.toContain("/mcp tunnel providers");
    }
  });

  it("offers appropriate completion for each partial mode name", () => {
    expect(getDashboardSuggestions("/mcp use g")).toEqual(["/mcp use gateway"]);
    expect(getDashboardSuggestions("/mcp use f")).toEqual(["/mcp use full"]);
    expect(getDashboardSuggestions("/mcp use sta")).toEqual(["/mcp use status"]);
    expect(getDashboardSuggestions("/MCP USE G")).toEqual(["/mcp use gateway"]);
  });

  it("preserves main MCP choices and does not leak tool modes into tunnel commands", () => {
    const root = getDashboardSuggestions("/mcp ");
    expect(root).toContain("/mcp use");
    expect(root).toContain("/mcp use gateway");
    expect(root).toContain("/mcp tunnel");
    const tunnels = getDashboardSuggestions("/mcp tunnel");
    expect(tunnels).toContain("/mcp tunnel start --provider cloudflare");
    expect(tunnels).not.toContain("/mcp use gateway");
  });

  it("provides descriptive UI metadata for all three suggestions", () => {
    const descriptions = getSuggestionDescriptions();
    for (const suggestion of MCP_USE_SUGGESTIONS) {
      expect(descriptions[suggestion]?.length).toBeGreaterThan(20);
    }
  });
});
