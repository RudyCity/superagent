import { describe, expect, it } from "vitest";
import {
  masterToolset,
  subagentToolsets,
  superagentToolset,
} from "../../src/core/tools/toolsets.js";

const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

describe("desktop UI local tool registration", () => {
  it("registers host-native desktop control only for the intended local execution tiers", () => {
    expect(names(superagentToolset)).toContain("desktop_ui");
    expect(names(subagentToolsets["software-tester"])).toContain("desktop_ui");
    expect(names(masterToolset)).not.toContain("desktop_ui");
    expect(names(subagentToolsets["chrome-agent"])).not.toContain("desktop_ui");
  });
});
