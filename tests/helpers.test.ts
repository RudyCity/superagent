import { describe, expect, test } from "vitest";
import { suggestClosest, formatUnknownActionError } from "../src/core/tools/helpers.js";
import { grepTool } from "../src/core/tools/fileReadTools.js";
import { manageTasksTool } from "../src/core/tools/otherTools.js";
import path from "path";

describe("Tool Helpers Safeguards", () => {
  test("suggestClosest handles undefined, null, or non-string inputs safely", () => {
    expect(suggestClosest(undefined as any, ["list", "add"])).toBeUndefined();
    expect(suggestClosest(null as any, ["list", "add"])).toBeUndefined();
    expect(suggestClosest(123 as any, ["list", "add"])).toBeUndefined();
    expect(suggestClosest("lst", ["list", "add"])).toBe("list");
  });

  test("formatUnknownActionError handles missing action parameter safely", () => {
    const resUndefined = formatUnknownActionError(undefined as any, ["list", "add", "update"]);
    expect(resUndefined).toContain("Error: Action parameter is required.");
    expect(resUndefined).toContain("Use one of: list, add, update.");

    const resNull = formatUnknownActionError(null as any, ["list", "add", "update"]);
    expect(resNull).toContain("Error: Action parameter is required.");

    const resInvalid = formatUnknownActionError("invalid_action", ["list", "add", "update"]);
    expect(resInvalid).toContain("Error: Unknown action \"invalid_action\".");
  });

  test("grepTool supports single file path passed to path parameter", async () => {
    const testFilePath = path.resolve(process.cwd(), "package.json");
    const result = await grepTool.execute({ pattern: "superagent", path: testFilePath }, process.cwd(), undefined as any);
    expect(result).not.toContain("ENOTDIR");
    expect(typeof result).toBe("string");
  });

  test("manageTasksTool auto-infers missing action parameter", async () => {
    const result = await manageTasksTool.execute({ index: 999, status: "/" } as any, process.cwd(), undefined as any);
    // Action should be auto-inferred as 'update' and return out-of-bounds error or task file error instead of unknown action error
    expect(result).not.toContain("Action parameter is required");
    expect(result).not.toContain("Unknown action");
  });
});
