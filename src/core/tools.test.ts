import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { normalizeForMatching, getToolByName, formatCommandForPowerShell, verifySyntax } from "./tools.js";
import fs from "fs/promises";
import path from "path";
import { agentLocalStorage } from "./agent.js";
import { getGlobalConfigDir } from "./config.js";

// Mock execa to avoid running real shell commands in the unit tests
vi.mock("execa", () => {
  return {
    execa: vi.fn().mockImplementation((cmd, args, options) => {
      const actualArgs = Array.isArray(args) ? args : [];
      
      const isError = typeof cmd === "string" && cmd.includes("invalid_command");
      const mockResult = {
        stdout: isError ? "" : "mocked process stdout",
        exitCode: isError ? 127 : 0,
        all: isError ? "command not found" : "mocked process stdout and stderr",
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
      } else if (typeof cmd === "string" && cmd.toLowerCase().includes("android")) {
        mockResult.stdout = "mocked android output";
      }

      const mockPromise: any = Promise.resolve(mockResult);
      mockPromise.on = vi.fn().mockImplementation((event, callback) => {
        if (event === "close") {
          const delay = (typeof cmd === "string" && cmd.includes("sleep")) ? 3000 : 10;
          const code = (typeof cmd === "string" && cmd.includes("invalid_command")) ? 127 : 0;
          setTimeout(() => callback(code), delay);
        }
        return mockPromise;
      });
      mockPromise.all = {
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === "data") {
            const dataToEmit = (typeof cmd === "string" && cmd.includes("long_output"))
              ? Buffer.from("line\n".repeat(60))
              : Buffer.from("mock process output");
            setTimeout(() => callback(dataToEmit), 10);
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

describe("verifySyntax", () => {
  const tempTestFile = path.resolve(process.cwd(), "temp_syntax_test.ts");

  afterEach(async () => {
    try {
      await fs.unlink(tempTestFile);
    } catch {}
  });

  it("should pass valid syntax", async () => {
    await fs.writeFile(tempTestFile, "const x = { a: 1 };", "utf-8");
    const result = await verifySyntax(tempTestFile);
    expect(result).toBeNull();
  });

  it("should fail unmatched brackets", async () => {
    await fs.writeFile(tempTestFile, "const x = { a: 1;", "utf-8");
    const result = await verifySyntax(tempTestFile);
    expect(result).toContain("Syntax check failed");
  });

  it("should ignore brackets inside comments", async () => {
    await fs.writeFile(tempTestFile, "const x = 1; // unmatched } comment\n/* multi-line {\n */", "utf-8");
    const result = await verifySyntax(tempTestFile);
    expect(result).toBeNull();
  });

  it("should ignore brackets inside strings", async () => {
    await fs.writeFile(tempTestFile, "const s = 'unmatched { string'; const d = \"unmatched }\"; const t = `unmatched [`;", "utf-8");
    const result = await verifySyntax(tempTestFile);
    expect(result).toBeNull();
  });

  it("should ignore brackets inside regexes", async () => {
    await fs.writeFile(tempTestFile, "const r = /[a-z{]/; const x = 1 / 2;", "utf-8");
    const result = await verifySyntax(tempTestFile);
    expect(result).toBeNull();
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

  it("should read a file using readTool and handle binary content check", async () => {
    const tool = getToolByName("read");
    const result = await tool?.execute({ filePath: "temp_unit_test.txt", offset: 1, limit: 2 }, process.cwd());
    expect(result).toBe("1: line A\n2: line B");
    
    // Write binary content and verify it fails
    const binaryFile = path.resolve(process.cwd(), "temp_binary_test.bin");
    await fs.writeFile(binaryFile, Buffer.from([0, 1, 2, 3, 4]));
    const binResult = await tool?.execute({ filePath: "temp_binary_test.bin" }, process.cwd());
    expect(binResult).toContain("Error: Cannot read binary file");
    await fs.unlink(binaryFile);
  });

  it("should replace file content using replaceFileContentTool", async () => {
    const tool = getToolByName("replace_file_content");
    const result = await tool?.execute(
      { filePath: "temp_unit_test.txt", targetContent: "line B", replacementContent: "line B Edited", startLine: 1, endLine: 3 },
      process.cwd()
    );
    expect(result).toContain("File updated successfully");
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
    const result = await tool?.execute({ command: "echo hello", cwd: "src" }, process.cwd());
    expect(result).toBe("mocked process stdout and stderr");
  });

  it("should run background commands, list them, and terminate them", async () => {
    const runBg = getToolByName("run_background_process");
    const manageTask = getToolByName("manage_background_process");

    const runResult = await runBg?.execute({ command: "sleep 10", cwd: "src" }, process.cwd());
    expect(runResult).toContain("Started background process");

    const processId = runResult?.split("ID: ")[1]?.trim() || "";

    const listResult = await manageTask?.execute({ action: "list" }, process.cwd());
    expect(listResult).toContain(processId);

    const statusResult = await manageTask?.execute({ action: "status", processId }, process.cwd());
    expect(statusResult).toContain("Running/Completed");

    const killResult = await manageTask?.execute({ action: "kill", processId }, process.cwd());
    expect(killResult).toContain("killed successfully");
  });

  it("should fail instantly for bad background commands", async () => {
    const runBg = getToolByName("run_background_process");
    const result = await runBg?.execute({ command: "invalid_command" }, process.cwd());
    expect(result).toContain("Error: Background process failed instantly");
  });

  it("should write background task outputs to a .log file and truncate instant exits if they exceed 20 lines", async () => {
    const runBg = getToolByName("run_background_process");
    // "long_output" does not sleep, so it exits instantly
    const result = await runBg?.execute({ command: "long_output" }, process.cwd());
    
    expect(result).toContain("output truncated, full logs saved at:");
    
    // Extract task ID from output or construct log path
    const match = result?.match(/full logs saved at: (.*\.log)/);
    expect(match).not.toBeNull();
    const logPath = match![1];
    
    // Check if the log file was created and contains the complete logs
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("line\n");
    // Verify it contains the exit code info as well
    expect(logContent).toContain("[Process exited with code 0]");
    
    // Clean up
    await fs.unlink(logPath);
  });

  it("should truncate status outputs to 50 lines if task is running and outputs exceed 50 lines", async () => {
    const runBg = getToolByName("run_background_process");
    const manageTask = getToolByName("manage_background_process");
    
    // Run background task that sleeps and produces long output
    const runResult = await runBg?.execute({ command: "sleep 10 long_output" }, process.cwd());
    const processId = runResult?.split("ID: ")[1]?.trim() || "";
    
    // Wait slightly for data events to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));
    
    const statusResult = await manageTask?.execute({ action: "status", processId }, process.cwd());
    expect(statusResult).toContain("output truncated, full logs saved at:");
    
    const match = statusResult?.match(/full logs saved at: (.*\.log)/);
    expect(match).not.toBeNull();
    const logPath = match![1];
    
    // Check status content has 50 lines (plus the truncation message)
    expect(statusResult).toContain("line");
    
    // Clean up
    await manageTask?.execute({ action: "kill", processId }, process.cwd());
    try {
      await fs.unlink(logPath);
    } catch {}
  });
});

describe("Scheduler and Subagent tools", () => {
  it("should schedule a job with scheduleTool", async () => {
    const tool = getToolByName("schedule");
    const result = await tool?.execute({ prompt: "My timer", durationSeconds: 2 }, process.cwd());
    expect(result).toContain("One-shot timer scheduled");
  });

  it("should support subscribeToSchedules and notify when a schedule triggers", async () => {
    const { subscribeToSchedules, notifyScheduleTriggered } = await import("./tools/state.js");
    const triggered: Array<{ jobId: string; prompt: string }> = [];
    const unsub = subscribeToSchedules((jobId, prompt) => {
      triggered.push({ jobId, prompt });
    });

    notifyScheduleTriggered("job123", "Hello schedule");
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toEqual({ jobId: "job123", prompt: "Hello schedule" });

    unsub();
  });

  it("should define, invoke, list, and message subagents with delegation depth checks", async () => {
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
      { typeName: "test_subagent", role: "reviewer", prompt: "review this code", wait: false },
      process.cwd()
    );
    expect(invRes).toBeDefined();

    const listRes = await manageSubs?.execute({ action: "list" }, process.cwd());
    expect(listRes).toBeDefined();

    // Verify subagent delegation depth blocking
    const parentAgent: any = { delegationDepth: 2 };
    await agentLocalStorage.run(parentAgent, async () => {
      const result = await invSub?.execute(
        { typeName: "test_subagent", role: "reviewer", prompt: "nested subagent call" },
        process.cwd()
      );
      expect(result).toContain("Maximum subagent delegation depth (2) reached");
    });
  });
});

describe("Ask question, Patch and Screenshot tools", () => {
  it("should execute askQuestionTool interactively error", async () => {
    const tool = getToolByName("ask_question");
    const result = await tool?.execute({ question: "Is this correct?", options: ["Yes", "No"] }, process.cwd());
    expect(result).toContain("must be executed interactively");
  });

  it("should apply patch using applyPatchTool (search-replace and unified diff)", async () => {
    const tool = getToolByName("apply_patch");
    const testFile = path.resolve(process.cwd(), "temp_patch_test.txt");
    
    // Test search-replace block format
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
    let data = await fs.readFile(testFile, "utf-8");
    expect(data).toContain("patched line");

    // Test unified diff format
    await fs.writeFile(testFile, "hello world\noriginal line\n", "utf-8");
    const unifiedDiff = `
--- temp_patch_test.txt
+++ temp_patch_test.txt
@@ -2,1 +2,1 @@
-original line
+patched unified line
`;
    const uniResult = await tool?.execute({ filePath: "temp_patch_test.txt", patchContent: unifiedDiff }, process.cwd());
    expect(uniResult).toContain("Patch applied successfully");
    data = await fs.readFile(testFile, "utf-8");
    expect(data).toContain("patched unified line");
    
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
    expect(result).toContain("Screenshot successfully captured");
    // Cleanup any captured screenshots
    const globFiles = await fs.readdir(process.cwd());
    for (const file of globFiles) {
      if (file.startsWith("screenshot_") && file.endsWith(".png")) {
        await fs.unlink(path.resolve(process.cwd(), file));
      }
    }
  });

  it("should run fuzzyScore calculations correctly", async () => {
    const { fuzzyScore } = await import("./historySearch.js");
    expect(fuzzyScore("Hello World", "Hello")).toBe(1.0);
    expect(fuzzyScore("Database Migration", "data mig")).toBeGreaterThan(0);
    expect(fuzzyScore("Database Migration", "something unrelated")).toBe(0);
  });

  it("should execute search_history tool and find matches in mock files", async () => {
    const tool = getToolByName("search_history");
    const historyDir = path.join(getGlobalConfigDir(), "history");
    await fs.mkdir(historyDir, { recursive: true });

    const currentSanitized = process.cwd().replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const mockFilePath = path.join(historyDir, `${currentSanitized}_unit_test_search.json`);

    const mockContent = [
      { role: "user", content: "How do we write a database schema?" },
      { role: "assistant", content: "Use Postgres with Knex migrations." }
    ];

    await fs.writeFile(mockFilePath, JSON.stringify(mockContent), "utf-8");

    try {
      const result = await tool?.execute({ query: "Knex Postgres" }, process.cwd());
      expect(result).toContain("Postgres with Knex migrations");
      expect(result).toContain("unit/test/search");
    } finally {
      try {
        await fs.unlink(mockFilePath);
      } catch {}
    }
  });
});
