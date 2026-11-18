import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const base = "apps/superagent-tray";
const html = fs.readFileSync(path.join(base, "ui/index.html"), "utf8");
const js = fs.readFileSync(path.join(base, "ui/notifications.js"), "utf8");
const rust = fs.readFileSync(path.join(base, "src-tauri/src/main.rs"), "utf8");
const store = fs.readFileSync(path.join(base, "src-tauri/src/tray_notification_center.rs"), "utf8");

function routeForFixture(id: string, items: Record<string, unknown>[]) {
  const item = items.find((row) => row.id === id);
  const src = item?.source;
  const named = { "health:muse":"runtime:muse", "health:telegram":"settings:muse",
    "health:channel-hosts":"runtime:hosts", "health:delegate-listener":"delegate:diagnostics" };
  if (Object.hasOwn(named,id)) return named[id as keyof typeof named];
  if (src === "reminder" && id.startsWith("reminder:")) return "history";
  if (src === "jobs" && id.startsWith("daemon-run:") &&
      (id.endsWith(":Scheduled run needs attention") ||
       id.endsWith(":Scheduled notification delivery failed"))) return "history";
  const routes: Record<string,string> = {
    core:"runtime:core",security:"security",mcp:"runtime:mcp",
    tunnel:"runtime:cloudflare",delegate:"delegate:connection",
    runtime:"runtime:core","desktop-live":"desktop-live",terminal:"terminal",
    "lan-devices":"lan-devices:devices",reminder:"jobs",jobs:"jobs",
    updates:"updates",shutdown:"overview",settings:"settings:general",
    "muse-files":"muse-files",overview:"overview",logs:"logs",
  };
  return routes[String(src)] || null;
}

function mount(items: Record<string, unknown>[] = []) {
  const elements = new Map<string, any>();
  const domEvents = new Map<string, (...args: any[]) => any>();
  const mockInvocations: { action: string; id?: string | null }[] = [];
  const nav = vi.fn();
  const filters = ["all", "unread", "important", "open", "acknowledged", "resolved", "archived"].map((filter) => {
    const n = makeNode();
    n.dataset = { notificationFilter: filter };
    return n;
  });
  function makeNode() {
    const attrs: Record<string, string> = {};
    const listeners: Record<string, (...args: any[]) => any> = {};
    const children: any[] = [];
    return {
      textContent: "", className: "", hidden: false, disabled: false,
      dataset: {} as Record<string, string>, children, classList: { toggle: vi.fn() },
      setAttribute(key: string, value: string) { attrs[key] = value; },
      getAttribute(key: string) { return attrs[key]; },
      addEventListener(type: string, fn: (...args: any[]) => any) { listeners[type] = fn; },
      trigger(type: string, event: unknown = {}) { return listeners[type]?.(event); },
      append(...nodes: any[]) { children.push(...nodes); },
      replaceChildren(...nodes: any[]) { children.splice(0, children.length, ...nodes); },
      contains() { return false; }, closest() { return null; }, focus() {},
    };
  }
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, makeNode());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      readyState: "complete",
      getElementById: get,
      createElement: makeNode,
      querySelectorAll(selector: string) {
        return selector === "[data-notification-filter]" ? filters : [];
      },
      addEventListener(type: string, fn: (...args: any[]) => any) {
        domEvents.set(type, fn);
      },
    },
    window: {
      __TAURI__: {
        core: { invoke: vi.fn(async (name: string, args: any) => {
          expect(name).toMatch(/^tray_notification_center_(action|ui_alert|refresh_security|begin_navigation|ack_navigation)$/);
          if (name.endsWith("ui_alert")) return {};
          if (name.endsWith("begin_navigation")) {
            mockInvocations.push({action:"navigation-begin",id:args.incidentId});
            return {status:"ISSUED",nonce:"mock-nonce",route:
              args.incidentId.startsWith("mcp-pending:connections:")?"security:connections":
              args.incidentId.startsWith("mcp-pending:mcp:")?"security:mcp":
              args.incidentId.startsWith("mcp-pending:")?"security":
              routeForFixture(args.incidentId,items)};
          }
          if (name.endsWith("ack_navigation")) {
            mockInvocations.push({action:"navigation-ack",id:args.incidentId});
            if (!args.targetFound) return {status:"NOT_DELIVERED",route:args.route};
            items = items.map((item) => item.id === args.incidentId
              ? { ...item, readAt:1700000000100 } : item);
            mockInvocations.push({action:"read",id:args.incidentId});
            return {status:"DELIVERED",route:args.route};
          }
          if (name.endsWith("refresh_security")) {
            mockInvocations.push({action: "sync-security"});
            return {items, unreadCount: items.filter((item) => !item.readAt).length, securitySync: "ok"};
          }
          mockInvocations.push(args);
          if (args.action === "read" && args.id) {
            items = items.map((item) => item.id === args.id ? { ...item, readAt: 1700000000100 } : item);
          }
          if (args.action === "read-all") {
            items = items.map((item) => ({ ...item, readAt: 1700000000100 }));
          }
          if (args.id && ["archive", "restore", "acknowledge", "resolve", "reopen"].includes(args.action)) {
            items = items.map((item) => item.id === args.id ? {
              ...item,
              readAt: item.readAt ?? 1700000000100,
              archivedAt: args.action === "archive" ? 1700000000100
                : args.action === "restore" ? null : item.archivedAt,
              resolvedAt: args.action === "resolve" ? 1700000000100
                : args.action === "reopen" ? null : item.resolvedAt,
              acknowledgedAt: args.action === "acknowledge" ? 1700000000100 : item.acknowledgedAt,
            } : item);
          }
          if (args.action === "unread" && args.id) {
            items = items.map((item) => item.id === args.id ? { ...item, readAt: null } : item);
          }
          return { items, unreadCount: items.filter((item) => !item.readAt && !item.archivedAt).length };
        }) },
        event: { listen: vi.fn(async () => () => {}) },
      },
      setInterval: vi.fn(),
      addEventListener: vi.fn(),
      navigateToPage: nav,
    },
    Object, Date, Number, String, Promise,
  });
  vm.runInContext(js, context);
  return { get, filters, mockInvocations, nav, window: context.window };
}

