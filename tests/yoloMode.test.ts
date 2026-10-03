/**
 * tests/yoloMode.test.ts
 *
 * Verifies scoped YOLO mode functionality:
 * - Scope boundary: project workspace and exactly 1 parent level above.
 * - Auto-approval of in-scope file writes and shell commands.
 * - Strict refusal to auto-approve out-of-scope targets (grandparents, root drives).
 * - Strict refusal to auto-approve access to model-config.json.
 * - Slash command /yolo [on|off|status] behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import {
  isYoloMode,
  setYoloMode,
  getYoloAllowedRoot,
  isPathWithinYoloScope,
  isToolCallWithinYoloScope,
} from "../src/core/permissions.js";
import { yoloCommand } from "../src/core/commands/coreCommands.js";

describe("Scoped YOLO Mode – Core Scope & Boundary Detection", () => {
  const isWin = process.platform === "win32";
  const fakeWs = isWin
    ? "D:\\dev\\projects\\my-agent"
    : "/home/user/dev/projects/my-agent";
  const fakeParent = isWin
    ? "D:\\dev\\projects"
    : "/home/user/dev/projects";
  const fakeGrandparent = isWin
    ? "D:\\dev"
    : "/home/user/dev";
  const fakeSibling = isWin
    ? "D:\\dev\\projects\\other-app"
    : "/home/user/dev/projects/other-app";

  beforeEach(() => {
    setYoloMode(false);
  });

  afterEach(() => {
    setYoloMode(false);
  });

  it("defaults to disabled (false)", () => {
    expect(isYoloMode()).toBe(false);
  });

  it("can be enabled and disabled via setYoloMode", () => {
    setYoloMode(true);
    expect(isYoloMode()).toBe(true);
    setYoloMode(false);
    expect(isYoloMode()).toBe(false);
  });

  it("computes exactly 1 parent directory as allowed root", () => {
    const allowed = getYoloAllowedRoot(fakeWs);
    expect(allowed.toLowerCase()).toBe(fakeParent.toLowerCase());
  });

  it("allows paths inside the project workspace", () => {
    const fileInside = path.join(fakeWs, "src", "index.ts");
    expect(isPathWithinYoloScope(fileInside, fakeWs)).toBe(true);
  });

  it("allows paths in sibling projects (under the 1-parent root)", () => {
    const siblingFile = path.join(fakeSibling, "package.json");
    expect(isPathWithinYoloScope(siblingFile, fakeWs)).toBe(true);
  });

  it("allows paths directly in the 1-parent directory", () => {
    const parentFile = path.join(fakeParent, "shared.config.js");
    expect(isPathWithinYoloScope(parentFile, fakeWs)).toBe(true);
  });

  it("blocks paths 2 levels up in grandparent directory", () => {
    const grandparentFile = path.join(fakeGrandparent, "top-secret.env");
    expect(isPathWithinYoloScope(grandparentFile, fakeWs)).toBe(false);
  });

  it("blocks paths on a completely different drive or root", () => {
    const otherDrive = isWin ? "C:\\Windows\\System32\\cmd.exe" : "/etc/shadow";
    expect(isPathWithinYoloScope(otherDrive, fakeWs)).toBe(false);
  });
});

describe("Scoped YOLO Mode – Tool Call Inspection", () => {
  const isWin = process.platform === "win32";
  const fakeWs = isWin
    ? "D:\\dev\\projects\\my-agent"
    : "/home/user/dev/projects/my-agent";
  const fakeSibling = isWin
    ? "D:\\dev\\projects\\sibling-lib"
    : "/home/user/dev/projects/sibling-lib";

  beforeEach(() => {
    setYoloMode(true);
  });

  afterEach(() => {
    setYoloMode(false);
  });

  it("approves in-scope file write tools", () => {
    const inScopeToolCall = {
      name: "write_to_file",
      args: {
        filePath: path.join(fakeWs, "src", "file.ts"),
        content: "console.log('hello');",
      },
    };
    expect(isToolCallWithinYoloScope(inScopeToolCall, fakeWs)).toBe(true);
  });

  it("approves sibling project file writes under 1 parent level", () => {
    const siblingToolCall = {
      name: "replace_file_content",
      args: {
        TargetFile: path.join(fakeSibling, "README.md"),
        TargetContent: "old",
        ReplacementContent: "new",
      },
    };
    expect(isToolCallWithinYoloScope(siblingToolCall, fakeWs)).toBe(true);
  });

  it("blocks file writes targeting grandparent directory (2 levels up)", () => {
    const outToolCall = {
      name: "write_to_file",
      args: {
        filePath: isWin ? "D:\\dev\\escaped.txt" : "/home/user/dev/escaped.txt",
        content: "bad",
      },
    };
    expect(isToolCallWithinYoloScope(outToolCall, fakeWs)).toBe(false);
  });

  it("strictly blocks any tool call targeting model-config.json", () => {
    const modelCfgCall = {
      name: "write_to_file",
      args: {
        filePath: path.join(fakeWs, "model-config.json"),
        content: "{}",
      },
    };
    // Even if path is inside fakeWs, model-config.json is strictly forbidden from YOLO auto-approval
    expect(isToolCallWithinYoloScope(modelCfgCall, fakeWs)).toBe(false);
  });

  it("approves safe shell commands in workspace", () => {
    const cmdCall = {
      name: "run_command",
      args: {
        command: "npm test",
        cwd: fakeWs,
      },
    };
    expect(isToolCallWithinYoloScope(cmdCall, fakeWs)).toBe(true);
  });

  it("approves relative 1-level traversal (cd ..) within 1-parent scope", () => {
    const cdParentCall = {
      name: "run_command",
      args: {
        command: "cd .. && ls",
        cwd: fakeWs,
      },
    };
    expect(isToolCallWithinYoloScope(cdParentCall, fakeWs)).toBe(true);
  });

  it("blocks relative 2-level traversal (cd ../..) escaping 1-parent scope", () => {
    const cdGrandparentCall = {
      name: "run_command",
      args: {
        command: "cd ../.. && ls",
        cwd: fakeWs,
      },
    };
    expect(isToolCallWithinYoloScope(cdGrandparentCall, fakeWs)).toBe(false);
  });

  it("blocks shell commands targeting model-config.json", () => {
    const catModelCfg = {
      name: "run_command",
      args: {
        command: "cat ~/.superagent-r/model-config.json",
        cwd: fakeWs,
      },
    };
    expect(isToolCallWithinYoloScope(catModelCfg, fakeWs)).toBe(false);
  });

  it("blocks shell commands referencing user home directory when outside 1-parent scope", () => {
    const homeDir = os.homedir();
    const allowedRoot = getYoloAllowedRoot(fakeWs);
    // If user home is not in fakeWs or fakeParent, home command should be rejected
    const isHomeInside = homeDir.toLowerCase().startsWith(allowedRoot.toLowerCase());
    if (!isHomeInside) {
      const homeCall = {
        name: "run_command",
        args: {
          command: "cat ~/.ssh/id_rsa",
          cwd: fakeWs,
        },
      };
      expect(isToolCallWithinYoloScope(homeCall, fakeWs)).toBe(false);
    }
  });
});

describe("/yolo slash command", () => {
  beforeEach(() => {
    setYoloMode(false);
  });

  afterEach(() => {
    setYoloMode(false);
  });

  function makeMockCtx() {
    const lines: Array<{ type: string; content: string }> = [];
    return {
      agent: { workingDirectory: process.cwd() } as any,
      addLine: (line: any) => lines.push(line),
      getLines: () => lines,
    };
  }

  it("enables YOLO mode with '/yolo on'", async () => {
    const ctx = makeMockCtx();
    await yoloCommand.execute("on", ctx as any);
    expect(isYoloMode()).toBe(true);
    expect(ctx.getLines()[0].content).toContain("YOLO Mode Enabled");
  });

  it("disables YOLO mode with '/yolo off'", async () => {
    setYoloMode(true);
    const ctx = makeMockCtx();
    await yoloCommand.execute("off", ctx as any);
    expect(isYoloMode()).toBe(false);
    expect(ctx.getLines()[0].content).toContain("YOLO Mode Disabled");
  });

  it("shows status with '/yolo status'", async () => {
    const ctx = makeMockCtx();
    await yoloCommand.execute("status", ctx as any);
    expect(ctx.getLines()[0].content).toContain("YOLO Mode Status: INACTIVE");

    setYoloMode(true);
    const ctx2 = makeMockCtx();
    await yoloCommand.execute("status", ctx2 as any);
    expect(ctx2.getLines()[0].content).toContain("YOLO Mode Status: ACTIVE");
  });

  it("toggles state when run with no arguments", async () => {
    const ctx1 = makeMockCtx();
    await yoloCommand.execute("", ctx1 as any);
    expect(isYoloMode()).toBe(true);

    const ctx2 = makeMockCtx();
    await yoloCommand.execute("", ctx2 as any);
    expect(isYoloMode()).toBe(false);
  });
});

describe("Scoped YOLO Mode – Permission Handler Integration", () => {
  const isWin = process.platform === "win32";
  const fakeWs = isWin
    ? "D:\\dev\\projects\\my-agent"
    : "/home/user/dev/projects/my-agent";
  const fakeSibling = isWin
    ? "D:\\dev\\projects\\sibling-pkg"
    : "/home/user/dev/projects/sibling-pkg";

  afterEach(() => {
    setYoloMode(false);
  });

  // Replicate permissionHandler logic from app.tsx / cliMain.tsx
  function evaluatePermission(toolCall: any, description: string, ws: string = fakeWs): boolean {
    if (isYoloMode() && isToolCallWithinYoloScope(toolCall, ws) && !description.includes("model-config.json")) {
      return true; // YOLO auto-approval
    }
    // Default safety prompt / rejection
    return false;
  }

  it("rejects without prompt when YOLO is off", () => {
    setYoloMode(false);
    const tc = {
      name: "write_to_file",
      args: { filePath: path.join(fakeWs, "test.ts") },
    };
    expect(evaluatePermission(tc, "write", fakeWs)).toBe(false);
  });

  it("auto-approves in-workspace write when YOLO is on", () => {
    setYoloMode(true);
    const tc = {
      name: "write_to_file",
      args: { filePath: path.join(fakeWs, "test.ts") },
    };
    expect(evaluatePermission(tc, "write", fakeWs)).toBe(true);
  });

  it("auto-approves 1-parent sibling write when YOLO is on", () => {
    setYoloMode(true);
    const tc = {
      name: "write_to_file",
      args: { filePath: path.join(fakeSibling, "index.ts") },
    };
    expect(evaluatePermission(tc, "write", fakeWs)).toBe(true);
  });

  it("does NOT auto-approve grandparent write even when YOLO is on", () => {
    setYoloMode(true);
    const tc = {
      name: "write_to_file",
      args: { filePath: isWin ? "D:\\dev\\root.txt" : "/home/user/dev/root.txt" },
    };
    expect(evaluatePermission(tc, "write", fakeWs)).toBe(false);
  });

  it("does NOT auto-approve model-config.json even when YOLO is on", () => {
    setYoloMode(true);
    const tc = {
      name: "write_to_file",
      args: { filePath: path.join(fakeWs, "model-config.json") },
    };
    expect(evaluatePermission(tc, "Protected file access detected: model-config.json", fakeWs)).toBe(false);
  });
});
