import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { sshProxy } from "../src/core/ssh/sshProxy.js";
import { sshEditToolExecute, sshMultiEditToolExecute, sshWriteToolExecute } from "../src/core/ssh/sshCommands.js";
import { editTool, writeTool, writeToFileTool, replaceFileContentTool, multiReplaceFileContentTool } from "../src/core/tools/fileEditTools.js";

describe("SSH File Edit Robustness & Line Endings", () => {
  const remoteFiles: Record<string, string> = {};

  beforeEach(() => {
    workspaceMode.setSshMode({
      host: "remote-dev",
      port: 22,
      username: "developer",
      remoteCwd: "/workspace/project",
    });

    for (const k of Object.keys(remoteFiles)) {
      delete remoteFiles[k];
    }

    vi.spyOn(sshProxy, "readFile").mockImplementation(async (filePath: string) => {
      const normalized = sshProxy.normalizePosixPath(filePath);
      const content = remoteFiles[normalized] ?? remoteFiles[filePath];
      if (content === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content;
    });

    vi.spyOn(sshProxy, "writeFile").mockImplementation(async (filePath: string, content: string) => {
      const normalized = sshProxy.normalizePosixPath(filePath);
      remoteFiles[normalized] = content;
      remoteFiles[filePath] = content;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    workspaceMode.setLocalMode();
  });

  it("should replace content across CRLF vs LF differences in sshEditToolExecute", async () => {
    remoteFiles["/workspace/project/src/linux.ts"] = "function hello() {\n  return 'world';\n}\n";
    
    // Windows client sends CRLF target and replacement
    const res = await sshEditToolExecute(
      "/workspace/project/src/linux.ts",
      "function hello() {\r\n  return 'world';\r\n}",
      "function hello() {\r\n  return 'superagent';\r\n}"
    );

    expect(res).toContain("Successfully updated SSH remote file");
    expect(remoteFiles["/workspace/project/src/linux.ts"]).toBe("function hello() {\n  return 'superagent';\n}\n");
  });

  it("should replace chunks across CRLF vs LF differences in sshMultiEditToolExecute", async () => {
    remoteFiles["/workspace/project/src/multi.ts"] = "const a = 1;\nconst b = 2;\n";
    
    const res = await sshMultiEditToolExecute("/workspace/project/src/multi.ts", [
      { TargetContent: "const a = 1;\r\n", ReplacementContent: "const a = 100;\r\n" },
      { target_content: "const b = 2;\r\n", replacement_content: "const b = 200;\r\n" },
    ]);

    expect(res).toContain("Successfully applied 2 chunk edit(s)");
    expect(remoteFiles["/workspace/project/src/multi.ts"]).toBe("const a = 100;\nconst b = 200;\n");
  });

  it("should handle replaceFileContentTool with batch edits and PascalCase aliases in SSH mode", async () => {
    remoteFiles["/workspace/project/src/one.ts"] = "export const A = 1;\n";
    remoteFiles["/workspace/project/src/two.ts"] = "export const B = 2;\n";

    const res = await replaceFileContentTool.execute({
      edits: [
        { TargetFile: "src/one.ts", TargetContent: "export const A = 1;", ReplacementContent: "export const A = 10;" },
        { TargetFile: "src/two.ts", TargetContent: "export const B = 2;", ReplacementContent: "export const B = 20;" },
      ],
    }, "/mock/local");

    expect(res).toContain("Successfully updated SSH remote file: src/one.ts");
    expect(res).toContain("Successfully updated SSH remote file: src/two.ts");
    expect(remoteFiles["/workspace/project/src/one.ts"]).toBe("export const A = 10;\n");
    expect(remoteFiles["/workspace/project/src/two.ts"]).toBe("export const B = 20;\n");
  });

  it("should handle editTool with batch edits and old_string / new_string aliases in SSH mode", async () => {
    remoteFiles["/workspace/project/src/config.ts"] = "const port = 3000;\nconst host = 'localhost';\n";

    const res = await editTool.execute({
      edits: [
        { filePath: "src/config.ts", old_string: "3000", new_string: "8080" },
        { filePath: "src/config.ts", old_string: "'localhost'", new_string: "'0.0.0.0'" },
      ],
    }, "/mock/local");

    expect(res).toContain("Successfully updated SSH remote file");
    expect(remoteFiles["/workspace/project/src/config.ts"]).toBe("const port = 8080;\nconst host = '0.0.0.0';\n");
  });

  it("should handle multiReplaceFileContentTool with ReplacementChunks in SSH mode", async () => {
    remoteFiles["/workspace/project/src/module.ts"] = "import a from 'a';\nimport b from 'b';\n";

    const res = await multiReplaceFileContentTool.execute({
      TargetFile: "src/module.ts",
      ReplacementChunks: [
        { TargetContent: "import a from 'a';", ReplacementContent: "import a from './a.js';" },
        { TargetContent: "import b from 'b';", ReplacementContent: "import b from './b.js';" },
      ],
    }, "/mock/local");

    expect(res).toContain("Successfully applied 2 chunk edit(s)");
    expect(remoteFiles["/workspace/project/src/module.ts"]).toBe("import a from './a.js';\nimport b from './b.js';\n");
  });

  it("should handle writeToFileTool with files batch array and CodeContent alias in SSH mode", async () => {
    const res = await writeToFileTool.execute({
      files: [
        { TargetFile: "src/first.ts", CodeContent: "export const first = 1;" },
        { TargetFile: "src/second.ts", CodeContent: "export const second = 2;" },
      ],
    }, "/mock/local");

    expect(res).toContain("Successfully wrote remote SSH file: src/first.ts");
    expect(res).toContain("Successfully wrote remote SSH file: src/second.ts");
    expect(remoteFiles["/workspace/project/src/first.ts"]).toBe("export const first = 1;");
    expect(remoteFiles["/workspace/project/src/second.ts"]).toBe("export const second = 2;");
  });
});
