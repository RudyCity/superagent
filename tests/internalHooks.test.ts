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
});
