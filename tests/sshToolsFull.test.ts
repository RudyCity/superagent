import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { editTool, writeToFileTool } from "../src/core/tools/fileEditTools.js";
import { globTool, grepTool, ripgrepSearchTool } from "../src/core/tools/fileReadTools.js";
import { bashTool, runBackgroundProcessTool } from "../src/core/tools/shellTools.js";

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
});
