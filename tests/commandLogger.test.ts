import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  createCommandLog,
  getCurrentCommandLogPath,
  formatOutputWithLogReference,
  getCommandLogsDir,
  getLatestCommandLogPath,
} from "../src/core/tools/commandLogger.js";
import { bashTool, runCommandTool } from "../src/core/tools/shellTools.js";

describe("commandLogger", () => {
  it("creates log file, writes header, streams chunks, and writes completion footer", () => {
    const cmd = "echo 'hello world'";
    const cwd = process.cwd();

    const logger = createCommandLog(cmd, cwd);

    expect(fs.existsSync(logger.logPath)).toBe(true);
    expect(fs.existsSync(logger.latestLogPath)).toBe(true);
    expect(getCurrentCommandLogPath()).toBe(logger.logPath);

    const initialContent = fs.readFileSync(logger.logPath, "utf-8");
    expect(initialContent).toContain("Superagent Command Execution Log");
    expect(initialContent).toContain(cmd);
    expect(initialContent).toContain(logger.id);

    // Stream chunks
    logger.write("First output chunk\n");
    logger.write("Second output chunk\n");

    const streamedContent = fs.readFileSync(logger.logPath, "utf-8");
    expect(streamedContent).toContain("First output chunk");
    expect(streamedContent).toContain("Second output chunk");

    const latestContent = fs.readFileSync(logger.latestLogPath, "utf-8");
    expect(latestContent).toContain("First output chunk");
    expect(latestContent).toContain("Second output chunk");

    // End command
    logger.end(0);

    const finalContent = fs.readFileSync(logger.logPath, "utf-8");
    expect(finalContent).toContain("Completed:");
    expect(finalContent).toContain("Exit Code: 0");

    expect(getCurrentCommandLogPath()).toBeUndefined();
  });

  it("handles exit code non-zero with error message", () => {
    const logger = createCommandLog("false", process.cwd());
    logger.write("command failed with error\n");
    logger.end(1, "Command exited with code 1");

    const content = fs.readFileSync(logger.logPath, "utf-8");
    expect(content).toContain("Exit Code: 1");
    expect(content).toContain("Error:     Command exited with code 1");
  });

  it("formatOutputWithLogReference preserves small outputs", () => {
    const output = "line 1\nline 2\nline 3";
    const formatted = formatOutputWithLogReference(output, 10, "/path/to/log.log");
    expect(formatted).toBe(output);
  });

  it("formatOutputWithLogReference truncates large outputs and includes logPath reference", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const formatted = formatOutputWithLogReference(lines, 10, "C:\\test\\cmd.log");

    expect(formatted).toContain("line 30");
    expect(formatted).toContain("line 21");
    expect(formatted).not.toContain("line 1\n");
    expect(formatted).toContain("... (output truncated to last 10 lines, full log saved at: C:\\test\\cmd.log)");
  });

  it("bashTool creates automatic log file during execution", async () => {
    const res = await bashTool.execute({ command: "echo automatic_bash_log_test" }, process.cwd());
    expect(res).toContain("automatic_bash_log_test");

    const latestLog = getLatestCommandLogPath();
    expect(fs.existsSync(latestLog)).toBe(true);
    const content = fs.readFileSync(latestLog, "utf-8");
    expect(content).toContain("automatic_bash_log_test");
    expect(content).toContain("Exit Code: 0");
  });

  it("runCommandTool creates automatic log file during execution", async () => {
    const res = await runCommandTool.execute({ command: "echo automatic_run_cmd_test" }, process.cwd());
    expect(res).toContain("automatic_run_cmd_test");

    const latestLog = getLatestCommandLogPath();
    expect(fs.existsSync(latestLog)).toBe(true);
    const content = fs.readFileSync(latestLog, "utf-8");
    expect(content).toContain("automatic_run_cmd_test");
    expect(content).toContain("Exit Code: 0");
  });
});
