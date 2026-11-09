import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { DesktopTerminalManager } from "../src/core/runtime/desktopTerminalManager.js";
import { backgroundTasks } from "../src/core/tools/state.js";

const terminalJs = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/terminal.js"),
  "utf8"
);
const actionMenuJs = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/action-menu.js"),
  "utf8"
);

describe("DesktopTerminalManager backend service", () => {
  it("refuses to stop a historical PID without an owned live handle", () => {
    const result = DesktopTerminalManager.killTask("historical-mcp-process-with-no-live-handle");
    expect(result.success).toBe(false);
    expect(result.error).toContain("no live owned process handle");
  });
  it("lists tasks and reflects running vs exited status", async () => {
    const list = await DesktopTerminalManager.listTasks();
    expect(list).toHaveProperty("tasks");
    expect(list).toHaveProperty("runningCount");
    expect(list).toHaveProperty("totalCount");
    expect(Array.isArray(list.tasks)).toBe(true);
  });

  it("retrieves configured terminal presets", () => {
    const presets = DesktopTerminalManager.getPresets();
    expect(Array.isArray(presets)).toBe(true);
  });

  it("launches an ephemeral task, inspects its logs, and terminates it", async () => {
    const cmd = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    const res = DesktopTerminalManager.launchTask({ command: cmd });

    expect(res).toHaveProperty("taskId");
    expect(res).toHaveProperty("pid");
    expect(res.taskId.startsWith("term-bg-")).toBe(true);
    expect(res.pid).toBeGreaterThan(0);

    const listed = await DesktopTerminalManager.listTasks({ runningOnly: true });
    const found = listed.tasks.find((t) => t.id === res.taskId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("running");

    const logs = await DesktopTerminalManager.getLogs(res.taskId);
    expect(logs.taskId).toBe(res.taskId);
    expect(typeof logs.content).toBe("string");

    const killed = DesktopTerminalManager.killTask(res.taskId);
    expect(killed.success).toBe(true);
  });

  it("prunes completed and stale background tasks safely", () => {
    const res = DesktopTerminalManager.pruneStaleTasks();
    expect(res.success).toBe(true);
    expect(typeof res.prunedCount).toBe("number");
    expect(typeof res.remainingRunningCount).toBe("number");
  });
});

function mountTerminalUi(mockResponse?: any) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: any) => any>();
  const documentListeners = new Map<string, Array<(e: any) => any>>();
  const invokeCalls: Array<{ cmd: string; args: any }> = [];

  const defaultMock = {
    tasks: [
      {
        id: "term-bg-dev123",
        command: "npm run dev",
        pid: 12345,
        status: "running",
        cwd: "D:/project/app",
        windowLabel: "dev-server",
        logPath: "C:/logs/term-bg-dev123.log",
        lastOutput: "Ready on http://localhost:3000",
        isTerminal: true,
      },
      {
        id: "term-bg-test456",
        command: "npm test",
        pid: 67890,
        status: "exited",
        exitCode: 0,
        cwd: "D:/project/app",
        windowLabel: "unit-tests",
        logPath: "C:/logs/term-bg-test456.log",
        lastOutput: "All 12 tests passed",
        isTerminal: true,
      },
    ],
    runningCount: 1,
    totalCount: 2,
    presets: [
      { name: "dev", command: "npm run dev", label: "Dev Server" },
      { name: "build", command: "npm run build", label: "Build Production" },
    ],
  };

  const currentData = mockResponse ?? defaultMock;

  function getOrCreateElement(id: string) {
    if (!elements.has(id)) {
      const classSet = new Set<string>();
      const el = {
        id,
        textContent: "",
        innerHTML: "",
        className: "",
        classList: {
          add: (cls: string) => classSet.add(cls),
          remove: (cls: string) => classSet.delete(cls),
          toggle: (cls: string) => (classSet.has(cls) ? classSet.delete(cls) : classSet.add(cls)),
          contains: (cls: string) => classSet.has(cls),
        },
        dataset: {} as Record<string, string>,
        disabled: false,
        hidden: false,
        value: "",
        checked: true,
        addEventListener: (event: string, handler: (e: any) => any) => {
          listeners.set(`${id}:${event}`, handler);
        },
        dispatchEvent: (event: any) => {
          const handler = listeners.get(`${id}:${event.type}`);
          return handler ? handler(event) : true;
        },
        closest: (selector: string) => {
          const className = selector.replace(/^\./, "");
          return classSet.has(className) ? el : null;
        },
      };
      elements.set(id, el);
    }
    return elements.get(id);
  }

  const documentMock = {
    getElementById: (id: string) => getOrCreateElement(id),
    querySelectorAll: () => [],
    addEventListener: vi.fn((event: string, handler: (e: any) => any) => {
      const group = documentListeners.get(event) ?? [];
      group.push(handler);
      documentListeners.set(event, group);
    }),
    readyState: "complete",
  };

  const clipboard = {
    written: "",
    writeText: async (text: string) => {
      clipboard.written = text;
    },
  };

  const windowMock: any = {
    document: documentMock,
    navigator: { clipboard },
    confirm: vi.fn(() => true),
    prompt: vi.fn().mockReturnValue(""),
    alert: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    __TAURI__: {
      core: {
        invoke: vi.fn(async (cmd: string, args: any) => {
          invokeCalls.push({ cmd, args });
          if (cmd === "get_terminal_tasks") {
            let tasks = currentData.tasks;
            if (args?.runningOnly) {
              tasks = tasks.filter((t: any) => t.status === "running" || t.status === "paused");
            }
            return {
              tasks,
              runningCount: currentData.runningCount,
              totalCount: currentData.totalCount,
            };
          }
          if (cmd === "get_terminal_presets") {
            return { presets: currentData.presets };
          }
          if (cmd === "kill_terminal_task") {
            return { success: true };
          }
          if (cmd === "external_terminal_task_action") {
            if (args.action === "plan-stop") return {
              success: true, operationId: "test-operation-001", pid: 31777,
              name: "python.exe", ports: [8095], hasRestartCommand: true,
            };
            return { success: true };
          }
          if (cmd === "control_terminal_task") {
            return { success: true, taskId: args.taskId, status: args.action === "pause" ? "paused" : "running" };
          }
          if (cmd === "get_terminal_logs") {
            return {
              taskId: args.taskId,
              command: "npm run dev",
              content: "[INFO] Server started on port 3000\n[INFO] Ready for requests",
            };
          }
          if (cmd === "launch_terminal_task") {
            return {
              success: true,
              taskId: "term-bg-new999",
              pid: 99999,
              command: args.command || "echo hello",
            };
          }
          if (cmd === "prune_terminal_tasks") {
            return {
              success: true,
              prunedCount: 1,
              remainingRunningCount: 0,
            };
          }
          return { success: true };
        }),
      },
    },
  };

  const context = vm.createContext({
    window: windowMock,
    document: documentMock,
    navigator: windowMock.navigator,
    confirm: windowMock.confirm,
    alert: windowMock.alert,
    console,
    setInterval: () => 123,
    clearInterval: vi.fn(),
    setTimeout: (fn: () => void) => fn(),
    Intl,
    Date,
    Math,
    String,
    JSON,
  });

  vm.runInContext(actionMenuJs, context);
  vm.runInContext(terminalJs, context);

  return {
    windowMock,
    documentMock,
    documentListeners,
    elements,
    listeners,
    invokeCalls,
    clipboard,
    getOrCreateElement,
  };
}

