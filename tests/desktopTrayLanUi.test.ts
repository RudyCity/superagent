import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const script = fs.readFileSync(path.resolve("apps/superagent-tray/ui/lan-devices.js"), "utf8");
const id = "abed572a-17c2-4bf1-a47b-39a2a13e969a";
const fingerprint = "a".repeat(64);

type MockNode = {
  children: MockNode[]; textContent: string; value: string; checked: boolean;
  hidden: boolean; disabled: boolean; listeners: Map<string, (e?: any) => unknown>;
  classList: { toggle: (name: string, on: boolean) => void };
  type: string; className: string; focus: () => void;
  addEventListener: (type: string, listener: (e?: any) => unknown) => void;
  append: (...items: MockNode[]) => void; replaceChildren: (...items: MockNode[]) => void;
  setAttribute: (name: string, value: string) => void;
};
function node(): MockNode {
  const el = {
    children: [] as MockNode[], textContent: "", value: "", checked: false,
    hidden: false, disabled: false, listeners: new Map<string, (e?: any) => unknown>(),
    type: "", className: "",
    classList: { toggle: () => {} },
    focus: () => {},
    addEventListener(type: string, listener: (e?: any) => unknown) { el.listeners.set(type, listener); },
    append(...items: MockNode[]) { el.children.push(...items); },
    replaceChildren(...items: MockNode[]) { el.children = items; },
    setAttribute: () => {},
  };
  return el;
}
function setup(platform: "windows" | "android" = "windows") {
  const nodes = new Map<string, MockNode>();
  const get = (key: string) => {
    if (!nodes.has(key)) nodes.set(key, node());
    return nodes.get(key)!;
  };
  let devices: any[] = [];
  const requests: Array<{ action: string; payload: any }> = [];
  const invoke = async (_method: string, { action, payload }: any) => {
    expect(_method).toBe("lan_support_action");
    requests.push({ action, payload });
    if (action === "discover") return {
      success: true,
      devices: [{ name: "<img src=x onerror=alert(1)>", address: "192.168.50.10", port: 17845, fingerprint, platform }],
    };
    if (action === "list") return { success: true, devices: devices.map((d) => ({ ...d })) };
    if (action === "pair") {
      devices = [{ id, host: payload.host, port: payload.port, fingerprint, label: "LAN Client", platform, connected: false }];
      return { success: true, device: { ...devices[0] } };
    }
    if (action === "open") { devices[0].connected = true; return { success: true, device: { ...devices[0] } }; }
    if (action === "exec") return { success: true, result: { ok: true, exitCode: 0, stdout: "REMOTE_TEST_OK\n", stderr: "" } };
    if (action === "close") { devices[0].connected = false; return { success: true }; }
    if (action === "revoke") { devices = []; return { success: true }; }
    throw Error("Unexpected LAN action " + action);
  };
  get("page-lan-devices").hidden = false;
  const window = { __TAURI__: { core: { invoke } }, confirm: () => true } as any;
  vm.runInNewContext(script, {
    document: { readyState: "complete", getElementById: get, createElement: node },
    window, String, Number, Boolean, Error, Array, Object,
  });
  return { get, requests, window };
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function click(el: MockNode) { await el.listeners.get("click")?.({ preventDefault() {} }); await flush(); }
async function submit(el: MockNode) { await el.listeners.get("submit")?.({ preventDefault() {} }); await flush(); }

describe("LAN Devices Tray UI behavior", () => {
  it("directed IPv4 scan uses exact target, clears stale results, and preserves segment", async () => {
    const ui = setup("android");
    await flush();
    ui.get("lan-segment-name").value = "Campus-A";
    ui.get("lan-direct-ip").value = "10.200.4.187";
    await click(ui.get("lan-discovery-scan"));
    expect(ui.requests.find((r) => r.action === "discover")?.payload)
      .toEqual({ segment: "Campus-A", targetIp: "10.200.4.187" });
    ui.get("lan-direct-ip").value = "10.200.4.188";
    ui.get("lan-direct-ip").listeners.get("input")?.();
    expect(ui.get("lan-discovered").children[0].textContent).toContain("No LAN Clients");
    ui.get("lan-direct-ip").value = "8.8.8.8";
    await click(ui.get("lan-discovery-scan"));
    expect(ui.requests.filter((r) => r.action === "discover")).toHaveLength(1);
  });

  it("discovers via fixed native command and never treats UDP fingerprint as verified", async () => {
    const ui = setup();
    await flush();
    ui.get("lan-segment-name").value = "Team-A";
    await click(ui.get("lan-discovery-scan"));
    expect(ui.requests.some((r) => r.action === "discover" && r.payload.segment === "Team-A")).toBe(true);
    const discovered = ui.get("lan-discovered").children[0];
    expect(discovered.children[0].children[0].textContent).toBe("<img src=x onerror=alert(1)>");
    expect(discovered.children[0].children[0].children).toHaveLength(0);
    await click(discovered.children[1].children[0]);
    expect(ui.get("lan-pair-ip").value).toBe("192.168.50.10");
    expect(ui.get("lan-pair-fingerprint").value).toBe(fingerprint);
    expect(ui.get("lan-verified").checked).toBe(false);
  });

  it("reports missing fields instead of silently ignoring Request pairing", async () => {
    const ui = setup("android");
    await flush();
    await submit(ui.get("lan-pair-form"));
    expect(ui.requests.filter((r) => r.action === "pair")).toHaveLength(0);
    expect(ui.get("lan-pair-status").textContent).toContain("valid private IPv4");
    expect(ui.get("lan-pair-status").textContent).toContain("8-digit pairing code");
    expect(ui.get("lan-pair-status").textContent).toContain("fingerprint confirmation");

    ui.get("lan-pair-ip").value = "10.200.4.187";
    ui.get("lan-pair-port").value = "17845";
    ui.get("lan-pair-code").value = "12345678";
    ui.get("lan-pair-fingerprint").value = fingerprint;
    ui.get("lan-pair-label").value = "SuperAgent Tray";
    await submit(ui.get("lan-pair-form"));
    expect(ui.get("lan-pair-status").textContent).toContain("fingerprint confirmation");
    expect(ui.requests.filter((r) => r.action === "pair")).toHaveLength(0);

    ui.get("lan-verified").checked = true;
    ui.get("lan-pair-ip").value = "8.8.8.8";
    await submit(ui.get("lan-pair-form"));
    expect(ui.get("lan-pair-status").textContent).toContain("valid private IPv4");
    expect(ui.requests.filter((r) => r.action === "pair")).toHaveLength(0);

    ui.get("lan-pair-ip").value = "10.200.4.187";
    await submit(ui.get("lan-pair-form"));
    expect(ui.requests.filter((r) => r.action === "pair")).toHaveLength(1);
    expect(ui.get("lan-pair-status").textContent).toContain("Pairing approved");
  });

  it("shows waiting approval and actionable Core errors in the pair form", async () => {
    const ui = setup("android");
    await flush();
    ui.get("lan-pair-ip").value = "10.200.4.187";
    ui.get("lan-pair-port").value = "17845";
    ui.get("lan-pair-code").value = "12345678";
    ui.get("lan-pair-fingerprint").value = fingerprint;
    ui.get("lan-pair-label").value = "SuperAgent Tray";
    ui.get("lan-verified").checked = true;
    ui.get("lan-segment-name").value = "testing";
    const original = ui.window.__TAURI__.core.invoke;
    let rejectPair!: (reason: Error) => void;
    ui.window.__TAURI__.core.invoke = async (name: string, input: any) => {
      if (input.action === "pair") {
        return await new Promise((_resolve, reject) => { rejectPair = reject; });
      }
      return await original(name, input);
    };
    await submit(ui.get("lan-pair-form"));
    expect(ui.get("lan-pair-submit").textContent).toContain("Waiting for device approval");
    expect(ui.get("lan-pair-status").textContent).toContain("Approve the prompt on Android");
    await submit(ui.get("lan-pair-form"));
    expect(ui.get("lan-pair-status").textContent).toContain("already in progress");
    rejectPair(Error("Core HTTP 409: Full YOLO must be enabled locally."));
    await flush();
    expect(ui.get("lan-pair-status").textContent).toContain("Enable Full YOLO");
    expect(ui.get("lan-pair-submit").textContent).toBe("Request pairing");
    expect(ui.get("lan-pair-code").value).toBe("");
  });

  it("requires verified fingerprint, clears PIN, and manages an approved terminal session", async () => {
    const ui = setup();
    await flush();
    ui.get("lan-pair-ip").value = "192.168.50.10";
    ui.get("lan-pair-port").value = "17845";
    ui.get("lan-pair-fingerprint").value = fingerprint;
    ui.get("lan-pair-code").value = "12345678";
    ui.get("lan-pair-label").value = "SuperAgent Tray";
    await submit(ui.get("lan-pair-form"));
    expect(ui.requests.some((r) => r.action === "pair")).toBe(false);
    ui.get("lan-verified").checked = true;
    await submit(ui.get("lan-pair-form"));
    expect(ui.requests.filter((r) => r.action === "pair")).toHaveLength(1);
    expect(ui.get("lan-pair-code").value).toBe("");
    expect(ui.get("lan-verified").checked).toBe(false);
    const row = ui.get("lan-paired").children[0];
    await click(row.children[1].children[1]); // Request session
    expect(ui.requests.some((r) => r.action === "open" && r.payload.deviceId === id)).toBe(true);
    expect(ui.get("lan-command").disabled).toBe(false);
    ui.get("lan-command").value = "Write-Output REMOTE_TEST_OK";
    await submit(ui.get("lan-command-form"));
    expect(ui.requests.find((r) => r.action === "exec")?.payload.command).toBe("Write-Output REMOTE_TEST_OK");
    expect(ui.get("lan-output").textContent).toContain("REMOTE_TEST_OK");
    const newRow = ui.get("lan-paired").children[0];
    await click(newRow.children[1].children[2]); // Disconnect
    expect(ui.get("lan-command").disabled).toBe(true);
    const disconnected = ui.get("lan-paired").children[0];
    await click(disconnected.children[1].children[3]); // Revoke
    expect(ui.requests.some((r) => r.action === "revoke")).toBe(true);
    expect(ui.get("lan-paired-count").textContent).toBe("0 paired");
  });
});


describe("Android targets in the existing LAN Devices Tray", () => {
  it("offers Android-only diagnostics and never PowerShell when Android is selected", async () => {
    const ui = setup("android");
    await flush();
    ui.get("lan-pair-ip").value = "192.168.50.10";
    ui.get("lan-pair-port").value = "17845";
    ui.get("lan-pair-fingerprint").value = fingerprint;
    ui.get("lan-pair-code").value = "98765432";
    ui.get("lan-pair-label").value = "SuperAgent Tray";
    ui.get("lan-verified").checked = true;
    await submit(ui.get("lan-pair-form"));
    const first = ui.get("lan-paired").children[0];
    await click(first.children[1].children[1]); // Approved session
    const presets = ui.get("lan-command-presets");
    const values = presets.children.map((option) => option.value);
    expect(values).toContain("android.info");
    expect(values).toContain("android.network");
    expect(values).toContain("android.battery");
    expect(values).not.toContain("Get-ComputerInfo | Select-Object WindowsProductName");
    expect(ui.get("lan-command-mode").textContent).toContain("Android");
    expect(ui.get("lan-command").placeholder).toBe("android.info");
    presets.value = "android.storage";
    presets.listeners.get("change")?.();
    expect(ui.get("lan-command").value).toBe("android.storage");
  });
});


describe("Expanded Android support actions in Tray", () => {
  async function pairedPhone() {
    const ui = setup("android");
    await flush();
    ui.get("lan-pair-ip").value = "192.168.50.10";
    ui.get("lan-pair-port").value = "17845";
    ui.get("lan-pair-fingerprint").value = fingerprint;
    ui.get("lan-pair-code").value = "98765432";
    ui.get("lan-pair-label").value = "SuperAgent Tray";
    ui.get("lan-verified").checked = true;
    await submit(ui.get("lan-pair-form"));
    await click(ui.get("lan-paired").children[0].children[1].children[1]);
    return ui;
  }

  it("requires an explicit controller confirmation before requesting an Android action", async () => {
    const ui = await pairedPhone();
    ui.get("lan-command").value = "android.action.volume_up";
    ui.window.confirm = () => false;
    await submit(ui.get("lan-command-form"));
    expect(ui.requests.filter((r) => r.action === "exec")).toHaveLength(0);
    ui.window.confirm = () => true;
    await submit(ui.get("lan-command-form"));
    expect(ui.requests.find((r) => r.action === "exec")?.payload.command)
      .toBe("android.action.volume_up");
    expect(ui.get("lan-output").textContent).toContain("REMOTE_TEST_OK");
  });

  it("can revoke while a phone action is still pending", async () => {
    const ui = await pairedPhone();
    const original = ui.window.__TAURI__.core.invoke;
    let release!: (value: unknown) => void;
    ui.window.__TAURI__.core.invoke = async (name: string, input: any) => {
      if (input.action === "exec") {
        return await new Promise((resolve) => { release = resolve; });
      }
      return await original(name, input);
    };
    ui.get("lan-command").value = "android.action.open_wifi_settings";
    await submit(ui.get("lan-command-form"));
    expect(ui.requests.some((r) => r.action === "revoke")).toBe(false);
    const row = ui.get("lan-paired").children[0];
    expect(row.children[1].children[3].disabled).toBe(false);
    await click(row.children[1].children[3]);
    expect(ui.requests.some((r) => r.action === "revoke")).toBe(true);
    release({ success: true, result: { ok: false, exitCode: -1, error: "Session revoked" } });
    await flush();
    expect(ui.get("lan-paired-count").textContent).toBe("0 paired");
  });
});
