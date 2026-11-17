import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const overviewJs = fs.readFileSync(path.resolve("apps/superagent-tray/ui/overview.js"), "utf8");
const appJs = fs.readFileSync(path.resolve("apps/superagent-tray/ui/app.js"), "utf8");
const html = fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"), "utf8");
const css = fs.readFileSync(path.resolve("apps/superagent-tray/ui/overview.css"), "utf8");

function mountOverview(mockData: {
  runtime?: any;
  daemonJobs?: any;
  daemonRuns?: any;
  delegate?: any;
  terminal?: any;
  logs?: any;
  lan?: any;
  permanentAccess?: any;
  inputPolicy?: any;
  accessAudit?: any;
  trayVersion?: string;
  trayBuild?: string;
} = {}) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: any) => any>();
  const requested: Array<{ action: string; payload: any }> = [];
  const navigatedPages: string[] = [];

  const byId = (id: string) => {
    let el = elements.get(id);
    if (!el) {
      el = {
        id,
        textContent: "",
        innerHTML: "",
        className: "",
        classList: {
          classes: new Set<string>(),
          add(c: string) { this.classes.add(c); },
          remove(c: string) { this.classes.delete(c); },
          toggle(c: string, force?: boolean) {
            if (force === undefined) {
              if (this.classes.has(c)) this.classes.delete(c);
              else this.classes.add(c);
            } else if (force) {
              this.classes.add(c);
            } else {
              this.classes.delete(c);
            }
          },
          contains(c: string) { return this.classes.has(c); },
        },
        hidden: false,
        disabled: false,
        dataset: {},
        attributes: {} as Record<string, string>,
        setAttribute(k: string, v: string) { this.attributes[k] = v; },
        getAttribute(k: string) { return this.attributes[k] ?? null; },
        addEventListener: (event: string, cb: (e: any) => any) => listeners.set(`${id}:${event}`, cb),
        click() {
          const cb = listeners.get(`${id}:click`);
          if (cb) cb({ preventDefault() {} });
        },
      };
      elements.set(id, el);
    }
    return el;
  };

  const context = vm.createContext({
    document: {
      getElementById: byId,
      querySelectorAll: (sel: string) => {
        if (sel === "[data-jump-page]") {
          return [
            {
              getAttribute: (attr: string) => (attr === "data-jump-page" ? "runtime" : null),
              addEventListener: (event: string, cb: any) => listeners.set(`jump-runtime:${event}`, cb),
            },
            {
              getAttribute: (attr: string) => (attr === "data-jump-page" ? "jobs" : null),
              addEventListener: (event: string, cb: any) => listeners.set(`jump-jobs:${event}`, cb),
            },
          ];
        }
        return [];
      },
      addEventListener: (event: string, cb: any) => listeners.set(`document:${event}`, cb),
      readyState: "complete",
    },
    confirm: vi.fn(() => true),
    setTimeout: (fn: any) => { fn(); return 1; },
    clearTimeout: () => {},
    Date,
    Math,
    String,
    Array,
    Intl,
    console,
    window: {
      __TAURI__: {
        core: {
          invoke: async (action: string, payload: any) => {
            requested.push({ action, payload });
            if (action === "detect_runtime") {
              return mockData.runtime ?? {
                selectedCorePort: 7888,
                healthyCoreCount: 1,
                cores: [{ port: 7888, pid: 1234, state: "online", selected: true, version: "1.14.83" }],
              };
            }
            if (action === "daemon_action") {
              if (payload?.action === "list") {
                return mockData.daemonJobs ?? [
                  { id: "job-1", name: "System Cleanup", enabled: true, nextRun: Date.now() + 60000 },
                  { id: "job-2", name: "Memory Sweep", enabled: false, nextRun: 0 },
                ];
              }
              if (payload?.action === "runs") {
                return mockData.daemonRuns ?? [
                  { id: "run-1", jobId: "job-1", jobName: "System Cleanup", status: "success", startedAt: Date.now() - 30000 },
                ];
              }
            }
            if (action === "get_delegate_status") {
              return mockData.delegate ?? { paired: true, activeTabsCount: 3, connectedClientsCount: 1 };
            }
            if (action === "get_terminal_tasks") {
              return mockData.terminal ?? [
                { id: "task-1", status: "running" },
                { id: "task-2", status: "completed" },
              ];
            }
            if (action === "get_connection_logs") {
              return mockData.logs ?? {
                items: [
                  {
                    id: "log-1",
                    timestamp: Date.now() - 5000,
                    source: "server",
                    sourceLabel: "Core Server",
                    event: "http_request",
                    detail: "GET /api/status 200 OK",
                    status: "success",
                  },
                ],
              };
            }
            if (action === "lan_support_action") {
              if (payload?.action === "list") {
                return mockData.lan ?? {
                  devices: [
                    { id: "lan-1", name: "Pixel 8 Pro", ip: "192.168.1.105", connected: true },
                  ],
                  pairingRequests: [],
                  tunnelDevices: [],
                };
              }
            }
            if (action === "get_permanent_access_registry") {
              return mockData.permanentAccess ?? {
                version: 2,
                defaultEffect: "deny",
                rules: [
                  { id: "rule-1", effect: "allow" },
                  { id: "rule-2", effect: "allow" },
                ],
              };
            }
            if (action === "get_desktop_input_policy") {
              return mockData.inputPolicy ?? {
                version: 1,
                mode: "trusted",
                targets: [{ pid: 1234, nativeId: "win-1" }],
              };
            }
            if (action === "get_permanent_access_audit_log") {
              return mockData.accessAudit ?? [
                {
                  id: "audit-1",
                  timestamp: Date.now() - 10000,
                  application: "Cursor",
                  operation: "input",
                  effect: "allow",
                  target: "Code.exe",
                },
              ];
            }
            if (action === "get_tray_version") return mockData.trayVersion ?? "1.14.83";
            if (action === "get_tray_build_number") return mockData.trayBuild ?? "9842";
            return { ok: true };
          },
        },
      },
      navigateToPage: (page: string) => {
        navigatedPages.push(page);
      },
      addEventListener: (event: string, cb: any) => listeners.set(`window:${event}`, cb),
      confirm: vi.fn(() => true),
      Date,
      Math,
      String,
      Array,
      Intl,
      setTimeout,
      clearTimeout,
      console,
    },
  });

  vm.runInContext(overviewJs, context);
  return { byId, requested, listeners, navigatedPages, context };
}

