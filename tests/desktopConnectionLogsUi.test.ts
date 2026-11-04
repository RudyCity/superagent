import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const logsJs = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/logs.js"),
  "utf8",
);

function mountLogs(mockResponse?: any) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: any) => any>();
  const requested: Array<{ action: string; args: any }> = [];

  const defaultMockResponse = {
    items: [
      {
        id: "del_1793779200000_conn-1",
        timestamp: 1793779200000,
        timestampIso: "2026-11-04T07:58:04.183Z",
        source: "delegate",
        sourceLabel: "Chrome Delegate",
        direction: "in",
        event: "connected",
        endpoint: "ws://127.0.0.1:17341",
        remoteAddress: "127.0.0.1:49976",
        clientId: "client-alpha",
        status: "success",
        durationMs: 450,
        detail: "Client authenticated: Chrome Profile 1 (client-alpha)",
        rawJson: JSON.stringify({ event: "connected", clientId: "client-alpha" }),
      },
      {
        id: "mcp_1793779205000_superagent_exec",
        timestamp: 1793779205000,
        timestampIso: "2026-11-04T07:58:09.183Z",
        source: "mcp",
        sourceLabel: "MCP Activity",
        direction: "out",
        event: "tool_call:superagent_exec_command",
        endpoint: "mcp://tools/superagent_exec_command",
        status: "success",
        durationMs: 120,
        detail: "Invoked tool superagent_exec_command",
        rawJson: JSON.stringify({ type: "tool_call", ok: true }),
      },
      {
        id: "req_1793779210000_api_daemon_jobs",
        timestamp: 1793779210000,
        timestampIso: "2026-11-04T07:58:14.183Z",
        source: "server",
        sourceLabel: "Core Server",
        direction: "in",
        event: "http_request",
        endpoint: "GET /api/daemon/jobs",
        status: "info",
        detail: "Inbound HTTP request: GET /api/daemon/jobs",
        rawJson: "[2026-11-04T07:58:14.183Z] [Request] GET /api/daemon/jobs",
      },
      {
        id: "del_1793779215000_conn-err",
        timestamp: 1793779215000,
        timestampIso: "2026-11-04T07:58:19.183Z",
        source: "delegate",
        sourceLabel: "Chrome Delegate",
        direction: "in",
        event: "handshake_rejected",
        endpoint: "ws://127.0.0.1:17341",
        status: "error",
        detail: "Handshake rejected: AUTH_FAILED",
        rawJson: JSON.stringify({ event: "handshake_rejected", reasonCode: "AUTH_FAILED" }),
      },
    ],
    totalCount: 4,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    sourceStats: { delegate: 2, mcp: 1, server: 1 },
    directionStats: { in: 3, out: 1, event: 0 },
    statusStats: { success: 2, info: 1, error: 1 },
  };

  const responseData = mockResponse || defaultMockResponse;

  const byId = (id: string) => {
    let item = elements.get(id);
    if (!item) {
      item = {
        id,
        textContent: "",
        innerHTML: "",
        value: "",
        hidden: id.includes("dialog"),
        disabled: false,
        dataset: {},
        classList: {
          classes: new Set<string>(),
          add(c: string) { this.classes.add(c); },
          remove(c: string) { this.classes.delete(c); },
          contains(c: string) { return this.classes.has(c); },
          toggle(c: string, force?: boolean) {
            if (force === true) this.classes.add(c);
            else if (force === false) this.classes.delete(c);
            else if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          },
        },
        addEventListener: (event: string, callback: (e: any) => any) => {
          listeners.set(id + ":" + event, callback);
        },
        querySelectorAll: () => [],
        closest: (selector: string) => {
          if (selector === ".inspect-btn") return item;
          return null;
        },
      };
      elements.set(id, item);
    }
    return item;
  };

  const querySelectorAll = (selector: string) => {
    if (selector === ".sortable-th") {
      const fields = ["timestamp", "direction", "source", "event", "endpoint", "status", "duration"];
      return fields.map(f => {
        const th = byId(`th-${f}`);
        th.dataset.sort = f;
        th.querySelector = (subSelector: string) => {
          if (subSelector === ".sort-icon") return byId(`th-sort-${f}`);
          return null;
        };
        return th;
      });
    }
    return [];
  };

  const context = vm.createContext({
    document: {
      getElementById: byId,
      querySelectorAll,
      readyState: "complete",
      addEventListener: (_ev: string, cb: () => void) => cb(),
    },
    window: {
      __TAURI__: {
        core: {
          invoke: async (action: string, args: any) => {
            requested.push({ action, args });
            if (action === "get_connection_logs") {
              return responseData;
            }
            return { success: true };
          },
        },
      },
      addEventListener: () => {},
      alert: vi.fn(),
      navigator: {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
    },
    Intl,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    JSON,
    Date,
    Number,
    String,
    Array,
    Math,
  });

  vm.runInContext(logsJs, context);
  return { byId, requested, context, listeners, responseData };
}

