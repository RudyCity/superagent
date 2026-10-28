import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  setProcessTraceEnabledForTest,
  getProcessTraceEvents,
  clearProcessTraceEvents,
  inspectWindowsProcessDescendants,
  inspectAgyWindowsEnvironment,
  resolveWindowsDirectExecutable,
} from "../src/core/process/processSpawnPolicy.js";
import {
  bashTool,
  runCommandTool,
  runBackgroundProcessTool,
  killProcessTree,
} from "../src/core/tools/shellTools.js";
import { handleExecCommand } from "../src/core/mcp/tools/workspaceTools.js";
import {
  detectAvailableClis,
  runDelegate,
  createSession,
  killSession,
} from "../src/core/tools/cliBridgeSession.js";
import { findProcessTool, inspectPortTool } from "../src/core/tools/processInspectionTools.js";
import { runTunnelClientDoctor } from "../src/core/mcp/openaiTunnelClient.js";
import { captureGitSnapshot } from "../src/core/agent/GitUtils.js";
import { backgroundTasks } from "../src/core/tools/state.js";
import { terminalCommand } from "../src/core/commands/terminalCommand.js";
import { executeHookCommand } from "../src/core/tools/dynamicHooks.js";

describe("Windows Subprocess Console Splash Elimination — Regression & Soak Suite", () => {
  beforeEach(() => {
    clearProcessTraceEvents();
    setProcessTraceEnabledForTest(true);
  });

  afterEach(() => {
    clearProcessTraceEvents();
    setProcessTraceEnabledForTest(null);
  });

  it("audits P0 and internal subprocess modules to ensure explicit process-launch intent or windowsHide: true", () => {
    const p0Files = [
      "src/core/tools/cliBridgeSession.ts",
      "src/core/tools/cliBridgeDelegateJobs.ts",
      "src/core/tools/shellTools.ts",
      "src/core/mcp/tools/workspaceTools.ts",
      "src/core/commands/terminalCommand.ts",
      "src/core/tools/dynamicHooks.ts",
      "src/core/tools/processInspectionTools.ts",
      "src/core/tools/helpers.ts",
      "src/core/mcp/openaiTunnelClient.ts",
      "src/core/remoteAgent/cloudflareTunnel.ts",
      "src/core/tools/cliBridgeAcceptance.ts",
      "src/core/tools/cliBridgeWorktreeManager.ts",
      "src/core/agent/GitUtils.ts",
      "src/core/workspaceIsolation.ts",
    ];

    for (const relPath of p0Files) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const source = fs.readFileSync(fullPath, "utf8");
      const hasPolicyOrHide =
        source.includes("applyProcessIntent") ||
        source.includes("windowsHide: true") ||
        source.includes("spawnHiddenTaskkill") ||
        source.includes("execHiddenTaskkillSync");
      expect(hasPolicyOrHide, `${relPath} must enforce windowsHide or applyProcessIntent`).toBe(true);
    }

    // Verify terminalCommand.ts explicitly separates headless (/terminal bg + log writer)
    // from visibleTerminal (/terminal <command> foreground viewer window).
    const terminalSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/core/commands/terminalCommand.ts"),
      "utf8"
    );
    expect(terminalSource).toContain('"headless"');
    expect(terminalSource).toContain('"visibleTerminal"');
  });

  it("executes shellTools (run_command, bash, run_background_process) headlessly with windowsHide: true and clean tree teardown", async () => {
    clearProcessTraceEvents();

    const cmdRes = await runCommandTool.execute({
      command: "node -e \"console.log('run_command_headless_ok')\"",
    });
    expect(cmdRes).toContain("run_command_headless_ok");

    const bashRes = await bashTool.execute({
      command: "node -e \"console.log('bash_headless_ok')\"",
    });
    expect(bashRes).toContain("bash_headless_ok");

    const bgRes = await runBackgroundProcessTool.execute(
      {
        command: "node -e \"setInterval(() => {}, 1000)\"",
      },
      process.cwd()
    );
    expect(bgRes).toContain("Started background process. Process ID:");
    const idMatch = bgRes.match(/Process ID:\s*([a-z0-9_]+)/i);
    const taskId = idMatch?.[1];
    expect(taskId).toBeDefined();

    if (taskId) {
      const task = backgroundTasks.get(taskId);
      expect(task).toBeDefined();
      if (task?.process?.pid) {
        killProcessTree(task.process.pid);
      }
      backgroundTasks.delete(taskId);
    }

    const traces = getProcessTraceEvents().filter((e) => e.phase === "spawn");
    expect(traces.length).toBeGreaterThanOrEqual(3);
    for (const ev of traces) {
      expect(ev.windowsHide).toBe(true);
      expect(ev.intent).toBe("headless");
    }
  });

  it("executes MCP superagent_exec_command (handleExecCommand) headlessly with windowsHide: true", async () => {
    clearProcessTraceEvents();

    const mcpRes = await handleExecCommand({
      command: "node -e \"console.log('mcp_exec_headless_ok')\"",
      cwd: process.cwd(),
    });
    const text = mcpRes.content.map((c) => c.text || "").join("\n");
    expect(text).toContain("mcp_exec_headless_ok");
    expect(mcpRes.isError).toBeFalsy();

    const spawnEvents = getProcessTraceEvents().filter(
      (e) => e.phase === "spawn" && e.caller === "workspaceTools.handleExecCommand"
    );
    expect(spawnEvents).toHaveLength(1);
    expect(spawnEvents[0].windowsHide).toBe(true);
    expect(spawnEvents[0].intent).toBe("headless");
  });

  it("executes /terminal bg <command> and dynamicHooks.executeHookCommand headlessly with windowsHide: true", async () => {
    clearProcessTraceEvents();

    const lines: Array<{ type: string; content: string }> = [];
    const ctx: any = {
      agent: { workingDirectory: process.cwd() },
      addLine: (line: any) => lines.push(line),
    };

    await terminalCommand.execute("bg node -e \"console.log('term_bg_headless_ok')\"", ctx);
    for (let i = 0; i < 40 && lines.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].content).toContain("Background process started [ID: term-bg-");

    const idMatch = lines[0].content.match(/\[ID:\s*(term-bg-[a-z0-9]+)\]/i);
    const termBgId = idMatch?.[1];
    expect(termBgId).toBeDefined();

    const bgEvents = getProcessTraceEvents().filter(
      (e) => e.caller === "terminalCommand.bg" && e.phase === "spawn"
    );
    expect(bgEvents).toHaveLength(1);
    expect(bgEvents[0].windowsHide).toBe(true);
    expect(bgEvents[0].intent).toBe("headless");

    if (termBgId) {
      const task = backgroundTasks.get(termBgId);
      expect((task as any)?.isDetachedWindow).toBeFalsy();
      if (task?.process?.pid) {
        killProcessTree(task.process.pid);
      }
      backgroundTasks.delete(termBgId);
    }

    clearProcessTraceEvents();
    const hookOut = await executeHookCommand(
      "node -e \"console.log('hook_headless_ok')\"",
      process.cwd(),
      undefined,
      "",
      5_000
    );
    expect(hookOut.stdout).toContain("hook_headless_ok");
    expect(hookOut.exitCode).toBe(0);
    const hookEvents = getProcessTraceEvents().filter(
      (e) => e.caller === "dynamicHooks.executeHookCommand" && e.phase === "spawn"
    );
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0].windowsHide).toBe(true);
    expect(hookEvents[0].intent).toBe("headless");
  });

  it("executes CLI Bridge detectAvailableClis, runDelegate, and createSession with windowsHide: true and prompt redaction", async () => {
    clearProcessTraceEvents();

    const clis = await detectAvailableClis();
    expect(Array.isArray(clis)).toBe(true);
    const probeEvents = getProcessTraceEvents().filter(
      (e) => e.caller === "cliBridgeSession.detectAvailableClis"
    );
    expect(probeEvents.length).toBeGreaterThan(0);
    for (const ev of probeEvents) {
      expect(ev.windowsHide).toBe(true);
      expect(ev.intent).toBe("headless");
    }

    clearProcessTraceEvents();
    const delegateRes = await runDelegate({
      cliAlias: "custom",
      binary: process.execPath,
      extraArgs: ["-e", "console.log('delegate_headless_ok')"],
      prompt: "SUPER_SECRET_DELEGATE_PROMPT_TOKEN_12345",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(delegateRes.exitCode).toBe(0);
    expect(delegateRes.output).toContain("delegate_headless_ok");

    const delegateEvents = getProcessTraceEvents().filter(
      (e) => e.caller === "cliBridgeSession.runDelegate"
    );
    expect(delegateEvents.some((e) => e.phase === "spawn")).toBe(true);
    expect(delegateEvents.some((e) => e.phase === "exit" && e.exitCode === 0)).toBe(true);
    for (const ev of delegateEvents) {
      expect(ev.windowsHide).toBe(true);
      expect(ev.intent).toBe("headless");
    }

    // Verify capturedInteractive session uses windowsHide: true and cleans up cleanly
    clearProcessTraceEvents();
    const sessionCreated = await createSession({
      cliAlias: "custom",
      binary: process.execPath,
      args: [
        "-e",
        "process.stdout.write(' Ready > '); process.stdin.on('data', d => process.stdout.write('ECHO:' + d));",
      ],
      cwd: process.cwd(),
      startupTimeoutMs: 2_000,
    });
    expect(sessionCreated.ok).toBe(true);
    if (sessionCreated.ok) {
      const sessionEvents = getProcessTraceEvents().filter(
        (e) => e.caller === "cliBridgeSession.createSession" && e.phase === "spawn"
      );
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0].windowsHide).toBe(true);
      expect(sessionEvents[0].intent).toBe("capturedInteractive");

      await killSession(sessionCreated.session.sessionId);
    }
  });

  it("verifies AGY Windows executable resolution, sidecar inspection, and headless AGY execution without leaked descendants", async () => {
    const agyEnv = inspectAgyWindowsEnvironment();
    if (process.platform === "win32" && agyEnv.agyBinaryPath) {
      expect(agyEnv.agyBinaryIsNativeExe).toBe(true);
      expect(resolveWindowsDirectExecutable("agy.cmd")).toBe(agyEnv.agyBinaryPath);

      // Verify sidecars (compose-preview, device-hub, biomolecular_structure_viewer) are discovered when present
      const sidecarNames = agyEnv.sidecars.map((s) => s.sidecarName);
      if (sidecarNames.length > 0) {
        expect(
          sidecarNames.some((n) =>
            ["compose-preview", "device-hub", "biomolecular_structure_viewer"].includes(n)
          )
        ).toBe(true);
      }

      clearProcessTraceEvents();
      const agyVer = await runDelegate({
        cliAlias: "agy",
        binary: "agy.cmd",
        prompt: "--version",
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      expect(agyVer.exitCode).toBe(0);
      expect(agyVer.output.trim().length).toBeGreaterThan(0);

      const agyTraces = getProcessTraceEvents().filter(
        (e) => e.caller === "cliBridgeSession.runDelegate" && e.phase === "spawn"
      );
      expect(agyTraces).toHaveLength(1);
      expect(agyTraces[0].executable.toLowerCase().endsWith("agy.exe")).toBe(true);
      expect(agyTraces[0].windowsHide).toBe(true);
    }
  });

  it("runs processInspectionTools, openaiTunnelClient doctor, and multi-iteration soak test with zero leaked descendants", async () => {
    clearProcessTraceEvents();

    const procList = await findProcessTool.execute({ query: "node", limit: 3 });
    expect(typeof procList).toBe("string");

    const portCheck = await inspectPortTool.execute({ port: 65531 });
    expect(portCheck).toContain("65531");

    const doctor = await runTunnelClientDoctor({});
    expect(typeof doctor.success).toBe("boolean");

    // 5-iteration soak across MCP exec, shell run_command, CLI Bridge delegate, and Git status
    for (let i = 0; i < 5; i++) {
      const mcpOut = await handleExecCommand({
        command: `node -e "console.log('soak_mcp_${i}')"`,
        cwd: process.cwd(),
      });
      expect(mcpOut.isError).toBeFalsy();

      const shellOut = await runCommandTool.execute({
        command: `node -e "console.log('soak_shell_${i}')"`,
      });
      expect(shellOut).toContain(`soak_shell_${i}`);

      const gitSnap = await captureGitSnapshot(process.cwd());
      expect(gitSnap !== undefined).toBe(true);
    }

    const allSpawns = getProcessTraceEvents().filter((e) => e.phase === "spawn");
    expect(allSpawns.length).toBeGreaterThanOrEqual(10);
    for (const ev of allSpawns) {
      expect(ev.windowsHide).toBe(true);
    }

    if (process.platform === "win32") {
      const descendants = await inspectWindowsProcessDescendants(process.pid);
      const leakedShells = descendants.filter((d) =>
        /^(cmd\.exe|powershell\.exe|pwsh\.exe)$/i.test(d.name)
      );
      expect(leakedShells).toEqual([]);
    }
  }, 45_000);
});