describe("Desktop Terminal UI Controller", () => {
  it("shows unverified MCP PIDs when viewing all tasks without offering an unsafe Stop button", async () => {
    const mounted = mountTerminalUi({
      tasks: [{
        id: "mcp-old-process",
        command: "git status",
        pid: 12345,
        status: "unverified",
        cwd: "D:/project/app",
        source: "mcp",
        isTerminal: true,
        canStop: false,
      }],
      runningCount: 0, totalCount: 1, presets: [],
    });
    mounted.windowMock.__superagentTerminalState.runningOnly = false;
    await mounted.windowMock.__superagentTerminalRefresh();
    const html = mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect(html).toContain("Unverified PID");
    expect(html).toContain("MCP");
    expect(html).not.toContain("terminal-kill-btn");
  });

  it("triggers task pruning when clicking prune completed button", async () => {
    const mounted = mountTerminalUi();
    const pruneBtn = mounted.getOrCreateElement("terminal-prune-btn");
    await pruneBtn.dispatchEvent({ type: "click" });
    const pruneCalls = mounted.invokeCalls.filter((c) => c.cmd === "prune_terminal_tasks");
    expect(pruneCalls.length).toBe(1);
  });
  it("fetches tasks and renders metrics and table rows", async () => {
    const mounted = mountTerminalUi();
    await mounted.windowMock.__superagentTerminalRefresh();

    const statRunning = mounted.getOrCreateElement("terminal-stat-running");
    const statTotal = mounted.getOrCreateElement("terminal-stat-total");
    const statPresets = mounted.getOrCreateElement("terminal-stat-presets");
    const tbody = mounted.getOrCreateElement("terminal-tasks-tbody");

    expect(statRunning.textContent).toBe("1");
    expect(statTotal.textContent).toBe("2");
    expect(statPresets.textContent).toBe("2");
    expect(tbody.innerHTML).toContain("term-bg-dev123");
    expect(tbody.innerHTML).toContain("npm run dev");
  });

  it("opens the compact Actions dropdown without dispatching a process mutation", async () => {
    const mounted = mountTerminalUi();
    await mounted.windowMock.__superagentTerminalRefresh();
    const html = mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect((html.match(/class="sa-action-menu-trigger"/g) || []).length).toBe(2);
    expect(html).not.toContain('class="table-actions"');
    const popover: any = {
      hidden: true, style: { left: "", top: "" },
      offsetWidth: 220, offsetHeight: 180, querySelector: () => null,
    };
    const owner = { querySelector: () => popover };
    const trigger: any = {
      ariaExpanded: "false",
      closest: (selector: string) => selector === ".sa-action-menu-trigger" ? trigger : selector === ".sa-action-menu" ? owner : null,
      setAttribute(name: string, value: string) { if (name === "aria-expanded") this.ariaExpanded = value; },
      getBoundingClientRect: () => ({ top: 200, bottom: 234, left: 500, right: 534 }),
      focus: vi.fn(),
    };
    const event = { target: trigger, preventDefault: vi.fn() };
    await mounted.listeners.get("terminal-tasks-tbody:click")!(event);
    expect(popover.hidden).toBe(false);
    expect(trigger.ariaExpanded).toBe("true");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mounted.invokeCalls.some((x) => ["kill_terminal_task", "external_terminal_task_action", "control_terminal_task"].includes(x.cmd))).toBe(false);
  });

  it("routes a portaled external Stop through the guarded confirmation handler", async () => {
    const mounted = mountTerminalUi({
      tasks: [{
        id: "external-win-31777", command: "python.exe", pid: 31777,
        status: "running", cwd: "-", source: "external",
        canStop: true, canConfigureStart: true, canViewLogs: false,
      }],
      runningCount: 1, totalCount: 1, presets: [],
    });
    mounted.documentMock.body = { appendChild: vi.fn() };
    await mounted.windowMock.__superagentTerminalRefresh();
    const menu: any = {
      hidden: true, style: { left: "", top: "" },
      offsetWidth: 200, offsetHeight: 180, querySelector: () => null,
    };
    const owner = { querySelector: () => menu, appendChild: vi.fn() };
    const trigger: any = {
      closest: (sel: string) =>
        sel === ".sa-action-menu-trigger" ? trigger :
        sel === ".sa-action-menu" ? owner : null,
      setAttribute: vi.fn(),
      getBoundingClientRect: () => ({ top: 110, bottom: 144, left: 270, right: 304 }),
      focus: vi.fn(),
    };
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: trigger });
    expect(mounted.documentMock.body.appendChild).toHaveBeenCalledWith(menu);
    expect(menu.hidden).toBe(false);

    const stop: any = {
      dataset: { taskId: "external-win-31777", action: "stop" },
      disabled: false,
      closest: (selector: string) =>
        selector === ".sa-action-menu-item" || selector === ".terminal-external-btn" ? stop :
        selector === ".sa-action-menu-popover" ? menu : null,
    };
    for (const handler of mounted.documentListeners.get("click") ?? []) {
      await handler({ target: stop });
    }
    await vi.waitFor(() => {
      expect(mounted.invokeCalls.filter((call) =>
        call.cmd === "external_terminal_task_action").map((call) => call.args.action)
      ).toEqual(["plan-stop", "stop"]);
    });
    expect(owner.appendChild).toHaveBeenCalledWith(menu);
    expect(menu.hidden).toBe(true);
  });

  it("handles log inspection modal and clipboard copy", async () => {
    const mounted = mountTerminalUi();
    await mounted.windowMock.__superagentTerminalRefresh();

    const tableHandler = mounted.listeners.get("terminal-tasks-tbody:click");
    expect(tableHandler).toBeDefined();

    const logBtn = mounted.getOrCreateElement("btn-log-click");
    logBtn.dataset.taskId = "term-bg-dev123";
    logBtn.classList.add("terminal-logs-btn");

    await tableHandler!({ target: logBtn });

    const logCalls = mounted.invokeCalls.filter((c) => c.cmd === "get_terminal_logs");
    expect(logCalls.length).toBe(1);
    expect(logCalls[0].args).toEqual({ taskId: "term-bg-dev123" });

    const consoleEl = mounted.getOrCreateElement("terminal-log-console");
    expect(consoleEl.textContent).toContain("Ready for requests");

    // Copy logs
    const copyHandler = mounted.listeners.get("terminal-log-copy:click");
    expect(copyHandler).toBeDefined();
    await copyHandler!({});
    expect(mounted.clipboard.written).toContain("Ready for requests");
  });

  it("kills a running terminal task on stop button click", async () => {
    const mounted = mountTerminalUi();
    await mounted.windowMock.__superagentTerminalRefresh();

    const tableHandler = mounted.listeners.get("terminal-tasks-tbody:click");
    const killBtn = mounted.getOrCreateElement("btn-kill-click");
    killBtn.dataset.taskId = "term-bg-dev123";
    killBtn.dataset.pid = "12345";
    killBtn.dataset.cmd = "npm run dev";
    killBtn.classList.add("terminal-kill-btn");

    await tableHandler!({ target: killBtn });

    const killCalls = mounted.invokeCalls.filter((c) => c.cmd === "kill_terminal_task");
    expect(killCalls.length).toBe(1);
    expect(killCalls[0].args).toEqual({ taskId: "term-bg-dev123" });
  });

  it("renders externally launched processes read-only and excludes them from Kill All", async () => {
    const mounted = mountTerminalUi({
      tasks: [{
        id: "external-win-31320",
        command: "bun.exe (listening on :7100)",
        pid: 31320,
        status: "running",
        cwd: "External process (working directory unavailable)",
        windowLabel: "bun · :7100",
        source: "external",
        canStop: false,
        canViewLogs: false,
        isTerminal: true,
      }],
      runningCount: 1,
      totalCount: 1,
      presets: [],
    });
    await mounted.windowMock.__superagentTerminalRefresh();
    const html = mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect(html).toContain("External (read-only)");
    expect(html).toContain("terminal-unavailable-btn");
    expect(html).toContain("Start");
    expect(html).toContain("Pause");
    expect(html).toContain("Stop");
    expect(html).toContain("Service Controls");
    expect(html).toContain("Action unavailable: ownership or lifecycle state is not verified.");
    expect(html).toContain("sa-action-menu-trigger");
    expect(html).toContain("sa-action-menu-popover");
    expect(html).toContain("aria-haspopup=\"menu\"");
    expect(html).toContain("7100");
    expect(html).toContain("Logs unavailable");
    expect(html).not.toContain("terminal-kill-btn");
    expect(html).not.toContain("terminal-logs-btn");
    expect(mounted.getOrCreateElement("terminal-kill-all-btn").disabled).toBe(true);
    expect(mounted.getOrCreateElement("terminal-filter-running").checked).toBe(false);

    await mounted.getOrCreateElement("terminal-kill-all-btn").dispatchEvent({ type: "click" });
    expect(mounted.invokeCalls.some((entry) => entry.cmd === "kill_terminal_task")).toBe(false);
  });

  it("opens Runtime Detection from external Service Controls without touching its PID", async () => {
    const mounted = mountTerminalUi({
      tasks: [{
        id: "external-win-22880", command: "bun.exe (listening on :7888)",
        pid: 22880, status: "running",
        cwd: "External process (working directory unavailable)",
        source: "external", canStop: false, canViewLogs: false,
      }],
      runningCount: 1, totalCount: 1, presets: [],
    });
    mounted.windowMock.navigateToPage = vi.fn();
    await mounted.windowMock.__superagentTerminalRefresh();
    const button = mounted.getOrCreateElement("manage-22880");
    button.classList.add("terminal-manage-btn");
    button.dataset.taskId = "external-win-22880";
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: button });
    expect(mounted.windowMock.navigateToPage).toHaveBeenCalledWith("runtime");
    expect(mounted.invokeCalls.some((entry) =>
      ["kill_terminal_task", "control_terminal_task", "launch_terminal_task"].includes(entry.cmd)))
      .toBe(false);
  });

  it("enables birth-verified external Stop and can configure and Start a stopped replacement", async () => {
    const data = { tasks: [{
      id: "external-win-31777", command: "python.exe (listening on :8095)",
      pid: 31777, status: "running", source: "external", cwd: "-",
      canStop: true, canConfigureStart: true, canViewLogs: false, isTerminal: true,
    }], runningCount: 1, totalCount: 1, presets: [] };
    const mounted = mountTerminalUi(data);
    await mounted.windowMock.__superagentTerminalRefresh();
    const html = mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('data-action="configure"');
    expect(html).not.toContain('data-action="start"');
    const btn = mounted.getOrCreateElement("external-stop");
    btn.classList.add("terminal-external-btn");
    btn.dataset.taskId = "external-win-31777";
    btn.dataset.action = "stop";
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: btn });
    expect(mounted.invokeCalls.filter((c) => c.cmd === "external_terminal_task_action").map((c) => c.args.action))
      .toEqual(["plan-stop", "stop"]);
    expect(mounted.windowMock.confirm).toHaveBeenCalledOnce();
    expect(mounted.invokeCalls.some((c) => c.cmd === "kill_terminal_task")).toBe(false);

    mounted.windowMock.prompt.mockReturnValueOnce("python app.py").mockReturnValueOnce("D:/project/app");
    const configure = mounted.getOrCreateElement("external-configure");
    configure.classList.add("terminal-external-btn");
    configure.dataset.taskId = "external-win-31777";
    configure.dataset.action = "configure";
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: configure });
    expect(mounted.invokeCalls).toContainEqual({
      cmd: "external_terminal_task_action", args: { taskId: "external-win-31777",
        action: "configure", command: "python app.py", cwd: "D:/project/app", operationId: null },
    });

    data.tasks[0].status = "killed";
    data.tasks[0].canStart = true;
    data.tasks[0].canStop = false;
    await mounted.windowMock.__superagentTerminalRefresh();
    expect(mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML).toContain('data-action="start"');
    const start = mounted.getOrCreateElement("external-start");
    start.classList.add("terminal-external-btn");
    start.dataset.taskId = "external-win-31777";
    start.dataset.action = "start";
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: start });
    expect(mounted.invokeCalls.some((c) => c.cmd === "external_terminal_task_action" && c.args.action === "start")).toBe(true);
  });

  it("never issues a stop after the user declines the external process confirmation", async () => {
    const mounted = mountTerminalUi({ tasks: [{
      id: "external-win-31777", command: "python.exe", pid: 31777, status: "running",
      cwd: "-", source: "external", canStop: true, canConfigureStart: true,
    }], runningCount: 1, totalCount: 1, presets: [] });
    mounted.windowMock.confirm.mockReturnValue(false);
    const stop = mounted.getOrCreateElement("declined-external-stop");
    stop.classList.add("terminal-external-btn");
    stop.dataset.taskId = "external-win-31777";
    stop.dataset.action = "stop";
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: stop });
    const actions = mounted.invokeCalls.filter((c) => c.cmd === "external_terminal_task_action").map((c) => c.args.action);
    expect(actions).toEqual(["plan-stop"]);
  });

  it("offers Start only for restartable stopped Tray tasks", async () => {
    const mounted = mountTerminalUi({tasks: [
      { id: "term-bg-abcdefg", command: "npm run dev", pid: 0,
        cwd: "D:/project/app", status: "killed", canStart: true },
      { id: "external-win-567", command: "unknown.exe", pid: 567,
        cwd: "-", status: "running", source: "external",
        canStart: false, canPause: false, canStop: false },
    ], runningCount: 1, totalCount: 2, presets: [] });
    mounted.windowMock.__superagentTerminalState.runningOnly = false;
    await mounted.windowMock.__superagentTerminalRefresh();
    const html = mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect(html).toContain('data-task-id="term-bg-abcdefg" data-action="start"');
    expect(html).not.toContain('data-action="pause" data-task-id="external-win-567"');
    expect(html).not.toContain('data-action="start" data-task-id="external-win-567"');

    const btn = mounted.getOrCreateElement("btn-start");
    btn.dataset.taskId = "term-bg-abcdefg";
    btn.dataset.action = "start";
    btn.classList.add("terminal-control-btn");
    await mounted.listeners.get("terminal-tasks-tbody:click")!({ target: btn });
    expect(mounted.invokeCalls).toContainEqual({
      cmd: "control_terminal_task",
      args: { taskId: "term-bg-abcdefg", action: "start" },
    });
  });

  it("renders Pause and Resume for exclusively owned tasks and dispatches both actions", async () => {
    const running = mountTerminalUi({ tasks: [{
      id: "term-bg-pause12", command: "npm run dev", pid: 143,
      cwd: "D:/project/app", status: "running", canPause: true, canStop: true,
    }], runningCount: 1, totalCount: 1, presets: [] });
    await running.windowMock.__superagentTerminalRefresh();
    expect(running.getOrCreateElement("terminal-tasks-tbody").innerHTML)
      .toContain('data-action="pause"');
    const pause = running.getOrCreateElement("btn-pause");
    pause.classList.add("terminal-control-btn");
    pause.dataset.taskId = "term-bg-pause12";
    pause.dataset.action = "pause";
    await running.listeners.get("terminal-tasks-tbody:click")!({ target: pause });
    expect(running.invokeCalls).toContainEqual({
      cmd: "control_terminal_task", args: { taskId: "term-bg-pause12", action: "pause" },
    });

    const paused = mountTerminalUi({ tasks: [{
      id: "term-bg-pause12", command: "npm run dev", pid: 143,
      cwd: "D:/project/app", status: "paused", canResume: true, canStop: true,
    }], runningCount: 0, totalCount: 1, presets: [] });
    await paused.windowMock.__superagentTerminalRefresh();
    const html = paused.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect(html).toContain("Paused");
    expect(html).toContain('data-action="resume"');
    expect(html).toContain("terminal-kill-btn");
    const resume = paused.getOrCreateElement("btn-resume");
    resume.classList.add("terminal-control-btn");
    resume.dataset.taskId = "term-bg-pause12";
    resume.dataset.action = "resume";
    await paused.listeners.get("terminal-tasks-tbody:click")!({ target: resume });
    expect(paused.invokeCalls).toContainEqual({
      cmd: "control_terminal_task", args: { taskId: "term-bg-pause12", action: "resume" },
    });
  });

  it("quick launches a terminal command via the launch form", async () => {
    const mounted = mountTerminalUi();
    await mounted.windowMock.__superagentTerminalRefresh();

    const formHandler = mounted.listeners.get("terminal-quick-launch-form:submit");
    expect(formHandler).toBeDefined();

    const cmdInput = mounted.getOrCreateElement("terminal-quick-cmd");
    cmdInput.value = "npm run build";

    await formHandler!({ preventDefault: vi.fn() });

    const launchCalls = mounted.invokeCalls.filter((c) => c.cmd === "launch_terminal_task");
    expect(launchCalls.length).toBe(1);
    expect(launchCalls[0].args.command).toBe("npm run build");
  });
});
