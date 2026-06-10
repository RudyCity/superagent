import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { normalizeForMatching, getToolByName, formatCommandForPowerShell } from "./tools.js";
import fs from "fs/promises";
import path from "path";

// Mock execa to avoid running real shell commands in the unit tests
vi.mock("execa", () => {
  return {
    execa: vi.fn().mockImplementation((cmd, args, options) => {
      const actualArgs = Array.isArray(args) ? args : [];
      
      const mockResult = {
        stdout: "mocked process stdout",
        exitCode: 0,
        all: "mocked process stdout and stderr",
      };

      if (cmd === "git") {
        if (actualArgs.includes("status")) {
          mockResult.stdout = "M src/app.tsx";
        } else if (actualArgs.includes("diff")) {
          mockResult.stdout = "diff contents";
        } else if (actualArgs.includes("commit")) {
          mockResult.stdout = "committed";
        } else if (actualArgs.includes("log")) {
          mockResult.stdout = "commit log 1\ncommit log 2";
        }
      } else if (cmd === "rg") {
        mockResult.stdout = "src/app.tsx:10:match content";
      } else if (typeof cmd === "string" && cmd.startsWith("android")) {
        mockResult.stdout = "mocked android output";
      }

      const mockPromise: any = Promise.resolve(mockResult);
      mockPromise.on = vi.fn().mockImplementation((event, callback) => {
        if (event === "close") {
          setTimeout(() => callback(0), 10);
        }
        return mockPromise;
      });
      mockPromise.all = {
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "data") {
            setTimeout(() => callback(Buffer.from("mock process output")), 10);
          }
          return mockPromise.all;
        })
      };
      mockPromise.kill = vi.fn();

      return mockPromise;
    }),
  };
});

// Mock global fetch for webSearch and fetchUrl tools
global.fetch = vi.fn().mockImplementation((url) => {
  if (url.includes("duckduckgo.com")) {
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(`
<div class="result">
  <div>
    <a class="result__url" href="https://example.com/uddg=https%3A%2F%2Fexample.com%2Fsearch-result">Test Search Result</a>
    <div class="result__snippet">Test snippet details here.</div>
  </div>
</div>
</div>
      `),
    } as any);
  }
  return Promise.resolve({
    ok: true,
    text: () => Promise.resolve("Clean mocked page content"),
  } as any);
});

describe("normalizeForMatching", () => {
  it("should convert CRLF to LF", () => {
    expect(normalizeForMatching("line 1\r\nline 2")).toBe("line 1\nline 2");
  });

  it("should trim trailing spaces on each line", () => {
    expect(normalizeForMatching("line 1   \nline 2 ")).toBe("line 1\nline 2");
  });
});

describe("formatCommandForPowerShell", () => {
  it("should convert simple && command chains", () => {
    expect(formatCommandForPowerShell("echo 1 && echo 2")).toBe("echo 1; if ($?) { echo 2 }");
    expect(formatCommandForPowerShell("a && b && c")).toBe("a; if ($?) { b; if ($?) { c } }");
  });

  it("should ignore && inside single or double quotes", () => {
    expect(formatCommandForPowerShell("echo \"hello && world\"")).toBe("echo \"hello && world\"");
    expect(formatCommandForPowerShell("echo 'foo && bar'")).toBe("echo 'foo && bar'");
  });
});

describe("File tools", () => {
  const testFile = path.resolve(process.cwd(), "temp_unit_test.txt");

  beforeEach(async () => {
    await fs.writeFile(testFile, "line A\nline B\nline C\n", "utf-8");
  });

  afterEach(async () => {
    try {
      await fs.unlink(testFile);
    } catch {}
  });

  it("should read a file using readTool", async () => {
    const tool = getToolByName("read");
    const result = await tool?.execute({ filePath: "temp_unit_test.txt", offset: 1, limit: 2 }, process.cwd());
    expect(result).toBe("1: line A\n2: line B");
  });

  it("should write a file using writeTool", async () => {
    const tool = getToolByName("write");
    const result = await tool?.execute({ filePath: "temp_unit_test.txt", content: "new data" }, process.cwd());
    expect(result).toContain("File written");
    const data = await fs.readFile(testFile, "utf-8");
    expect(data).toBe("new data");
  });

  it("should edit a file using editTool", async () => {
    const tool = getToolByName("edit");
    const result = await tool?.execute(
      { filePath: "temp_unit_test.txt", oldString: "line B", newString: "line B Edited" },
      process.cwd()
    );
    expect(result).toContain("File edited");
    const data = await fs.readFile(testFile, "utf-8");
    expect(data).toContain("line B Edited");
  });

  it("should write to file using writeToFileTool", async () => {
    const tool = getToolByName("write_to_file");
    const result = await tool?.execute({ filePath: "temp_unit_test.txt", content: "overwritten content", overwrite: true }, process.cwd());
    expect(result).toContain("File written successfully");
    const data = await fs.readFile(testFile, "utf-8");
    expect(data).toBe("overwritten content");
  });
});

describe("Search and Grep tools", () => {
  it("should glob match files in project using globTool", async () => {
    const tool = getToolByName("glob");
    const result = await tool?.execute({ pattern: "src/core/*.ts" }, process.cwd());
    expect(result).toContain("src/core/tools.ts");
  });

  it("should search pattern using grepTool", async () => {
    const tool = getToolByName("grep");
    const result = await tool?.execute({ pattern: "normalizeForMatching", path: "src/core/tools.ts" }, process.cwd());
    expect(result).toContain("tools.ts");
  });

  it("should search using ripgrepSearchTool", async () => {
    const tool = getToolByName("ripgrep_search");
    const result = await tool?.execute({ pattern: "normalize" }, process.cwd());
    expect(result).toContain("match content");
  });
});