describe("Tray Notification Manager", () => {
  it("identifies OAuth-named MCP requests without treating a name as approval", () => {
    expect(rust).toContain('request.get("ownerConnectionName")');
    expect(rust).toContain('requested MCP permission. Review Security Approval.');
    expect(rust).toContain('"mcp-pending:{tab}:{id}"');
    expect(rust).toContain('== Some("mcp-connection")');
    expect(js).toContain('__superagentAccessManagerFocusRequest');
    expect(js).not.toContain('mcp_project_access_action("approve"');
  });

  it("wires one header bell adjacent to Reload and a distinct sidebar/page route", () => {
    expect(html.indexOf('id="tray-notification-bell"')).toBeGreaterThan(0);
    expect(html.indexOf('id="tray-notification-bell"')).toBeLessThan(html.indexOf('id="tray-window-reload"'));
    expect(html).toContain('data-page="notifications"');
    expect(html).toContain('id="page-notifications"');
    expect(html).toContain('src="./notifications.js"');
    expect(html).toContain('href="./notifications.css"');
    const app = fs.readFileSync(path.join(base, "ui/app.js"), "utf8");
    expect(app).toContain('"notifications"');
    expect(app).toContain('window.__superagentNotificationsRefresh?.()');
  });
  it("loads persisted native events, sets unread count and filters correctly", async () => {
    const mounted = mount([{
      id: "core-1", severity: "critical", source: "core", title: "Core failed",
      body: "<script>alert(1)</script>", createdAt: 1700000000000,
      readAt: null, archivedAt: null,
    }, {
      id: "reminder-1", severity: "info", source: "reminder", title: "Break",
      body: "Stretch", createdAt: 1700000000000, readAt: 1700000000100, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mounted.get("tray-notification-count").textContent).toBe("1");
    expect(mounted.get("notification-inbox-list").children).toHaveLength(2);
    mounted.filters[1].trigger("click");
    expect(mounted.get("notification-inbox-list").children).toHaveLength(1);
    expect(mounted.get("notification-inbox-list").children[0].children[1].children[0]
      .children[0].textContent).toBe("Core failed");
    expect(mounted.get("tray-notification-count").hidden).toBe(false);
  });
  it("uses native acknowledgment instead of browser localStorage", async () => {
    const mounted = mount([{
      id: "alert-1", severity: "warning", source: "security", title: "Approval required",
      body: "Review security", createdAt: 1700000000000, readAt: null, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.get("notification-read-all").trigger("click");
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mounted.mockInvocations.some((call) => call.action === "read-all")).toBe(true);
    expect(mounted.get("tray-notification-count").hidden).toBe(true);
    expect(js).not.toMatch(/localStorage|sessionStorage/);
  });
  it("filters incident lifecycle, source, search and time without trusting HTML", async () => {
    const mounted = mount([
      { id: "a", severity: "critical", source: "mcp", title: "MCP disconnected",
        body: "Check owner", createdAt: Date.now(), readAt: null, archivedAt: null,
        acknowledgedAt: null, resolvedAt: null },
      { id: "b", severity: "warning", source: "delegate", title: "Delegate pending",
        body: "Check runtime", createdAt: Date.now(), readAt: Date.now(), archivedAt: null,
        acknowledgedAt: Date.now(), resolvedAt: null },
      { id: "c", severity: "info", source: "jobs", title: "Old job fixed",
        body: "Completed", createdAt: Date.now(), readAt: Date.now(), archivedAt: null,
        acknowledgedAt: null, resolvedAt: Date.now() },
    ]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.filters[3].trigger("click");
    expect(mounted.get("notification-inbox-list").children).toHaveLength(1);
    mounted.filters[4].trigger("click");
    expect(mounted.get("notification-inbox-list").children).toHaveLength(1);
    mounted.filters[5].trigger("click");
    expect(mounted.get("notification-inbox-list").children).toHaveLength(1);
    mounted.filters[0].trigger("click");
    mounted.get("notification-search").trigger("input", { target: { value: "MCP disconnected" } });
    expect(mounted.get("notification-inbox-list").children).toHaveLength(1);
    mounted.get("notification-search").trigger("input", { target: { value: "" } });
    mounted.get("notification-source").trigger("change", { target: { value: "delegate" } });
    expect(mounted.get("notification-inbox-list").children).toHaveLength(1);
    mounted.get("notification-source").trigger("change", { target: { value: "all" } });
    expect(mounted.get("notification-inbox-list").children).toHaveLength(3);
    expect(js).toContain('textContent = String(text)');
  });
  it("wires notification preferences and complete fixed-severity incident actions", () => {
    expect(html).toContain('id="notification-search"');
    expect(html).toContain('id="notification-period"');
    expect(html).toContain('id="notification-source"');
    expect(html).toContain('id="notification-save-preferences"');
    expect(html).toContain('data-notification-category="mcp"');
    expect(html).toContain('data-notification-filter="resolved"');
    expect(js).toContain('"acknowledge"');
    expect(js).toContain('"resolve"');
    expect(js).toContain('"reopen"');
    expect(store).toContain("pub fn resolve_missing(");
    expect(store).toContain("pub fn save_preferences(");
    expect(store).toContain("pub fn should_notify_os(");
    expect(rust).toContain("tray_notification_center_preferences,");
    expect(rust).toContain("poll_operational_health(");
    expect(rust).toContain("poll_pending_security_requests(");
    expect(rust).toContain("os_alert_budget_available()");
    const start = rust.indexOf("    let mut delivered = 0;");
    const end = rust.indexOf("    Ok(delivered)", start);
    const reminder = rust.slice(start, end);
    expect(reminder.indexOf('app, "reminder", "info"')).toBeLessThan(reminder.indexOf('.show()'));
    expect(reminder.indexOf('app, "reminder", "info"')).toBeLessThan(reminder.indexOf("write_seen(&file"));
  });
  it("opening the bell requests fresh authenticated security inventory without granting access", async () => {
    const mounted = mount([{
      id: "mcp-pending:req_test", source: "security", severity: "critical",
      title: "Security approval pending", body: "Review Security Approval",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.get("tray-notification-bell").trigger("click");
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mounted.mockInvocations.some(call => call.action === "sync-security")).toBe(true);
    expect(js).toContain("tray_notification_center_refresh_security");
    expect(rust).toContain("async fn tray_notification_center_refresh_security(");
    expect(rust).toContain("poll_pending_security_requests(&app).await");
    expect(rust).toContain("tokio::join!(");
    expect(rust).toContain("tray_notification_center_refresh_security,");
    expect(rust).not.toContain("approveProjectAccessRequest(&app)");
  });

  it("opens pending access from its card or action and preserves request focus across startup", async () => {
    const mounted = mount([{
      id: "mcp-pending:request-42", source: "security", severity: "critical",
      title: "Security approval pending", body: "A project needs access",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const card = mounted.get("tray-notification-recent").children[0];
    const open = card.children[1].children[3].children[0];
    expect(open.textContent).toBe("Review pending access");
    card.trigger("click", { target: { closest: () => null } });
    expect(mounted.nav).toHaveBeenCalledWith("security");
    expect(mounted.window.__superagentPendingAccessNotificationId).toBe("request-42");
    mounted.nav.mockClear();
    // Inner lifecycle actions must not accidentally open the page.
    card.trigger("click", { target: { closest: () => open } });
    expect(mounted.nav).not.toHaveBeenCalled();
    const focus = vi.fn(async () => undefined);
    mounted.window.__superagentAccessManagerFocusRequest = focus;
    open.trigger("click");
    expect(mounted.nav).toHaveBeenCalledWith("security");
    expect(focus).toHaveBeenCalledWith("request-42", null);
    expect(mounted.mockInvocations.some(call => call.action === "approve")).toBe(false);
    const access = fs.readFileSync(path.join(base, "ui/access-manager.js"), "utf8");
    const install = access.slice(access.indexOf("async function install()"));
    expect(install.indexOf("window.__superagentAccessManagerFocusRequest = async"))
      .toBeLessThan(install.indexOf("await refreshWindows();"));
    expect(install).toContain("window.__superagentPendingAccessNotificationId");
  });
  it.each([
    ["connections", "Review MCP Connections"],
    ["mcp", "Review MCP Project Access"],
  ])("routes pending %s notifications into the exact Security Approval tab", async (tab, label) => {
    const mounted = mount([{
      id: "mcp-pending:" + tab + ":req_x7", source: "security", severity: "critical",
      title: "Security approval pending", body: "Review MCP permission",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const card = mounted.get("tray-notification-recent").children[0];
    const open = card.children[1].children[3].children[0];
    expect(open.textContent).toBe(label);
    card.trigger("click", { target: { closest: () => null } });
    expect(mounted.nav).toHaveBeenCalledWith("security:" + tab);
    expect(mounted.window.__superagentPendingAccessNotificationId).toBe("req_x7");
    expect(mounted.window.__superagentPendingAccessNotificationTab).toBe(tab);
    const focus = vi.fn(async () => undefined);
    mounted.window.__superagentAccessManagerFocusRequest = focus;
    open.trigger("click");
    expect(focus).toHaveBeenCalledWith("req_x7", tab);
    expect(mounted.mockInvocations.some(call => call.action === "approve")).toBe(false);
  });
  it("keeps missing or expired pending approvals unread until the exact request is focused", async () => {
    const mounted = mount([{
      id: "mcp-pending:connections:missing-approval", source: "security",
      severity: "warning", title: "Access pending", body: "Open request",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const card = mounted.get("tray-notification-recent").children[0];
    const focus = vi.fn(async () => ({targetFound:false,tab:"connections"}));
    mounted.window.__superagentAccessManagerFocusRequest = focus;
    card.trigger("click", { target: { closest: () => null } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(focus).toHaveBeenCalledWith("missing-approval", "connections");
    expect(mounted.mockInvocations.some((call) => call.action === "read")).toBe(false);
    focus.mockResolvedValue({targetFound:true,tab:"connections"});
    card.trigger("click", { target: { closest: () => null } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mounted.mockInvocations.some((call) => call.action === "read")).toBe(true);
  });
  it("does not mark a notification read if the destination cannot be delivered", async () => {
    const mounted = mount([{
      id: "health:core", source: "core", severity: "warning",
      title: "Core", body: "Open runtime",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.window.navigateToPage = () => { throw new Error("navigation unavailable"); };
    mounted.get("tray-notification-recent").children[0].trigger("click", {
      target: { closest: () => null },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mounted.mockInvocations.some((call) => call.action === "read")).toBe(false);
  });

  it("only marks navigation read after the native one-use receipt", async () => {
    const mounted = mount([{id:"health:core", source:"core", severity:"warning",
      title:"Core offline",body:"Inspect runtime", createdAt:Date.now(),
      readAt:null,archivedAt:null}]);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    const card=mounted.get("tray-notification-recent").children[0];
    card.trigger("click",{target:{closest:()=>null}});
    await new Promise<void>((resolve)=>setImmediate(resolve));
    expect(mounted.mockInvocations.map(v=>v.action)).toContain("navigation-begin");
    expect(mounted.mockInvocations.map(v=>v.action)).toContain("navigation-ack");
    expect(mounted.mockInvocations.map(v=>v.action)).toContain("read");
    expect(rust).toContain("tray_notification_center_ack_navigation,");
    expect(rust).toContain("tray_navigation_receipt::consume(");
  });
  it("does not use a JS scheduleRead shortcut after navigation", () => {
    const opened=js.slice(js.indexOf("function openDestination("),
      js.indexOf("function noteCard("));
    expect(opened).not.toContain("scheduleRead(item)");
    expect(opened).toContain('receipt?.status === "DELIVERED"');
  });

  it("uses allowlisted deep links for every supported tabbed Tray page", () => {
    const app = fs.readFileSync(path.join(base, "ui/app.js"), "utf8");
    const runtime = fs.readFileSync(path.join(base, "ui/runtime.js"), "utf8");
    const access = fs.readFileSync(path.join(base, "ui/access-manager.js"), "utf8");
    expect(app).toContain('const route = subTab ? target + ":" + subTab : target;');
    expect(app).toContain('security: ["connections", "mcp", "register", "rules", "audit"]');
    expect(app).toContain('runtime: ["core", "mcp", "cloudflare", "muse", "chrome", "processes", "hosts"]');
    expect(app).toContain('"lan-devices": ["devices", "terminal", "files", "screen"]');
    expect(app).toContain('window.__superagentRuntimeOpenTab?.(subTab)');
    expect(app).toContain('window.delegateSwitchTab?.(subTab)');
    expect(app).toContain('window.lanSwitchTab?.(subTab)');
    expect(app).toContain('window.settingsSwitchTab(subTab || currentTab)');
    expect(runtime).toContain('window.__superagentRuntimeOpenTab = (tab)');
    expect(access).toContain('const pendingNotificationTab = window.__superagentPendingAccessNotificationTab;');
    expect(access).toContain('setActiveTab(tab || "mcp");');
    expect(access).toContain('const tab = target.projectId === "mcp-connection" ? "connections" : "mcp";');
    expect(access).not.toContain('/[\\\\x00-\\\\x1f]/.test(requestId)');
  });

  it("deep-links to an exact MCP approval without invoking approve/deny", () => {
    const access = fs.readFileSync(path.join(base, "ui/access-manager.js"), "utf8");
    expect(js).toContain("window.__superagentAccessManagerFocusRequest(");
    expect(access).toContain("window.__superagentAccessManagerFocusRequest = async (requestId, tabHint = null)");
    expect(access).toContain("card.dataset.requestId = String(req.requestId ||");
    expect(access).toContain("row.dataset.requestId = String(req.requestId ||");
    expect(access).toContain("entry.classList.add(\"access-mcp-request-highlight\")");
    expect(js).not.toContain('mcp_project_access_action');
  });

  it.each([
    ["core", "health:core", "runtime:core"],
    ["security", "tray-ui:security:warning:1", "security"],
    ["mcp", "health:mcp-owner", "runtime:mcp"],
    ["tunnel", "health:tunnel", "runtime:cloudflare"],
    ["delegate", "health:delegate-listener", "delegate:diagnostics"],
    ["delegate", "tray-ui:delegate:error:1", "delegate:connection"],
    ["runtime", "health:muse", "runtime:muse"],
    ["runtime", "health:telegram", "settings:muse"],
    ["runtime", "health:channel-hosts", "runtime:hosts"],
    ["runtime", "tray-ui:runtime:error:1", "runtime:core"],
    ["desktop-live", "tray-ui:desktop-live:error:1", "desktop-live"],
    ["terminal", "tray-ui:terminal:error:1", "terminal"],
    ["lan-devices", "tray-ui:lan-devices:warning:1", "lan-devices:devices"],
    ["reminder", "reminder:run_42", "history"],
    ["reminder", "reminder-legacy", "jobs"],
    ["jobs", "daemon-run:run_42:Scheduled run needs attention", "history"],
    ["jobs", "daemon-run:run_42:Scheduled notification delivery failed", "history"],
    ["jobs", "tray-ui:jobs:warning:1", "jobs"],
    ["updates", "tray-ui:updates:error:1", "updates"],
    ["shutdown", "tray-ui:shutdown:error:1", "overview"],
    ["settings", "tray-ui:settings:error:1", "settings:general"],
    ["muse-files", "tray-ui:muse-files:warning:1", "muse-files"],
    ["overview", "tray-ui:overview:warning:1", "overview"],
    ["logs", "tray-ui:logs:error:1", "logs"],
  ])("routes %s event %s to %s", async (source, id, route) => {
    const mounted = mount([{
      id, source, severity: "warning", title: "System event", body: "Review",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const card = mounted.get("tray-notification-recent").children[0];
    card.trigger("click", { target: { closest: () => null } });
    expect(mounted.nav).toHaveBeenCalledWith(route);
    if (route === "history") {
      expect(mounted.window.__superagentPendingRunNotificationId).toBe("run_42");
    }
    expect(mounted.mockInvocations.some(call => ["approve", "deny", "run"].includes(call.action))).toBe(false);
  });

  it("focuses a known run and explains when the run no longer exists", () => {
    const app = fs.readFileSync(path.join(base, "ui/app.js"), "utf8");
    expect(app).toContain('const targetId = window.__superagentPendingRunNotificationId;');
    expect(app).toContain('selected && selected.runId === run.runId');
    expect(app).toContain('The execution from this notification was not found in recent history.');
    expect(html).toContain('id="history-notification-feedback"');
    expect(rust).toContain('Review its execution in History.');
  });


  it("marks card and View clicks read while keeping navigation synchronous", async () => {
    for (const mode of ["card", "view"]) {
      const mounted = mount([{
        id: "mcp-pending:connections:request-42", source: "security", severity: "critical",
        title: "MCP permission pending", body: "Review connection",
        createdAt: Date.now(), readAt: null, archivedAt: null,
      }]);
      // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
      const card = mounted.get("tray-notification-recent").children[0];
      const open = card.children[1].children[3].children[0];
      if (mode === "card") card.trigger("click", { target: { closest: () => null } });
      else open.trigger("click");
      expect(mounted.nav).toHaveBeenCalledWith("security:connections");
      // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mounted.mockInvocations.filter(call =>
        call.action === "read" && call.id === "mcp-pending:connections:request-42")).toHaveLength(1);
      expect(mounted.get("tray-notification-count").hidden).toBe(true);
    }
  });

  it("marks a clicked lifecycle action read without navigating to a different tab", async () => {
    const mounted = mount([{
      id: "incident-1", source: "runtime", severity: "warning",
      title: "Runtime incident", body: "Inspect runtime",
      createdAt: Date.now(), readAt: null, archivedAt: null,
    }]);
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const card = mounted.get("notification-inbox-list").children[0];
    const actions = card.children[1].children[3].children;
    const resolve = actions.find((button: any) => button.textContent === "Resolve");
    expect(resolve).toBeDefined();
    resolve.trigger("click");
    // Flush the native-invoke promise chain through the render turn, not
    // just the first two microtasks; this is deterministic across CI OSes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mounted.mockInvocations.some(call =>
      call.action === "resolve" && call.id === "incident-1")).toBe(true);
    expect(mounted.nav).not.toHaveBeenCalled();
    expect(mounted.get("tray-notification-count").hidden).toBe(true);
  });

  it("uses generic OS alerts and explicit policy instead of leaking Core errors", () => {
    expect(rust).toContain('static OS_ALERT_BUDGET:');
    expect(rust).toContain('os_alert_budget_available()');
    expect(rust).toContain('tray_notification_center::should_notify_os(&dir, source, severity)?');
    expect(rust).toContain('.title("SuperAgent needs attention")');
    expect(rust).not.toContain('.body(format!("Failed to start Core: {}", e))');
    expect(rust).not.toContain('.body(format!("Failed to restart Core: {}", e))');
    expect(rust).not.toContain('.body(format!("Failed to stop Core: {}", e))');
  });
  it("native API only acknowledges and archives; UI error summaries are redacted", () => {
    expect(store).toContain('["list", "read", "unread", "archive", "restore", "read-all"');
    expect(store).toContain('const MAX_ITEMS: usize = 300;');
    expect(store).toContain('id.chars().any(char::is_control)');
    expect(rust).toContain("tray_notification_center_action,");
    expect(rust).toContain("tray_notification_center_ui_alert,");
    expect(rust).toContain("tray_notification_center::publish(");
    expect(rust).toContain("An operation reported an issue.");
    expect(rust).not.toContain('tray_notification_center::publish(\n        &config_dir()?, &scope, severity, &id, &title,\n        error');
  });
});
