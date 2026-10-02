import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { manageBackgroundProcessTool } from "../src/core/tools/backgroundProcessTools.js";
import { runBackgroundProcessTool } from "../src/core/tools/shellTools.js";
import { backgroundTasks } from "../src/core/tools/state.js";

describe("manageBackgroundProcessTool - stream and logs actions", () => {
  beforeEach(() => {
    backgroundTasks.clear();
  });

  afterEach(async () => {
    // Kill any remaining tasks
    for (const [id, task] of backgroundTasks.entries()) {
      try {
        task.process.kill();
      } catch {}
    }
    backgroundTasks.clear();
  });

  it("should support 'logs' and 'log' as aliases for status output", async () => {
    const dummyTask = {
      id: "proc_dummy",
      command: "node -e 'console.log(1)'",
      process: { killed: false } as any,
      output: ["Line 1\n", "Line 2\n"],
      logPath: "",
      hasExited: true,
      exitCode: 0,
      cwd: process.cwd(),
      startedAt: Date.now(),
    };
    backgroundTasks.set("proc_dummy", dummyTask as any);

    const logsResult = await manageBackgroundProcessTool.execute(
      { processId: "proc_dummy", action: "logs" },
      process.cwd()
    );
    expect(logsResult).toContain("Process: node -e 'console.log(1)'");
    expect(logsResult).toContain("Line 1");
    expect(logsResult).toContain("Line 2");

    const logResult = await manageBackgroundProcessTool.execute(
      { processId: "proc_dummy", action: "log" },
      process.cwd()
    );
    expect(logResult).toContain("Line 1");
  });

  it("should sample live output with stream action without hanging on running processes", async () => {
    // Start a long-running process that periodically outputs
    const longRunningCmd =
      process.platform === "win32"
        ? 'powershell -NoProfile -Command "Write-Output \'server ready\'; Start-Sleep -Seconds 30"'
        : "echo 'server ready'; sleep 30";

    const runResult = await runBackgroundProcessTool.execute(
      { command: longRunningCmd },
      process.cwd()
    );
    const match = runResult.match(/process ID:\s*([a-zA-Z0-9_-]+)/i);
    expect(match).not.toBeNull();
    const procId = match![1];

    // Wait a brief moment for initial output to be produced
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Stream with a 300ms window - MUST complete quickly and NOT wait 30s
    const startTime = Date.now();
    const streamResult = await manageBackgroundProcessTool.execute(
      { processId: procId, action: "stream", timeout: 300 },
      process.cwd()
    );
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(3000); // Definitely didn't wait 30s
    expect(streamResult).toContain(procId);
    expect(streamResult).toMatch(/window; process is still running|completed with exit code/);

    // Clean up
    await manageBackgroundProcessTool.execute(
      { processId: procId, action: "kill" },
      process.cwd()
    );
  }, 10000);
});
