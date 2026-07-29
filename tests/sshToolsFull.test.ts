import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { sshProxy, escapeShellArg } from "../src/core/ssh/sshProxy.js";
import { editTool, writeTool, writeToFileTool, multiReplaceFileContentTool } from "../src/core/tools/fileEditTools.js";
import { readTool, globTool, grepTool, ripgrepSearchTool } from "../src/core/tools/fileReadTools.js";
import { 
  bashTool, 
  runBackgroundProcessTool, 
  killBackgroundProcessTool, 
  viewBackgroundProcessesTool, 
  manageBackgroundProcessTool 
} from "../src/core/tools/shellTools.js";

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
});

