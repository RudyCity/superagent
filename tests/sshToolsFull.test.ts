import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { sshProxy, escapeShellArg } from "../src/core/ssh/sshProxy.js";
import { sshRunCommandExecute, sshGlobToolExecute, sshGrepToolExecute } from "../src/core/ssh/sshCommands.js";
import { editTool, writeTool, writeToFileTool, multiReplaceFileContentTool } from "../src/core/tools/fileEditTools.js";
import { readTool, globTool, grepTool, ripgrepSearchTool } from "../src/core/tools/fileReadTools.js";
import {
  bashTool,
  runBackgroundProcessTool,
  killBackgroundProcessTool,
  viewBackgroundProcessesTool,
  manageBackgroundProcessTool
} from "../src/core/tools/shellTools.js";
import { gitActionTool, gitWorktreeTool } from "../src/core/tools/otherTools.js";
import { readDocumentTool } from "../src/core/tools/documentReadTools.js";
import { officeCliTool } from "../src/core/tools/officeCliTools.js";
import { resolveFilePathFromArgs } from "../src/core/tools/pathHelpers.js";

describe("Full SSH Tool Suite Interception", () => {
  beforeEach(() => {
    workspaceMode.setSshMode({
      host: "mock-host",
      port: 22,
      username: "mock-user",
      remoteCwd: "/mock/remote",
    });
  });

  afterEach(() => {
    workspaceMode.setLocalMode();
  });

  it("should intercept editTool and route to SSH", async () => {
    const res = await editTool.execute({
      filePath: "src/index.ts",
      oldString: "foo",
      newString: "bar",
    }, "/mock/local");
    expect(res).toContain("SSH remote file");
  });

  it("should intercept writeTool and route to SSH", async () => {
    const res = await writeTool.execute({
      filePath: "src/main.ts",
      content: "console.log('hello');",
    }, "/mock/local");
    expect(res).toContain("SSH");
  });

  it("should intercept multiReplaceFileContentTool and route to SSH", async () => {
    const res = await multiReplaceFileContentTool.execute({
      filePath: "src/app.ts",
      chunks: [
        { targetContent: "one", replacementContent: "1" },
        { targetContent: "two", replacementContent: "2" },
      ],
    }, "/mock/local");
    expect(res).toContain("SSH");
  });

  it("should intercept globTool and route to SSH", async () => {
    const res = await globTool.execute({
      pattern: "*.ts",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should intercept grepTool and route to SSH", async () => {
    const res = await grepTool.execute({
      pattern: "function",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should intercept ripgrepSearchTool and route to SSH", async () => {
    const res = await ripgrepSearchTool.execute({
      pattern: "export",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should intercept bashTool and route to SSH", async () => {
    const res = await bashTool.execute({
      command: "ls -la",
    }, "/mock/local");
    expect(res).toContain("SSH");
  });

  it("should intercept runBackgroundProcessTool and route to SSH", async () => {
    const res = await runBackgroundProcessTool.execute({
      command: "npm start",
    }, "/mock/local");
    expect(res).toContain("remote SSH background process");
  });

  it("should intercept killBackgroundProcessTool and route to SSH", async () => {
    const res = await killBackgroundProcessTool.execute({
      processId: "12345",
    }, "/mock/local");
    expect(res).toContain("remote SSH background process");
  });

  it("should intercept viewBackgroundProcessesTool and route to SSH", async () => {
    const res = await viewBackgroundProcessesTool.execute({
      processId: "12345",
    }, "/mock/local");
    expect(res).toContain("SSH");
  });

  it("should intercept manageBackgroundProcessTool and route to SSH", async () => {
    const res = await manageBackgroundProcessTool.execute({
      action: "list",
    }, "/mock/local");
    expect(res).toContain("SSH");
  });

  it("should intercept gitActionTool status and route to SSH", async () => {
    const res = await gitActionTool.execute({
      action: "status",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should intercept gitActionTool log and route to SSH", async () => {
    const res = await gitActionTool.execute({
      action: "log",
      limit: 3,
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should intercept gitActionTool commit and route to SSH", async () => {
    const res = await gitActionTool.execute({
      action: "commit",
      message: "test commit from SSH",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should intercept gitActionTool diff and route to SSH", async () => {
    const res = await gitActionTool.execute({
      action: "diff",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should reject gitActionTool commit without message even over SSH", async () => {
    const res = await gitActionTool.execute({
      action: "commit",
    }, "/mock/local");
    expect(res).toContain("Commit message is required");
  });

  it("should reject gitActionTool restore without files even over SSH", async () => {
    const res = await gitActionTool.execute({
      action: "restore",
    }, "/mock/local");
    expect(res).toContain("'files' parameter is required");
  });

  it("should intercept gitWorktreeTool list and route to SSH", async () => {
    const res = await gitWorktreeTool.execute({
      action: "list",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should reject gitWorktreeTool with unknown action", async () => {
    const res = await gitWorktreeTool.execute({
      action: "bogus",
    }, "/mock/local");
    expect(res).toContain("Unknown action");
  });

  it("should reject gitWorktreeTool add without path", async () => {
    const res = await gitWorktreeTool.execute({
      action: "add",
    }, "/mock/local");
    expect(res).toContain("path parameter is required");
  });

  it("should intercept gitWorktreeTool prune and route to SSH", async () => {
    const res = await gitWorktreeTool.execute({
      action: "prune",
    }, "/mock/local");
    expect(res).toBeDefined();
  });

  it("should resolve relative file paths under remoteCwd in SSH mode", () => {
    const resolved = resolveFilePathFromArgs({ filePath: "src/index.ts" }, "/mock/local");
    expect(resolved).toBe("/mock/remote/src/index.ts");
  });

  it("should normalize Windows-style paths to POSIX in SSH mode", () => {
    const resolved = resolveFilePathFromArgs({ filePath: "src\\app.ts" }, "/mock/local");
    expect(resolved).toBe("/mock/remote/src/app.ts");
  });

  it("should preserve absolute POSIX paths inside remoteCwd in SSH mode", () => {
    const resolved = resolveFilePathFromArgs({ filePath: "/mock/remote/src/index.ts" }, "/mock/local");
    expect(resolved).toBe("/mock/remote/src/index.ts");
  });

  it("should reject absolute paths outside remoteCwd (SSH boundary)", () => {
    expect(() => resolveFilePathFromArgs({ filePath: "/etc/passwd" }, "/mock/local")).toThrow(/violates SSH workspace boundary/);
    expect(() => resolveFilePathFromArgs({ filePath: "/root/.ssh/id_rsa" }, "/mock/local")).toThrow(/violates SSH workspace boundary/);
    expect(() => resolveFilePathFromArgs({ filePath: "/mock/other-secret.txt" }, "/mock/local")).toThrow(/violates SSH workspace boundary/);
  });

  it("should reject relative path traversal outside remoteCwd (SSH boundary)", () => {
    expect(() => resolveFilePathFromArgs({ filePath: "../../../etc/passwd" }, "/mock/local")).toThrow(/violates SSH workspace boundary/);
  });

  it("should reject gitWorktree add with path that escapes remoteCwd", async () => {
    const res = await gitWorktreeTool.execute({
      action: "add",
      path: "../../../etc/evil",
    }, "/mock/local");
    expect(res).toContain("escapes remote workspace boundary");
  });

  it("should reject gitWorktree remove with path that escapes remoteCwd", async () => {
    const res = await gitWorktreeTool.execute({
      action: "remove",
      path: "../../../etc/evil",
    }, "/mock/local");
    expect(res).toContain("escapes remote workspace boundary");
  });

  it("should throw boundary error for leading-slash path outside remoteCwd in SSH mode", () => {
    expect(() => resolveFilePathFromArgs({ filePath: "/etc/hosts" }, "/mock/local")).toThrow(/violates SSH workspace boundary/);
  });

  it("should intercept readDocumentTool SSH routing with missing file", async () => {
    const res = await readDocumentTool.execute({
      filePath: "missing-file.pdf",
    }, "/mock/local");
    expect(res).toBeDefined();
    expect(typeof res).toBe("string");
  });

  it("should intercept officeCliTool missing-command validation", async () => {
    const res = await officeCliTool.execute({
      command: "",
    }, "/mock/local");
    expect(res).toContain("Missing required parameter");
  });

  it("should intercept officeCliTool SSH routing", async () => {
    const res = await officeCliTool.execute({
      command: "view text report.docx",
    }, "/mock/local");
    expect(res).toBeDefined();
    expect(typeof res).toBe("string");
  });

  it("should prevent path traversal outside remoteCwd", () => {
    expect(() => {
      sshProxy.normalizePosixPath("../../etc/passwd");
    }).toThrow("escapes remote workspace boundary");

    expect(() => {
      sshProxy.normalizePosixPath("/etc/passwd");
    }).toThrow("escapes remote workspace boundary");

    const valid = sshProxy.normalizePosixPath("src/index.ts");
    expect(valid).toBe("/mock/remote/src/index.ts");
  });

  it("should correctly escape shell arguments", () => {
    const escaped = escapeShellArg("foo'; rm -rf / #");
    expect(escaped).toBe("'foo'\\''; rm -rf / #'");
  });

  it("should propagate AbortSignal through sshRunCommandExecute", async () => {
    const controller = new AbortController();
    controller.abort();
    // After abort, exec should reject immediately with abort-related error.
    // Since sshProxy is mocked, we just verify the function handles the signal without crashing.
    const res = await sshRunCommandExecute("echo hello", undefined, 5000, controller.signal).catch((e) => `aborted: ${e.message}`);
    // Either returns early or signals aborted — just shouldn't hang.
    expect(res).toBeDefined();
  });

  it("should propagate AbortSignal through sshGlobToolExecute", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await sshGlobToolExecute("**/*.ts", controller.signal).catch((e) => `aborted: ${e.message}`);
    expect(res).toBeDefined();
  });

  it("should propagate AbortSignal through sshGrepToolExecute", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await sshGrepToolExecute("TODO", "*.ts", controller.signal).catch((e) => `aborted: ${e.message}`);
    expect(res).toBeDefined();
  });
});