describe("SuperAgent Tray System Overview Dashboard", () => {
  it("exposes System Overview as the primary sidebar navigation link in index.html", () => {
    expect(html).toContain('id="nav-overview"');
    expect(html).toContain('href="#overview"');
    expect(html).toContain('data-page="overview"');
    expect(html).toContain('<span>System Overview</span>');
    expect(html).toContain('id="page-overview"');
    expect(html).toContain('id="actions-overview"');
    expect(html).toContain('id="overview-refresh-btn"');
  });

  it("links overview.css and overview.js in index.html", () => {
    expect(html).toContain('<link rel="stylesheet" href="./overview.css" />');
    expect(html).toContain('<script src="./overview.js" defer></script>');
  });

  it("includes overview in the settings startup-page options", () => {
    expect(html).toContain('<option value="overview">System Overview</option>');
    expect(appJs).toMatch(/validPages\s*=\s*\[[^\]]*"overview"[^\]]*\]/);
  });

  it("defines comprehensive responsive Bento grid and telemetry styles in overview.css", () => {
    expect(css).toContain(".overview-container");
    expect(css).toContain(".overview-hero-ribbon");
    expect(css).toContain(".overview-kpis");
    expect(css).toContain(".overview-services-grid");
    expect(css).toContain(".overview-split-grid");
    expect(css).toContain(".overview-activity-card");
    expect(css).toContain(".overview-actions-card");
    expect(css).toContain(".overview-activity-tag.security");
    expect(css).toContain("@media (max-width: 860px)");
    expect(css).toContain("@media (max-width: 520px)");
  });

  it("fetches runtime, daemon, delegate, terminal, and log telemetry on mount", async () => {
    const harness = mountOverview();
    // Flush microtasks
    await new Promise((r) => setTimeout(r, 20));

    expect(harness.requested.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "detect_runtime",
        "daemon_action",
        "get_delegate_status",
        "get_terminal_tasks",
        "get_connection_logs",
        "get_tray_version",
        "get_tray_build_number",
        "lan_support_action",
        "get_permanent_access_registry",
        "get_desktop_input_policy",
        "get_permanent_access_audit_log",
      ])
    );
  });

  it("renders live Core telemetry, status beacon, port pill and KPI cards", async () => {
    const harness = mountOverview({
      runtime: {
        selectedCorePort: 7888,
        healthyCoreCount: 1,
        cores: [{ port: 7888, pid: 4567, state: "online", selected: true, version: "1.14.83" }],
      },
      daemonJobs: [
        { id: "j1", name: "Job One", enabled: true, nextRun: Date.now() + 120000 },
        { id: "j2", name: "Job Two", enabled: true, nextRun: Date.now() + 300000 },
      ],
      delegate: { paired: true, activeTabsCount: 4, connectedClientsCount: 2 },
      terminal: [{ id: "t1", status: "running" }],
    });

    await new Promise((r) => setTimeout(r, 20));

    // Verify Core Status
    expect(harness.byId("overview-core-status-text").textContent).toBe("Core Online & Operating");
    expect(harness.byId("overview-port-pill").textContent).toBe(":7888 LOOPBACK");
    expect(harness.byId("overview-pid-pill").textContent).toBe("PID 4567");
    expect(harness.byId("overview-version-pill").textContent).toBe("v1.14.83");

    // Verify KPIs
    expect(harness.byId("kpi-core-state").textContent).toBe("Online");
    expect(harness.byId("kpi-jobs-count").textContent).toBe("2 / 2");
    expect(harness.byId("kpi-delegate-tabs").textContent).toBe("4 Tabs");
    expect(harness.byId("kpi-terminal-tasks").textContent).toBe("1 Running");

    // Verify Services Matrix
    expect(harness.byId("srv-core-pill").textContent).toBe("Active");
    expect(harness.byId("srv-sched-pill").textContent).toBe("Running");
    expect(harness.byId("srv-delegate-pill").textContent).toBe("Paired");
    expect(harness.byId("srv-terminal-pill").textContent).toBe("Active");
  });

  it("handles offline Core gracefully without crashing or leaking internals", async () => {
    const harness = mountOverview({
      runtime: {
        selectedCorePort: 7888,
        healthyCoreCount: 0,
        cores: [],
      },
      daemonJobs: [],
      delegate: null,
      terminal: [],
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(harness.byId("overview-core-status-text").textContent).toBe("Core Offline / Standalone");
    expect(harness.byId("overview-beacon-dot").classList.contains("offline")).toBe(true);
    expect(harness.byId("kpi-core-state").textContent).toBe("Offline");
    expect(harness.byId("srv-core-pill").textContent).toBe("Offline");
  });

  it("wires quick jump navigation links to target application tabs", async () => {
    const harness = mountOverview();
    await new Promise((r) => setTimeout(r, 20));

    // Simulate clicking jump to runtime
    const jumpRuntimeCb = harness.listeners.get("jump-runtime:click");
    expect(jumpRuntimeCb).toBeDefined();
    jumpRuntimeCb({ preventDefault() {} });
    expect(harness.navigatedPages).toContain("runtime");

    // Simulate clicking jump to jobs
    const jumpJobsCb = harness.listeners.get("jump-jobs:click");
    expect(jumpJobsCb).toBeDefined();
    jumpJobsCb({ preventDefault() {} });
    expect(harness.navigatedPages).toContain("jobs");
  });

  it("does not use unbound legacy restart and directs operator to owner-bound planning", async () => {
    const harness = mountOverview();
    await new Promise((r) => setTimeout(r, 20));
    const restartBtn = harness.byId("overview-action-restart-core");
    restartBtn.click();
    expect(harness.context.window.confirm).toHaveBeenCalled();
    expect(harness.requested.some(x => x.action === "restart_core_server")).toBe(false);
  });

  it("navigates to jobs when New Schedule action is triggered", async () => {
    const harness = mountOverview();
    await new Promise((r) => setTimeout(r, 20));

    const newSchedBtn = harness.byId("overview-action-new-schedule");
    newSchedBtn.click();
    expect(harness.navigatedPages).toContain("jobs");
  });

  it("navigates to runtime when Scan Runtime action is triggered", async () => {
    const harness = mountOverview();
    await new Promise((r) => setTimeout(r, 20));

    const scanRuntimeBtn = harness.byId("overview-action-scan-runtime");
    scanRuntimeBtn.click();
    expect(harness.navigatedPages).toContain("runtime");
  });

  it("renders live LAN Devices KPI and active session counter from native telemetry", async () => {
    const harness = mountOverview({
      lan: {
        devices: [
          { id: "lan-1", name: "Pixel 8 Pro", ip: "192.168.1.105", connected: true },
          { id: "lan-2", name: "ThinkPad X1", ip: "192.168.1.120", connected: false },
        ],
        pairingRequests: [],
        tunnelDevices: [],
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(harness.byId("kpi-lan-devices").textContent).toBe("2 Paired");
    expect(harness.byId("kpi-lan-meta").textContent).toBe("1 active session");
    expect(harness.byId("kpi-lan-badge").textContent).toBe("Active");
  });

  it("renders live Security Guard KPI and Permanent Access ACL rules from native registry", async () => {
    const harness = mountOverview({
      permanentAccess: {
        version: 2,
        defaultEffect: "deny",
        rules: [
          { id: "rule-1", effect: "allow" },
          { id: "rule-2", effect: "allow" },
          { id: "rule-3", effect: "deny" },
        ],
      },
      inputPolicy: {
        version: 1,
        mode: "trusted",
        targets: [{ pid: 1234, nativeId: "win-1" }, { pid: 5678, nativeId: "win-2" }],
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(harness.byId("kpi-security-status").textContent).toBe("3 Rules");
    expect(harness.byId("kpi-security-meta").textContent).toBe("2 active targets · Permanent ACL");
    expect(harness.byId("kpi-security-badge").textContent).toBe("Enforced");
  });

  it("merges security access audit log entries into recent activity feed", async () => {
    const harness = mountOverview({
      accessAudit: [
        {
          id: "audit-1",
          timestamp: Date.now() - 2000,
          application: "Code",
          operation: "input",
          effect: "allow",
          target: "Code.exe",
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 20));

    const listHtml = harness.byId("overview-activity-list").innerHTML;
    expect(listHtml).toContain("Code: input (allow)");
    expect(listHtml).toContain("SECURITY");
  });
});
