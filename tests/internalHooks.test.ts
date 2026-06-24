import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { loadDynamicHooks } from "../src/core/tools/dynamicHooks.js";
import { internalHooksCommand } from "../src/core/commands/internalHooksCommand.js";
import { ChatLine, SlashCommandContext } from "../src/core/commands/types.js";

describe("Internal Hooks Feature", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-hooks-test-"));
    process.chdir(tempDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should initialize a new hook folder and files on /ih init", async () => {
    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };

    await internalHooksCommand.execute("init test-hook", mockCtx);

    // Verify chat lines logged success
    expect(lines.some(l => l.type === "system" && l.content.includes("Successfully initialized"))).toBe(true);

    const hookDir = path.join(tempDir, "internal-hooks", "test-hook");
    expect(fsSync.existsSync(path.join(hookDir, "hook.json"))).toBe(true);
    expect(fsSync.existsSync(path.join(hookDir, "package.json"))).toBe(true);
    expect(fsSync.existsSync(path.join(hookDir, "index.js"))).toBe(true);
    expect(fsSync.existsSync(path.join(hookDir, "test-payload.json"))).toBe(true);

    // Verify content of hook.json
    const hookJson = JSON.parse(await fs.readFile(path.join(hookDir, "hook.json"), "utf-8"));
    expect(hookJson.name).toBe("test-hook");
  });

  it("should dynamically load initialized hooks as tools", async () => {
    // There is one hook initialized in the previous test
    const tools = loadDynamicHooks();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("test-hook");
    expect(tools[0].description).toContain("Custom internal hook tool");
    expect(tools[0].parameters).toHaveProperty("type", "object");
  });

  it("should execute the dev subcommand on /ih dev", async () => {
    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };

    await internalHooksCommand.execute("dev test-hook", mockCtx);

    // Verify dev execution was triggered
    expect(lines.some(l => l.content.includes("Entering workspace") || l.content.includes("Executing dev command"))).toBe(true);
    // Since index.js prints "Hook executed successfully!", verify that was logged as stdout
    expect(lines.some(l => l.content.includes("Hook executed successfully!"))).toBe(true);
  });

  it("should persist active hooks selection in active-hooks.json", async () => {
    const { saveActiveHooksForProject, getActiveHooksForProject, getAvailableHooks } = await import("../src/core/tools/dynamicHooks.js");
    
    const activeList = ["test-hook"];
    saveActiveHooksForProject(tempDir, activeList);

    const loadedList = getActiveHooksForProject(tempDir);
    expect(loadedList).toEqual(activeList);

    const available = getAvailableHooks();
    const testHookMeta = available.find(h => h.dirName === "test-hook");
    expect(testHookMeta).toBeDefined();
    expect(testHookMeta?.active).toBe(true);
  });

  it("should filter loaded dynamic tools based on active state configuration", async () => {
    const { saveActiveHooksForProject } = await import("../src/core/tools/dynamicHooks.js");
    
    // Save empty active hooks configuration (so test-hook is inactive)
    saveActiveHooksForProject(tempDir, []);

    const tools = loadDynamicHooks();
    expect(tools.length).toBe(0); // test-hook should be filtered out
  });

  it("should execute /ih active subcommand, prompt user, and persist selected hooks", async () => {
    const { registerQuestionHandler } = await import("../src/core/tools/state.js");
    const { saveActiveHooksForProject } = await import("../src/core/tools/dynamicHooks.js");
    
    // 1. Pre-set active hooks to empty
    saveActiveHooksForProject(tempDir, []);

    // 2. Register mock interactive question handler that returns the matching option
    registerQuestionHandler(async (question, options, isMultiSelect, initialCheckedIndices) => {
      expect(isMultiSelect).toBe(true);
      expect(options.some(o => o.startsWith("test-hook"))).toBe(true);
      expect(initialCheckedIndices).toEqual([]); // since we saved empty
      return options.find(o => o.startsWith("test-hook")) || "";
    });

    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };

    await internalHooksCommand.execute("active", mockCtx);

    // Verify output shows success
    expect(lines.some(l => l.type === "system" && l.content.includes("Successfully updated active hooks"))).toBe(true);
    expect(lines.some(l => l.content.includes("Active hooks: test-hook"))).toBe(true);

    // Verify it is actually saved
    const { getActiveHooksForProject } = await import("../src/core/tools/dynamicHooks.js");
    expect(getActiveHooksForProject(tempDir)).toEqual(["test-hook"]);

    // Clean up question handler
    registerQuestionHandler(null);
  });

  it("should execute /ih active subcommand, handle cancel, and not modify active hooks list", async () => {
    const { registerQuestionHandler } = await import("../src/core/tools/state.js");
    const { saveActiveHooksForProject, getActiveHooksForProject } = await import("../src/core/tools/dynamicHooks.js");
    
    // 1. Pre-set active hooks to ["test-hook"]
    saveActiveHooksForProject(tempDir, ["test-hook"]);

    // 2. Register mock interactive question handler that returns "__CANCEL__"
    registerQuestionHandler(async (question, options, isMultiSelect, initialCheckedIndices) => {
      expect(isMultiSelect).toBe(true);
      expect(initialCheckedIndices).toEqual([0]); // since we saved ["test-hook"]
      return "__CANCEL__";
    });

    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };

    await internalHooksCommand.execute("active", mockCtx);

    // Verify output shows cancel message
    expect(lines.some(l => l.type === "system" && l.content.includes("Active hooks selection cancelled"))).toBe(true);

    // Verify it is NOT modified (still ["test-hook"])
    expect(getActiveHooksForProject(tempDir)).toEqual(["test-hook"]);

    // Clean up question handler
    registerQuestionHandler(null);
  });
});
