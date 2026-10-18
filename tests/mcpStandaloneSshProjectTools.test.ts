import { describe, expect, it } from "vitest";
import { StandaloneSshProjectProvider } from "../src/core/mcp/tools/standaloneSshProjectTools.js";

describe("standalone SSH project provider", () => {
  it("returns an explicit capability error for unsupported tools rather than falling back to local execution", async () => {
    const provider = new StandaloneSshProjectProvider();
    const result = await provider.dispatch("superagent_manage_plan", {}, "ssh://deploy@example.test/srv/app", "remote-app");
    expect(result?.isError).toBe(true);
    const text = (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
    expect(text).toMatch(/not implemented for standalone SSH projects/i);
    expect(text).toMatch(/request was not executed locally/i);
    expect(text).toMatch(/Workspace Chain remains optional/i);
  });

  it("rejects supported SSH operations without an explicit registered project ID before opening a connection", async () => {
    const provider = new StandaloneSshProjectProvider();
    const result = await provider.dispatch("superagent_list_files", {}, "ssh://deploy@example.test/srv/app");
    expect(result?.isError).toBe(true);
    const text = (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
    expect(text).toMatch(/registered SSH projectId/i);
  });
});
