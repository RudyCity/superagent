import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveBaseTypeFromTypeName,
  resolveSubagentToolset,
  defaultSubagentToolset,
  subagentToolsets,
} from "../src/core/tools/toolsets.js";
import { subagentTypes } from "../src/core/tools/state.js";
import { defineSubagentTool, invokeSubagentTool } from "../src/core/tools/subagentTools.js";

describe("Subagent Toolset Resolution & Write Tools Inheritance", () => {
  beforeEach(() => {
    subagentTypes.clear();
  });

  describe("resolveBaseTypeFromTypeName", () => {
    it("matches exact built-in subagent names", () => {
      expect(resolveBaseTypeFromTypeName("coder")).toBe("coder");
      expect(resolveBaseTypeFromTypeName("researcher")).toBe("researcher");
      expect(resolveBaseTypeFromTypeName("reviewer")).toBe("reviewer");
      expect(resolveBaseTypeFromTypeName("software-tester")).toBe("software-tester");
      expect(resolveBaseTypeFromTypeName("security-engineer")).toBe("security-engineer");
      expect(resolveBaseTypeFromTypeName("chrome-agent")).toBe("chrome-agent");
    });

    it("infers 'coder' for code modification and porting keywords", () => {
      expect(resolveBaseTypeFromTypeName("migration-coder")).toBe("coder");
      expect(resolveBaseTypeFromTypeName("dataset-generator")).toBe("coder");
      expect(resolveBaseTypeFromTypeName("python-developer")).toBe("coder");
      expect(resolveBaseTypeFromTypeName("refactor-agent")).toBe("coder");
      expect(resolveBaseTypeFromTypeName("patch-fixer")).toBe("coder");
      expect(resolveBaseTypeFromTypeName("script-builder")).toBe("coder");
    });

    it("infers tester, reviewer, security, chrome, and researcher correctly", () => {
      expect(resolveBaseTypeFromTypeName("e2e-tester")).toBe("software-tester");
      expect(resolveBaseTypeFromTypeName("code-reviewer")).toBe("reviewer");
      expect(resolveBaseTypeFromTypeName("security-scanner")).toBe("security-engineer");
      expect(resolveBaseTypeFromTypeName("browser-controller")).toBe("chrome-agent");
      expect(resolveBaseTypeFromTypeName("codebase-researcher")).toBe("researcher");
    });

    it("returns undefined for completely unrecognizable names", () => {
      expect(resolveBaseTypeFromTypeName("arbitrary-foobar-123")).toBeUndefined();
      expect(resolveBaseTypeFromTypeName("")).toBeUndefined();
    });
  });

  describe("resolveSubagentToolset", () => {
    const writeToolNames = ["write_to_file", "replace_file_content", "edit", "apply_patch"];

    it("provides write tools for 'migration-coder'", () => {
      const toolset = resolveSubagentToolset("migration-coder");
      const toolNames = toolset.map((t) => t.name);

      expect(toolNames).toContain("write_to_file");
      expect(toolNames).toContain("replace_file_content");
      expect(toolNames).toContain("edit");
      expect(toolNames).toContain("bash");
    });

    it("keeps 'researcher' strictly read-only without write tools", () => {
      const toolset = resolveSubagentToolset("researcher");
      const toolNames = toolset.map((t) => t.name);

      for (const w of writeToolNames) {
        expect(toolNames).not.toContain(w);
      }
    });

    it("keeps default fallback for unrecognized subagent types read-only", () => {
      const toolset = resolveSubagentToolset("unknown-foo-type");
      expect(toolset).toBe(defaultSubagentToolset);

      const toolNames = toolset.map((t) => t.name);
      for (const w of writeToolNames) {
        expect(toolNames).not.toContain(w);
      }
    });

    it("allows enabling write tools explicitly via options", () => {
      const toolset = resolveSubagentToolset("custom-subagent", { enableWriteTools: true });
      const toolNames = toolset.map((t) => t.name);

      expect(toolNames).toContain("write_to_file");
      expect(toolNames).toContain("replace_file_content");
    });

    it("allows specifying baseType or toolset override via options", () => {
      const toolset = resolveSubagentToolset("custom-subagent", { toolset: "coder" });
      const toolNames = toolset.map((t) => t.name);

      expect(toolNames).toContain("write_to_file");
      expect(toolNames).toContain("replace_file_content");
    });
  });

  describe("defineSubagentTool & invokeSubagentTool integration", () => {
    it("registers custom subagent with toolset option in define_subagent", async () => {
      await defineSubagentTool.execute(
        {
          name: "migration-coder",
          description: "Porting python to rudy",
          systemPrompt: "You are a porting expert",
          toolset: "coder",
        },
        process.cwd()
      );

      const registered = subagentTypes.get("migration-coder");
      expect(registered).toBeDefined();
      expect(registered?.toolset).toBe("coder");

      const resolved = resolveSubagentToolset("migration-coder", {
        toolset: registered?.toolset,
        enableWriteTools: registered?.enableWriteTools,
      });
      expect(resolved.map((t) => t.name)).toContain("write_to_file");
    });

    it("auto-registers subagent on the fly in invokeSubagentTool if not defined", async () => {
      const res = await invokeSubagentTool.execute(
        {
          typeName: "migration-coder",
          role: "Port dataset scripts",
          prompt: "Port scripts",
          wait: false,
          mode: "background",
        },
        process.cwd()
      );

      // Should not return an error about undefined subagent
      expect(res).not.toContain("Error: Subagent type");
      expect(res).toContain("Invoked subagent");

      // Should have auto-registered in subagentTypes
      const autoRegistered = subagentTypes.get("migration-coder");
      expect(autoRegistered).toBeDefined();
      expect(autoRegistered?.toolset).toBe("coder");
      expect(autoRegistered?.enableWriteTools).toBe(true);
    });
  });
});
