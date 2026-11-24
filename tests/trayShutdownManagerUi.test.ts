import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"), "utf8");
const script = fs.readFileSync(path.resolve("apps/superagent-tray/ui/shutdown-manager.js"), "utf8");
const shutdownCss = fs.readFileSync(path.resolve("apps/superagent-tray/ui/shutdown-manager.css"), "utf8");
const native = fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/shutdown_manager.rs"), "utf8");
const ownerControl = fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/runtime_control.rs"), "utf8");

function fixture() {
  return {
    previewId: "trusted-preview",
    createdAt: 12345,
    exitReady: false,
    warning: null,
    services: [
      {
        id: "managed:guardian",
        label: "Guardian",
        kind: "managed",
        state: "active",
        port: 7888,
        pid: 212,
        ownerVerified: true,
        selectable: true,
        forceSelectable: true,
        manualKillSelectable: true,
        processName: "bun.exe",
        blocker: null,
        detail: "Verified owner",
      },
      {
        id: "mcp:8857:999",
        label: "MCP owner",
        kind: "mcp",
        state: "observed",
        port: 8857,
        pid: 999,
        ownerVerified: false,
        selectable: false,
        forceSelectable: true,
        manualKillSelectable: false,
        blocker: "Active sessions",
        detail: "Busy owner",
      },
      {
        id: "external:locked",
        label: "Locked host",
        kind: "external",
        state: "observed",
        port: 9000,
        pid: null,
        ownerVerified: false,
        selectable: false,
        forceSelectable: false,
        manualKillSelectable: false,
        blocker: "Unverified",
        detail: "Foreign process",
      },
      {
        id: "managed:vision",
        label: "Vision",
        kind: "managed",
        state: "inactive",
        port: 8095,
        pid: null,
        ownerVerified: false,
        selectable: false,
        forceSelectable: false,
        manualKillSelectable: false,
        blocker: null,
        detail: "Stopped",
      },
    ],
  };
}

function mount(preview = fixture()) {
  const nodes = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const calls: any[] = [];
  const element = (tag: string) => {
    const e: any = {
      tag,
      className: "",
      textContent: "",
      disabled: false,
      hidden: false,
      checked: false,
      type: "",
      value: "",
      dataset: {},
      children: [],
      attributes: {},
      handlers: {},
      focus: vi.fn(),
      append(...children: any[]) {
        e.children.push(...children);
      },
      replaceChildren(...children: any[]) {
        e.children = children;
      },
      addEventListener(name: string, handler: Function) {
        e.handlers[name] = handler;
      },
      setAttribute(name: string, value: string) {
        e.attributes[name] = value;
      },
    };
    return e;
  };
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const e = element("div");
      e.id = id;
      nodes.set(id, e);
    }
    return nodes.get(id);
  };
  const invoke = vi.fn(async (command: string, args: any) => {
    expect(command).toBe("shutdown_manager_action");
    calls.push(args);
    if (args.action === "preview") return { preview };
    if (args.action === "status") return { busy: false, progress: null };
    if (args.action === "close_selected") return { accepted: true, runId: "run-confirmed" };
    throw Error("Unexpected request: " + args.action);
  });
  const window: any = {
    __TAURI__: {
      core: { invoke },
      event: {
        listen: vi.fn((name: string, fn: Function) => {
          listeners.set(name, fn);
          return Promise.resolve(() => {});
        }),
      },
    },
  };
  const context = vm.createContext({
    document: { getElementById: node, createElement: element },
    window,
    Set,
    Array,
    String,
    Number,
    Math,
    Promise,
    Error,
    console,
    setInterval: vi.fn(() => 17),
    clearInterval: vi.fn(),
  });
  vm.runInContext(script, context);
  return {
    node,
    window,
    invoke,
    calls,
    listeners,
    async open() {
      await window.__superagentShutdownManagerOpen();
    },
    click(id: string) {
      const handler = node(id).handlers.click;
      expect(handler).toBeTypeOf("function");
      return handler({ target: node(id) });
    },
  };
}

