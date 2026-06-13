import { describe, it, expect } from "vitest";
import { getToolByName } from "../src/core/tools/index.js";

describe("edit tool registration", () => {
  it("should find 'edit' tool using getToolByName", () => {
    const editTool = getToolByName("edit");
    expect(editTool).toBeDefined();
    expect(editTool?.name).toBe("edit");
    expect(typeof editTool?.execute).toBe("function");
  });
});
