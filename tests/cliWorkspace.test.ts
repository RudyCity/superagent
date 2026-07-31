import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";

describe("CLI Workspace Flag Parsing", () => {
  let originalArgv: string[];
  let chdirSpy: any;

  beforeEach(() => {
    originalArgv = [...process.argv];
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    chdirSpy.mockRestore();
  });

  it("should detect and parse workspace flag correctly", () => {
    const argv = ["node", "cli.js", "-w", "./some-dir", "my prompt"];
    const workspaceIndex = argv.findIndex(arg => arg === "--workspace" || arg === "-w");
    let workspaceVal: string | undefined = undefined;
    if (workspaceIndex !== -1 && workspaceIndex + 1 < argv.length) {
      const nextArg = argv[workspaceIndex + 1];
      if (!nextArg.startsWith("-")) {
        workspaceVal = nextArg;
      }
    }
    expect(workspaceVal).toBe("./some-dir");

    const resumeIndex = argv.findIndex(arg => arg === "--resume" || arg === "-r");
    let resumeVal: string | undefined = undefined;
    const flags = ["--resume", "-r", "--help", "-h", "--multi", "--workspace", "-w", "--workspace-ssh", "-ws"];
    const positionalArgs = argv.slice(2).filter((arg, idx) => {
      if (flags.includes(arg)) return false;
      if (resumeVal && arg === resumeVal) {
        const prevArg = argv[2 + idx - 1];
        if (prevArg === "--resume" || prevArg === "-r") {
          return false;
        }
      }
      if (workspaceVal && arg === workspaceVal) {
        const prevArg = argv[2 + idx - 1];
        if (prevArg === "--workspace" || prevArg === "-w") {
          return false;
        }
      }
      return true;
    });
    const initialPrompt = positionalArgs.join(" ");
    expect(initialPrompt).toBe("my prompt");
  });
});
