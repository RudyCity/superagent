import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const base = "apps/superagent-tray";
const html = fs.readFileSync(path.join(base, "ui/index.html"), "utf8");
const js = fs.readFileSync(path.join(base, "ui/notifications.js"), "utf8");
const rust = fs.readFileSync(path.join(base, "src-tauri/src/main.rs"), "utf8");
const store = fs.readFileSync(path.join(base, "src-tauri/src/tray_notification_center.rs"), "utf8");

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
          expect(name).toMatch(/^tray_notification_center_(action|ui_alert)$/);
          if (name.endsWith("ui_alert")) return {};
          mockInvocations.push(args);
          if (args.action === "read" && args.id) {
            items = items.map((item) => item.id === args.id ? { ...item, readAt: 1700000000100 } : item);
          }
          if (args.action === "read-all") {
            items = items.map((item) => ({ ...item, readAt: 1700000000100 }));
          }
          return { items, unreadCount: items.filter((item) => !item.readAt).length };
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
  return { get, filters, mockInvocations, nav };
}

describe("Tray Notification Manager", () => {
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
    await Promise.resolve(); await Promise.resolve();
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
    await Promise.resolve(); await Promise.resolve();
    mounted.get("notification-read-all").trigger("click");
    await Promise.resolve(); await Promise.resolve();
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
    await Promise.resolve(); await Promise.resolve();
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
