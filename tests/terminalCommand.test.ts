import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { registry } from "../src/core/commands/registry.js";
import { terminalCommand } from "../src/core/commands/terminalCommand.js";

vi.mock("execa", () => ({
  execa: vi.fn().mockReturnValue({
    all: {
      on: vi.fn(),
    },
    on: vi.fn(),
  }),
}));

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
    expect(addedLines.some(l => l.content.includes("Executing in-place terminal command"))).toBe(true);
    expect(addedLines.some(l => l.content.includes("Process finished with exit code 0"))).toBe(true);
  });
});
