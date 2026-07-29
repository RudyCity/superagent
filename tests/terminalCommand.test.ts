import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { registry } from "../src/core/commands/registry.js";
import { terminalCommand } from "../src/core/commands/terminalCommand.js";
import * as execaModule from "execa";

describe("Terminal Command Interactive Execution", () => {
  let addedLines: ChatLine[] = [];
  let runInteractiveCalled = false;
  let runInteractiveParams: { command: string; cwd: string; env?: any } | null = null;
  const mockRunInteractive = vi.fn().mockImplementation(async (command, cwd, env) => {
    runInteractiveCalled = true;
    runInteractiveParams = { command, cwd, env };
    return 0;
  });

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null,
    runInteractiveProcess: mockRunInteractive,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execaModule, "execa").mockReturnValue({
      all: {
        on: vi.fn(),
      },
      on: vi.fn(),
    } as any);
    addedLines = [];
    runInteractiveCalled = false;
    runInteractiveParams = null;
    mockRunInteractive.mockClear();
  });

  it("should execute foreground terminal command using runInteractiveProcess in-place", async () => {
    // Register command if not already done
    if (!registry.get("terminal")) {
      registry.register(terminalCommand);
    }

    await handleSlashCommand("/terminal node --version", mockCtx as any);

    expect(runInteractiveCalled).toBe(true);
    expect(runInteractiveParams?.command).toBe("node --version");
    expect(addedLines.some(l => l.content.includes("Executing terminal command"))).toBe(true);
    expect(addedLines.some(l => l.content.includes("Process finished with exit code 0"))).toBe(true);
  });

  it("should execute foreground terminal command and display output in chat lines", async () => {
    if (!registry.get("terminal")) {
      registry.register(terminalCommand);
    }

    const mockRunWithOutput = vi.fn().mockResolvedValue({
      exitCode: 0,
      output: "v20.10.0\nHello World",
    });

    const ctx = {
      addLine: (line: ChatLine) => {
        addedLines.push(line);
      },
      exit: () => {},
      agent: null,
      runInteractiveProcess: mockRunWithOutput,
    };

    addedLines = [];
    await handleSlashCommand("/terminal node --version", ctx as any);

    expect(mockRunWithOutput).toHaveBeenCalledWith("node --version", expect.any(String), expect.any(Object), expect.any(Function));
    expect(addedLines.some(l => l.content.includes("v20.10.0\nHello World"))).toBe(true);
    expect(addedLines.some(l => l.content.includes("Process finished with exit code 0"))).toBe(true);
  });
});