describe("native Shutdown Manager UI (minimal daemon checklist)", () => {
  it("mounts a minimal daemon checklist dialog without typed confirmation inputs", () => {
    for (const id of [
      "shutdown-manager-dialog",
      "shutdown-services",
      "shutdown-select-all",
      "shutdown-refresh",
      "shutdown-close-selected",
      "shutdown-cancel",
      "shutdown-close",
      "shutdown-progress",
      "shutdown-feedback",
    ]) {
      expect(html).toContain('id="' + id + '"');
    }
    expect(html).not.toContain("shutdown-force-confirm");
    expect(html).not.toContain("shutdown-manual-confirm");
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('src="./shutdown-manager.js"');
    expect(html).toContain('href="./shutdown-manager.css"');
    expect(script).not.toMatch(/innerHTML|eval\s*\(|taskkill|process\.kill/);
    expect(shutdownCss).toContain("z-index: 1900");
    expect(shutdownCss).toContain("backdrop-filter: none");
    expect(native.match(/\.parent\(&dialog_parent\)/g)).toHaveLength(4);
    expect(native).toContain('"close_selected" =>');
    expect(native).toContain("close_selected_candidates");
    expect(native).toContain("run_close_selected");
    expect(ownerControl).toContain('"/_internal/owner/stop?force=1"');
  });

  it("shows only active daemons, auto-checks eligible rows, and locks ineligible ones", async () => {
    const m = mount();
    await m.open();
    expect(m.calls.map(c => c.action)).toEqual(["status", "preview"]);
    const rows = m.node("shutdown-services").children;
    expect(rows).toHaveLength(3); // inactive Vision omitted
    expect(rows[0].children[0].checked).toBe(true);
    expect(rows[0].children[0].disabled).toBe(false);
    expect(rows[1].children[0].checked).toBe(true);
    expect(rows[1].children[0].disabled).toBe(false);
    expect(rows[2].children[0].checked).toBe(false);
    expect(rows[2].children[0].disabled).toBe(true);
    expect(m.node("shutdown-close-selected").disabled).toBe(false);
    expect(m.node("shutdown-selection-count").textContent).toBe("2 / 2 daemon selected");
  });

  it("closes all checked daemons in one click via close_selected without typed phrases", async () => {
    const m = mount();
    await m.open();
    await m.click("shutdown-close-selected");
    const action = m.calls.find(c => c.action === "close_selected");
    expect(action).toEqual({
      action: "close_selected",
      previewId: "trusted-preview",
      selected: ["managed:guardian", "mcp:8857:999"],
    });
    expect(m.node("shutdown-progress").hidden).toBe(false);
  });

  it("toggles all eligible daemons with Select all / Clear all", async () => {
    const m = mount();
    await m.open();
    expect(m.node("shutdown-select-all").textContent).toBe("Clear all");
    await m.click("shutdown-select-all");
    expect(m.node("shutdown-close-selected").disabled).toBe(true);
    expect(m.node("shutdown-select-all").textContent).toBe("Select all");
    expect(m.node("shutdown-selection-count").textContent).toBe("0 / 2 daemon selected");
    await m.click("shutdown-select-all");
    expect(m.node("shutdown-close-selected").disabled).toBe(false);
    expect(m.node("shutdown-selection-count").textContent).toBe("2 / 2 daemon selected");
  });

  it("shows empty state when no active daemons exist", async () => {
    const empty = fixture();
    empty.services = [empty.services[3]];
    const m = mount(empty);
    await m.open();
    expect(m.node("shutdown-services").children).toHaveLength(1);
    expect(m.node("shutdown-services").children[0].textContent).toContain("Tidak ada daemon aktif");
    expect(m.node("shutdown-close-selected").disabled).toBe(true);
    expect(m.node("shutdown-select-all").disabled).toBe(true);
  });

  it("hides system placeholders and dead unreachable rows while keeping live unreachable PIDs checkable", async () => {
    const data = fixture();
    data.services = [
      {
        id: "inventory-unavailable",
        label: "Lifecycle inventory",
        kind: "system",
        state: "unknown",
        selectable: false,
        forceSelectable: false,
        manualKillSelectable: false,
      },
      {
        id: "core:7888:29876",
        label: "Selected Core API",
        kind: "core",
        state: "unreachable",
        port: 7888,
        pid: 29876,
        selectable: false,
        forceSelectable: false,
        manualKillSelectable: false,
      },
      {
        id: "independent:channel-host:58398",
        label: "Unregistered independent host",
        kind: "external",
        state: "unreachable",
        port: 58398,
        pid: 39984,
        selectable: false,
        forceSelectable: false,
        manualKillSelectable: true,
        processName: "bun.exe",
      },
    ];
    const m = mount(data);
    await m.open();
    const rows = m.node("shutdown-services").children;
    expect(rows).toHaveLength(1);
    expect(rows[0].children[0].checked).toBe(true);
    expect(rows[0].children[0].disabled).toBe(false);
    expect(m.node("shutdown-selection-count").textContent).toBe("1 / 1 daemon selected");
  });

  it("renders progress safely via textContent and refreshes once on terminal stage", async () => {
    const m = mount();
    await m.open();
    const cb = m.listeners.get("shutdown-manager-progress");
    expect(cb).toBeTypeOf("function");
    cb!({
      payload: {
        runId: "run-1",
        stage: "partial",
        error: "SHUTDOWN_OWNER_CHANGED",
        steps: [{ id: "managed:guardian", label: "<script>bad()</script>", status: "blocked", message: "Identity changed" }],
      },
    });
    const item = m.node("shutdown-progress-steps").children[0];
    expect(item.children[0].textContent).toBe("<script>bad()</script>");
    expect(m.node("shutdown-progress-status").textContent).toContain("Partial");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(m.calls.filter(c => c.action === "preview")).toHaveLength(2);
  });
});