describe("Web and Fetch tools", () => {
  it("should execute fetchUrlTool", async () => {
    const tool = getToolByName("fetch_url");
    const result = await tool?.execute({ url: "https://example.com/api" }, process.cwd());
    expect(result).toBe("Clean mocked page content");
  });

  it("should execute webSearchTool", async () => {
    const tool = getToolByName("web_search");
    const result = await tool?.execute({ query: "vitest test" }, process.cwd());
    expect(result).toContain("search-result");
  });
});

describe("Command execution and Task management tools", () => {
  it("should run simple commands with runCommandTool", async () => {
    const tool = getToolByName("run_command");
    const result = await tool?.execute({ command: "echo hello" }, process.cwd());
    expect(result).toBe("mocked process stdout and stderr");
  });

  it("should run bash commands with bashTool", async () => {
    const tool = getToolByName("bash");
    const result = await tool?.execute({ command: "echo hello" }, process.cwd());
    expect(result).toContain("mocked process stdout");
  });

  it("should run background commands, list them, and terminate them", async () => {
    const runBg = getToolByName("run_background");
    const killTask = getToolByName("kill_task");
    const viewBg = getToolByName("view_background_tasks");
    const manageTask = getToolByName("manage_task");

    const runResult = await runBg?.execute({ command: "sleep 10" }, process.cwd());
    expect(runResult).toContain("Started task in background");

    const taskId = runResult?.split("ID: ")[1]?.trim() || "";

    const listResult = await viewBg?.execute({}, process.cwd());
    expect(listResult).toContain(taskId);

    const statusResult = await manageTask?.execute({ action: "status", taskId }, process.cwd());
    expect(statusResult).toContain("Running/Completed");

    const killResult = await killTask?.execute({ taskId }, process.cwd());
    expect(killResult).toContain("killed successfully");
  });
});

describe("Scheduler and Subagent tools", () => {
  it("should schedule a job with scheduleTool", async () => {
    const tool = getToolByName("schedule");
    const result = await tool?.execute({ prompt: "My timer", durationSeconds: 2 }, process.cwd());
    expect(result).toContain("One-shot timer scheduled");
  });

  it("should define, invoke, list, and message subagents", async () => {
    const defSub = getToolByName("define_subagent");
    const invSub = getToolByName("invoke_subagent");
    const sendMsg = getToolByName("send_message");
    const manageSubs = getToolByName("manage_subagents");

    const defRes = await defSub?.execute(
      { name: "test_subagent", description: "testing", systemPrompt: "system text" },
      process.cwd()
    );
    expect(defRes).toContain("Subagent type \"test_subagent\" defined");

    const invRes = await invSub?.execute(
      { typeName: "test_subagent", role: "reviewer", prompt: "review this code" },
      process.cwd()
    );
    expect(invRes).toBeDefined();

    const listRes = await manageSubs?.execute({ action: "list" }, process.cwd());
    expect(listRes).toBeDefined();
  });
});

describe("Ask question, Patch and Screenshot tools", () => {
  it("should execute askQuestionTool interactively error", async () => {
    const tool = getToolByName("ask_question");
    const result = await tool?.execute({ question: "Is this correct?", options: ["Yes", "No"] }, process.cwd());
    expect(result).toContain("must be executed interactively");
  });

  it("should apply patch using applyPatchTool", async () => {
    const tool = getToolByName("apply_patch");
    const testFile = path.resolve(process.cwd(), "temp_patch_test.txt");
    await fs.writeFile(testFile, "hello world\noriginal line\n", "utf-8");

    const patch = `
<<<<<<<
original line
=======
patched line
>>>>>>>
`;
    const result = await tool?.execute({ filePath: "temp_patch_test.txt", patchContent: patch }, process.cwd());
    expect(result).toContain("Patch applied successfully");

    const data = await fs.readFile(testFile, "utf-8");
    expect(data).toContain("patched line");
    await fs.unlink(testFile);
  });

  it("should run gitActionTool", async () => {
    const tool = getToolByName("git_action");
    const status = await tool?.execute({ action: "status" }, process.cwd());
    expect(status).toBe("M src/app.tsx");

    const diff = await tool?.execute({ action: "diff" }, process.cwd());
    expect(diff).toBe("diff contents");

    const log = await tool?.execute({ action: "log", limit: 2 }, process.cwd());
    expect(log).toBe("commit log 1\ncommit log 2");
  });

  it("should run androidCliTool", async () => {
    const tool = getToolByName("android_cli");
    const result = await tool?.execute({ command: "sdk list" }, process.cwd());
    expect(result).toBe("mocked android output");
  });

  it("should capture screenshot using screenshotTool", async () => {
    const tool = getToolByName("screenshot");
    const result = await tool?.execute({}, process.cwd());
    expect(result).toBeDefined();
    if (process.platform === "win32") {
      expect(result).toContain("Screenshot successfully captured");
      // Cleanup any captured screenshots
      const globFiles = await fs.readdir(process.cwd());
      for (const file of globFiles) {
        if (file.startsWith("screenshot_") && file.endsWith(".png")) {
          await fs.unlink(path.resolve(process.cwd(), file));
        }
      }
    } else {
      expect(result).toContain("only supported on Windows");
    }
  });
});
