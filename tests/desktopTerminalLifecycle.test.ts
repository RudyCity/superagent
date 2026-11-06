import { describe, expect, it } from "vitest";
import { DesktopTerminalManager } from "../src/core/runtime/desktopTerminalManager.js";

describe("Tray terminal lifecycle ownership", () => {
  it("rejects control or restart of foreign and historical process IDs", async () => {
    expect(() => DesktopTerminalManager.startTask("external-win-12345"))
      .toThrow(/Only Tray-launched/);
    expect(() => DesktopTerminalManager.startTask("term-bg-nonexst"))
      .toThrow(/Original Tray command/);
    await expect(DesktopTerminalManager.controlTask("external-win-12345", "pause"))
      .rejects.toThrow(/restricted to Tray-owned/);
    await expect(DesktopTerminalManager.controlTask("term-bg-nonexst", "pause"))
      .rejects.toThrow(/No live Tray-owned/);
  });

  it("starts a stopped Tray task with a fresh task ID instead of reusing its PID", async () => {
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 12" : "sleep 12";
    const first = DesktopTerminalManager.launchTask({ command });
    try {
      expect(() => DesktopTerminalManager.startTask(first.taskId))
        .toThrow(/already active/);
    } finally {
      DesktopTerminalManager.killTask(first.taskId);
    }

    const next = DesktopTerminalManager.startTask(first.taskId);
    try {
      expect(next.taskId).not.toBe(first.taskId);
      expect(next.pid).toBeGreaterThan(0);
      expect(next.command).toBe(command);
    } finally {
      DesktopTerminalManager.killTask(next.taskId);
    }
  }, 20000);

  it.skipIf(!["win32", "linux"].includes(process.platform))(
    "pauses and resumes a real exclusively-owned task without changing its PID",
    async () => {
      const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
      const task = DesktopTerminalManager.launchTask({ command });
      try {
        const paused = await DesktopTerminalManager.controlTask(task.taskId, "pause");
        expect(paused.status).toBe("paused");
        const list = await DesktopTerminalManager.listTasks({ runningOnly: true });
        const entry = list.tasks.find((item) => item.id === task.taskId);
        expect(entry?.status).toBe("paused");
        expect(entry?.canPause).toBe(false);
        expect(entry?.canResume).toBe(true);
        expect(entry?.canStop).toBe(true);
        await expect(DesktopTerminalManager.controlTask(task.taskId, "pause"))
          .rejects.toThrow(/already paused/);

        const resumed = await DesktopTerminalManager.controlTask(task.taskId, "resume");
        expect(resumed.status).toBe("running");
        const running = await DesktopTerminalManager.listTasks({ runningOnly: true });
        expect(running.tasks.find((item) => item.id === task.taskId)?.pid).toBe(task.pid);
      } finally {
        // A failed resume must not leave a test task suspended.
        try { await DesktopTerminalManager.controlTask(task.taskId, "resume"); } catch {}
        DesktopTerminalManager.killTask(task.taskId);
      }
    }, 45000);
});