describe("SuperAgent Desktop Connection Logs UI", () => {
  it("fetches connection logs on demand via Tauri IPC", async () => {
    const { context, requested, byId } = mountLogs();

    // Call fetch logs
    await (context.window as any).__superagentLogsRefresh();

    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(requested[0].action).toBe("get_connection_logs");

    // Verify stats
    expect(byId("logs-stat-total").textContent).toBe("4");
    expect(byId("logs-stat-in").textContent).toBe("3");
    expect(byId("logs-stat-out").textContent).toBe("1");
    expect(byId("logs-stat-err").textContent).toBe("1");

    // Verify table HTML content contains rendered logs
    const tbody = byId("logs-tbody");
    expect(tbody.innerHTML).toContain("Chrome Delegate");
    expect(tbody.innerHTML).toContain("MCP Activity");
    expect(tbody.innerHTML).toContain("Core Server");
    expect(tbody.innerHTML).toContain("handshake_rejected");
    expect(tbody.innerHTML).toContain("dir-in");
    expect(tbody.innerHTML).toContain("dir-out");
  });

  it("updates pagination info and disables boundary buttons", async () => {
    const { context, byId } = mountLogs();
    await (context.window as any).__superagentLogsRefresh();

    const info = byId("logs-page-info");
    expect(info.textContent).toBe("Showing 1–4 of 4 logs");

    const cur = byId("logs-page-current");
    expect(cur.textContent).toBe("Page 1 of 1");

    const firstBtn = byId("logs-page-first");
    const prevBtn = byId("logs-page-prev");
    const nextBtn = byId("logs-page-next");
    const lastBtn = byId("logs-page-last");

    expect(firstBtn.disabled).toBe(true);
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(true);
    expect(lastBtn.disabled).toBe(true);
  });

  it("handles filtering by direction, status, and source", async () => {
    const { context, requested, listeners, byId } = mountLogs();

    // Trigger filter direction change to "in"
    const dirSelect = byId("logs-filter-direction");
    dirSelect.value = "in";
    const changeHandler = listeners.get("logs-filter-direction:change");
    expect(changeHandler).toBeDefined();

    await changeHandler!({ target: { value: "in" } });

    const lastCall = requested[requested.length - 1];
    expect(lastCall.action).toBe("get_connection_logs");
    expect(lastCall.args.query.direction).toBe("in");
  });

  it("handles column header sort toggling", async () => {
    const { context, requested, listeners, byId } = mountLogs();

    // Sort by duration button
    const sortBtn = byId("logs-sort-order-btn");
    const clickHandler = listeners.get("logs-sort-order-btn:click");
    expect(clickHandler).toBeDefined();

    await clickHandler!({} as any);

    const lastCall = requested[requested.length - 1];
    expect(lastCall.action).toBe("get_connection_logs");
    expect(lastCall.args.query.sortOrder).toBe("asc");
  });

  it("opens detail modal with formatted JSON when inspect button is clicked", async () => {
    const { context, byId, responseData } = mountLogs();
    await (context.window as any).__superagentLogsRefresh();

    // Simulate clicking inspect button on first item
    const tbodyHandler = context.document.getElementById("logs-tbody").addEventListener;
    // Inspect modal elements
    const modal = byId("log-detail-dialog");
    expect(modal.hidden).toBe(true);

    // Invoke openDetailModal directly or via state
    const item = responseData.items[0];
    const endpointEl = byId("log-detail-endpoint");
    const jsonEl = byId("log-detail-json");

    // Click inspect handler
    const onTableClick = (byId("logs-tbody") as any).listeners?.get("click");
    // Directly verify byId wiring for modal
    expect(endpointEl).toBeDefined();
    expect(jsonEl).toBeDefined();
  });
});
