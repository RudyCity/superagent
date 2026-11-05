import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ui = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/muse-files.js"), "utf8"
);
const html = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/index.html"), "utf8"
);

const settings = {
  version: 1, maxFileMiB: 8, historyDays: 7,
  refreshSeconds: 2, defaultTransport: "muse-websocket",
};
const snapshot = (extras: Record<string, any> = {}) => ({
  success: true, port: 9225, watcherActive: true,
  watcherConnected: true, telegramConfigured: true,
  active: null, history: [], settings, ...extras,
});
function mount(status = snapshot()) {
  const elements = new Map<string, any>();
  const handlers = new Map<string, (e: any) => any>();
  const invokeCalls: Array<{ command: string; args: any }> = [];
  let currentStatus = status;
  function get(id: string) {
    if (!elements.has(id)) {
      const el: any = {
        id, value: "", textContent: "", innerHTML: "", disabled: false,
        hidden: id === "page-muse-files" ? false : true,
        dataset: {}, style: {}, attributes: {} as Record<string, string>,
        classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
        addEventListener(event: string, fn: any) { handlers.set(id + ":" + event, fn); },
        setAttribute(k: string, v: string) { el.attributes[k] = v; },
      };
      if (id === "muse-files-transport") el.value = "muse-websocket";
      elements.set(id, el);
    }
    return elements.get(id);
  }
  const invoke = vi.fn(async (command: string, args: any) => {
    invokeCalls.push({ command, args });
    if (command === "muse_file_control" && args?.action === "status") return currentStatus;
    if (command === "muse_file_pick") return {
      ticket: "native-one-time-ticket", name: "sales.csv", size: 524288,
    };
    if (command === "muse_file_start") return {
      success: true, job: {
        id: "daab8537-591e-45a4-8310-83170fa8d0a2", state: "transferring",
      },
    };
    if (command === "muse_file_control" && args?.action === "settings")
      return { success: true, settings: args.settings };
    if (command === "muse_file_control") return { success: true };
    throw Error("Unexpected IPC command");
  });
  const windowMock: any = {
    __TAURI__: { core: { invoke } },
    addEventListener: vi.fn(), confirm: vi.fn(() => true),
  };
  const context = vm.createContext({
    document: { getElementById: get }, window: windowMock,
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
    Date, Number, String, Math, Object, Array, Intl,
  });
  vm.runInContext(ui, context);
  return {
    get, invoke, invokeCalls, windowMock, handlers,
    setStatus(next: any) { currentStatus = next; },
    refresh: () => windowMock.__superagentMuseFilesRefresh(),
    async click(id: string) {
      const handler = handlers.get(id + ":click");
      if (!handler) throw Error("Click handler missing: " + id);
      await handler({ target: get(id), preventDefault: vi.fn() });
    },
    async submit(id: string) {
      await handlers.get(id + ":submit")?.({ preventDefault: vi.fn() });
    },
  };
}
describe("SuperAgent Tray Muse File Transfer UI", () => {
  it("is part of existing app nav and includes controls with accessible progress and settings", () => {
    for (const id of [
      "nav-muse-files", "page-muse-files", "muse-files-choose", "muse-files-send",
      "muse-files-progress-track", "muse-files-pause", "muse-files-resume",
      "muse-files-cancel", "muse-files-history-table", "muse-files-settings",
    ]) expect(html).toContain('id="' + id + '"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('src="./muse-files.js"');
  });

  it("uses a native picker ticket, not caller-specified file paths", async () => {
    const m = mount();
    await m.refresh();
    await m.click("muse-files-choose");
    expect(m.get("muse-files-selected-name").textContent).toBe("sales.csv");
    expect(m.get("muse-files-send").disabled).toBe(false);
    await m.click("muse-files-send");
    const upload = m.invokeCalls.find(x => x.command === "muse_file_start");
    expect(upload?.args).toEqual({
      ticket: "native-one-time-ticket", kind: "muse-websocket",
    });
    expect(JSON.stringify(upload)).not.toContain("filePath");
  });

  it("refuses WebSocket upload with no authenticated Muse receiver session", async () => {
    const m = mount(snapshot({ watcherActive: true, watcherConnected: false }));
    await m.refresh();
    await m.click("muse-files-choose");
    expect(m.get("muse-files-send").disabled).toBe(true);
    expect(m.get("muse-files-ws-state").textContent).toBe("Waiting");
  });

  it("renders untrusted filenames safely and does not confuse Telegram acceptance with Muse SHA", async () => {
    const m = mount(snapshot({
      history: [{
        id: "ef1b4a2e-0cb9-4a15-81bf-5b61a6f0526e",
        name: '<img src=x onerror=alert(1)>.csv',
        size: 524288, bytes: 524288, percent: 100,
        state: "completed", kind: "telegram",
        verification: "telegram-accepted", startedAt: 1793792800000,
      }],
    }));
    await m.refresh();
    expect(m.get("muse-files-history-table").innerHTML).not.toContain("<img");
    expect(m.get("muse-files-history-table").innerHTML).toContain("Not verified by Muse");
    expect(m.get("muse-files-progress-detail").textContent)
      .toContain("Muse ingestion not confirmed");
    expect(m.get("muse-files-progress-track").attributes["aria-valuenow"]).toBe("100");
  });

  it("calls scoped pause/resume/cancel controls with the displayed job ID", async () => {
    const id = "f27fb3e1-04d0-4da4-9ba1-f7c43d9ee5b6";
    const base = { id, name: "report.csv", size: 1000, bytes: 100,
      percent: 10, state: "transferring", kind: "muse-websocket",
      startedAt: Date.now(),
    };
    const m = mount(snapshot({ active: base, history: [base] }));
    await m.refresh();
    await m.click("muse-files-pause");
    expect(m.invokeCalls.some(x => x.args?.action === "pause" && x.args?.id === id)).toBe(true);
    m.setStatus(snapshot({ active: null,
      history: [{ ...base, state: "paused" }] }));
    await m.refresh();
    await m.click("muse-files-resume");
    expect(m.invokeCalls.some(x => x.args?.action === "resume" && x.args?.id === id)).toBe(true);
  });

  it("saves only fixed, bounded settings through Tauri IPC", async () => {
    const m = mount();
    await m.refresh();
    m.get("muse-files-limit").value = "4";
    await m.submit("muse-files-settings");
    const saved = m.invokeCalls.find(x => x.args?.action === "settings");
    expect(saved?.args?.settings.maxFileMiB).toBe(4);
    expect(Object.keys(saved?.args?.settings).sort()).toEqual(
      ["defaultTransport", "historyDays", "maxFileMiB", "refreshSeconds", "version"]
    );
  });
});
