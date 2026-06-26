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
    expect(fsSync.existsSync(path.join(hookDir, "README.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(hookDir, "CHANGELOG.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(hookDir, ".git"))).toBe(true);

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

  it("should execute the dev subcommand on /ih dev and set workspace focus", async () => {
    const lines: ChatLine[] = [];
    let focusedHook: string | null = "";
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
      setActiveDevHook: (name) => {
        focusedHook = name;
      },
    };

    await internalHooksCommand.execute("dev test-hook", mockCtx);

    // Verify focus was set and confirmation message was printed
    expect(focusedHook).toBe("test-hook");
    expect(lines.some(l => l.content.includes("Workspace focus set to internal hook"))).toBe(true);
  });

  it("should clear workspace focus on /ih dev off", async () => {
    const lines: ChatLine[] = [];
    let focusedHook: string | null = "some-hook";
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
      setActiveDevHook: (name) => {
        focusedHook = name;
      },
    };

    await internalHooksCommand.execute("dev off", mockCtx);

    // Verify focus was cleared
    expect(focusedHook).toBeNull();
    expect(lines.some(l => l.content.includes("Cleared active internal hook"))).toBe(true);
  });

  it("should persist active hooks selection in model-config.json", async () => {
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

  it("should dynamically register custom slash commands from hook.json", async () => {
    const { saveActiveHooksForProject } = await import("../src/core/tools/dynamicHooks.js");
    const { registry } = await import("../src/core/commands/registry.js");
    
    // Save active hooks list to include our hook
    saveActiveHooksForProject(tempDir, ["test-hook"]);

    // Write a hook.json with a slash command
    const hookDir = path.join(tempDir, "internal-hooks", "test-hook");
    const hookJson = {
      name: "test-hook",
      description: "Custom internal hook tool description",
      command: "node index.js",
      slash_commands: [
        {
          name: "hook-test-cmd",
          aliases: ["htc"],
          description: "Hook test command description",
          command: "node index.js --test"
        }
      ]
    };
    await fs.writeFile(path.join(hookDir, "hook.json"), JSON.stringify(hookJson, null, 2));

    // Reload hooks (this registers the commands)
    loadDynamicHooks();

    // Check that command is registered in registry
    const command = registry.get("hook-test-cmd");
    expect(command).toBeDefined();
    expect(command?.name).toBe("hook-test-cmd");
    expect(command?.description).toBe("Hook test command description");
    expect(command?.aliases).toEqual(["htc"]);
  });

  it("should execute pre_tool and post_tool event hooks without throwing", async () => {
    const { runEventHooks } = await import("../src/core/tools/dynamicHooks.js");
    const hookDir = path.join(tempDir, "internal-hooks", "test-hook");
    
    // Update hook.json with event hooks
    const hookJson = {
      name: "test-hook",
      description: "Custom internal hook tool description",
      command: "node index.js",
      event_hooks: [
        {
          event: "pre_tool",
          command: "node index.js --pre-tool-trigger"
        }
      ]
    };
    await fs.writeFile(path.join(hookDir, "hook.json"), JSON.stringify(hookJson, null, 2));

    // Execute the hook event
    await expect(
      runEventHooks("pre_tool", { toolName: "read", args: { filePath: "test.txt" }, cwd: tempDir })
    ).resolves.not.toThrow();
  });

  it("should dynamically load skills from active hooks skills subdirectory", async () => {
    const { getInstalledSkills } = await import("../src/core/config/skills.js");
    const hookDir = path.join(tempDir, "internal-hooks", "test-hook");
    const skillDir = path.join(hookDir, "skills", "dynamic-hook-skill");
    await fs.mkdir(skillDir, { recursive: true });

    // Write a dummy SKILL.md
    const skillMd = `---
name: Dynamic Hook Skill
description: Dynamic hook skill description
---
# Dynamic Hook Skill
Dynamic hook skill body
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd);

    const skills = getInstalledSkills();
    const dynamicSkill = skills.find(s => s.name === "Dynamic Hook Skill");
    expect(dynamicSkill).toBeDefined();
    expect(dynamicSkill?.description).toBe("Dynamic hook skill description");
  });

  it("should dynamically load skills from active hooks .agents/skills subdirectory", async () => {
    const { getInstalledSkills } = await import("../src/core/config/skills.js");
    const hookDir = path.join(tempDir, "internal-hooks", "test-hook-agents");
    const skillDir = path.join(hookDir, ".agents", "skills", "dynamic-hook-agents-skill");
    await fs.mkdir(skillDir, { recursive: true });

    // Write a dummy SKILL.md
    const skillMd = `---
name: Dynamic Hook Agents Skill
description: Dynamic hook agents skill description
---
# Dynamic Hook Agents Skill
Dynamic hook agents skill body
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd);

    const skills = getInstalledSkills();
    const dynamicSkill = skills.find(s => s.name === "Dynamic Hook Agents Skill");
    expect(dynamicSkill).toBeDefined();
    expect(dynamicSkill?.description).toBe("Dynamic hook agents skill description");
  });

  it("should list discovered hooks and their exposed features on /ih list", async () => {
    const hookDir = path.join(tempDir, "internal-hooks", "test-hook");
    // Write hook.json with all capabilities to ensure they are reported
    const hookJson = {
      name: "test-hook",
      description: "Custom internal hook tool description",
      command: "node index.js",
      slash_commands: [
        {
          name: "hook-test-cmd",
          command: "node index.js --test"
        }
      ],
      event_hooks: [
        {
          event: "pre_tool",
          command: "node index.js --pre-tool"
        }
      ]
    };
    await fs.writeFile(path.join(hookDir, "hook.json"), JSON.stringify(hookJson, null, 2));

    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };

    await internalHooksCommand.execute("list", mockCtx);

    const listLine = lines.find(l => l.content.includes("Discovered Internal Hooks"));
    expect(listLine).toBeDefined();
    expect(listLine?.content).toContain("test-hook");
    expect(listLine?.content).toContain("Active");
    expect(listLine?.content).toContain("Exposes: Tool AI, Slash Commands (/hook-test-cmd), Event Hooks (pre_tool), Dynamic Skills");
  });

  it("should write telemetry logs to hooks.log upon execution", async () => {
    const logFile = path.join(tempDir, "internal-hooks", "hooks.log");
    
    // Clear log if exists
    if (fsSync.existsSync(logFile)) {
      await fs.unlink(logFile);
    }

    // Write a dummy index.js inside the tempDir so node index.js runs successfully
    await fs.writeFile(path.join(tempDir, "index.js"), "console.log('Mock success');");

    // 1. Trigger command execution (slash command execute)
    const { registry } = await import("../src/core/commands/registry.js");
    const command = registry.get("hook-test-cmd");
    expect(command).toBeDefined();
    
    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };
    await command?.execute("", mockCtx);

    // Verify hooks.log exists and contains log entries
    expect(fsSync.existsSync(logFile)).toBe(true);
    const logs = await fs.readFile(logFile, "utf-8");
    expect(logs).toContain("[COMMAND: /hook-test-cmd]");
    expect(logs).toContain("STATUS: SUCCESS");
  });

  it("should list available internal hooks on /ih dev without hook name", async () => {
    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
    };

    await internalHooksCommand.execute("dev", mockCtx);

    const devListLine = lines.find(l => l.content.includes("Available internal hooks for development"));
    expect(devListLine).toBeDefined();
    expect(devListLine?.content).toContain("test-hook");
    expect(devListLine?.content).toContain("Active");
    expect(devListLine?.content).toContain("To start development, run:");
  });

  it("should auto-activate the hook on /ih dev if it is not already active", async () => {
    const { saveActiveHooksForProject, getActiveHooksForProject } = await import("../src/core/tools/dynamicHooks.js");
    
    // Deactivate our test-hook by saving an empty list
    saveActiveHooksForProject(tempDir, []);
    expect(getActiveHooksForProject(tempDir)).toEqual([]);

    const lines: ChatLine[] = [];
    const mockCtx: SlashCommandContext = {
      addLine: (line) => lines.push(line),
      exit: () => {},
      agent: null,
      setActiveDevHook: () => {},
    };

    // Run `/ih dev test-hook` which should trigger auto-activation
    await internalHooksCommand.execute("dev test-hook", mockCtx);

    // Verify it is now auto-activated
    expect(getActiveHooksForProject(tempDir)).toContain("test-hook");
  });
});
