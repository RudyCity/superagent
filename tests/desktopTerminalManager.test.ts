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
});

function mountTerminalUi(mockResponse?: any) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: any) => any>();
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
    addEventListener: vi.fn(),
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
              tasks = tasks.filter((t: any) => t.status === "running");
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

  vm.runInContext(terminalJs, context);

  return {
    windowMock,
    elements,
    listeners,
    invokeCalls,
    clipboard,
    getOrCreateElement,
  };
}

describe("Desktop Terminal UI Controller", () => {
  it("shows unverified MCP PIDs without offering an unsafe Stop button", async () => {
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
    await mounted.windowMock.__superagentTerminalRefresh();
    const html = mounted.getOrCreateElement("terminal-tasks-tbody").innerHTML;
    expect(html).toContain("Unverified PID");
    expect(html).toContain("MCP");
    expect(html).not.toContain("terminal-kill-btn");
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
