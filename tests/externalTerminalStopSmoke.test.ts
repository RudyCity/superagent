/**
 * Opt-in Windows acceptance smoke. Creates and terminates ONLY a disposable
 * Bun listener started by this test process. Never targets existing services.
 * Run explicitly with SUPERAGENT_EXPLICIT_EXTERNAL_STOP_SMOKE=1.
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { discoverExternalTerminalProcesses, invalidateExternalProcessCache } from "../src/core/runtime/externalTerminalProcesses.js";
import {
  observeExternalProcess, configureExternalStart, prepareExternalStop,
  stopExternalProcess, getStoppedExternalProcesses, startStoppedExternal,
} from "../src/core/runtime/externalTerminalControl.js";

const enabled = process.platform === "win32" &&
  process.env.SUPERAGENT_EXPLICIT_EXTERNAL_STOP_SMOKE === "1";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("external process stop smoke (opt-in, disposable child only)", () => {
  it.skipIf(!enabled)("birth-verifies, stops and relaunches only a disposable test child", async () => {
    const port = await availablePort();
    const code = 'Bun.serve({hostname:"127.0.0.1",port:' + port +
      ',fetch(){return new Response("ok")}});setInterval(()=>{},1000)';
    const child = Bun.spawn(["bun", "-e", code], {
      cwd: process.cwd(), stdout: "ignore", stderr: "pipe",
    });
    const pid = child.pid;
    const taskId = "external-win-" + pid;
    try {
      let observed: any = undefined;
      for (let i = 0; i < 30; i++) {
        invalidateExternalProcessCache();
        observed = (await discoverExternalTerminalProcesses()).find(
          (item) => item.pid === pid && item.ports.includes(port) && item.creationIdentity);
        if (observed) break;
        await wait(250);
      }
      expect(observed).toBeDefined();
      expect(observeExternalProcess(observed).canStop).toBe(true);
      const saved = configureExternalStart(taskId, "echo manually-configured", process.cwd());
      expect(saved.canStart).toBe(false);
      const plan = await prepareExternalStop(taskId);
      expect(plan.pid).toBe(pid);
      expect(plan.ports).toContain(port);
      const stopped = await stopExternalProcess(taskId, plan.operationId);
      expect(stopped.success).toBe(true);
      expect(getStoppedExternalProcesses().find((item) => item.id === taskId)?.canStart).toBe(true);
      let launchCalls = 0;
      const newTask = await startStoppedExternal(taskId, (command, cwd) => {
        launchCalls++;
        expect(command).toBe("echo manually-configured");
        expect(cwd).toBe(process.cwd());
        return { success: true, taskId: "term-bg-controlled" };
      });
      expect(newTask).toEqual({ success: true, taskId: "term-bg-controlled" });
      expect(launchCalls).toBe(1);
    } finally {
      try { child.kill(); } catch {}
    }
  }, 60000);
});
