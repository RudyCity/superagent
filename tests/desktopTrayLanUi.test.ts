import { describe, expect, it, vi } from "vitest";
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
  type: string; className: string; focus: () => void; click: () => unknown; width: number; height: number; style: Record<string,string>;
  getContext: (kind: string, options?: unknown) => any;
  addEventListener: (type: string, listener: (e?: any) => unknown) => void;
  append: (...items: MockNode[]) => void; replaceChildren: (...items: MockNode[]) => void;
  setAttribute: (name: string, value: string) => void;
};
function node(): MockNode {
  const el = {
    children: [] as MockNode[], textContent: "", value: "", checked: false,
    hidden: false, disabled: false, listeners: new Map<string, (e?: any) => unknown>(),
    type: "", className: "", width: 320, height: 320, style: {},
    classList: { toggle: () => {} },
    focus: () => {},
    click: () => el.listeners.get("click")?.({ preventDefault() {} }),
    getContext: () => ({ fillStyle: "", imageSmoothingEnabled: false, fillRect: () => {}, clearRect: () => {} }),
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
  let apkVersion = "test";
  let apkHeartbeatOverride: any = null;
  let apkQrFailure: boolean | "timeout" = false;
  const requests: Array<{ action: string; payload: any }> = [];
  const invoke = async (_method: string, { action, payload }: any) => {
    expect(_method).toBe("lan_support_action");
    requests.push({ action, payload });
    if (action === "discover") return {
      success: true,
      devices: [{ name: "<img src=x onerror=alert(1)>", address: "192.168.50.10", port: 17845, fingerprint, platform }],
    };
    if (action === "list") return { success: true, devices: devices.map((d) => ({ ...d })), tunnelDevices: [] };
    if (action === "tunnel_invite") return { success: true, invite: {
      inviteId: "11111111-2222-4333-8444-555555555555",
      expiresAt: Date.now() + 10 * 60_000,
      setup: JSON.stringify({ url: "https://example.test", inviteId: "11111111-2222-4333-8444-555555555555", code: "0123456789" }),
      qrMatrix: { size: 21, cells: "1".repeat(21 * 21) },
    } };
    if (action === "apk_download_qr") {
      if (apkQrFailure) throw Error(apkQrFailure === "timeout"
        ? "request timed out after 75s" : "APK build temporarily unavailable");
      return { success: true, apk: {
        heartbeatId: "a".repeat(64), expiresAt: Date.now() + 10 * 60_000,
        size: 6_000_000, sha256: "b".repeat(64), filename: "SuperAgent-Android-" + apkVersion + ".apk",
        qrMatrix: { size: 21, cells: "1".repeat(21 * 21) },
      } };
    }
    if (action === "qr_heartbeat") return apkHeartbeatOverride && payload.kind === "apk"
      ? { success: true, kind: "apk", id: payload.id, tunnelActive: true, ...apkHeartbeatOverride }
      : {
        success: true, kind: payload.kind, id: payload.id, valid: true, state: "active",
        tunnelActive: true, expiresAt: Date.now() + 20_000, remainingMs: 20_000,
      };
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
  let heartbeatTick: (() => void) | null = null;
  const window = {
    __TAURI__: { core: { invoke } },
    confirm: () => true,
    setInterval: (fn: () => void) => { heartbeatTick = fn; return 1; },
    clearInterval: () => {},
    addEventListener: () => {},
  } as any;
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    getElementById: get,
    createElement: node,
    addEventListener: () => {},
  } as any;
  vm.runInNewContext(script, {
    document, window, navigator: {}, String, Number, Boolean, Error, Array, Object, Date, Math,
  });
  return { get, requests, window, heartbeat: () => heartbeatTick?.(),
    setApkVersion: (value: string) => { apkVersion = value; },
    setApkHeartbeat: (value: any) => { apkHeartbeatOverride = value; },
    setApkQrFailure: (value: boolean | "timeout") => { apkQrFailure = value; },
  };
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function click(el: MockNode) { await el.listeners.get("click")?.({ preventDefault() {} }); await flush(); }
async function submit(el: MockNode) { await el.listeners.get("submit")?.({ preventDefault() {} }); await flush(); }

describe("Device Tunnel Tray contract", () => {
  it("keeps tunnel enrollment local while exposing tunnel device management", () => {
    const html = fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"), "utf8");
    const native = fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/main.rs"), "utf8");
    for (const id of ["lan-tunnel-invite", "lan-tunnel-status", "lan-tunnel-devices", "lan-tunnel-qr-card", "lan-tunnel-qr",
      "lan-apk-download-qr", "lan-apk-qr-card", "lan-apk-qr", "lan-apk-status", "lan-apk-meta"])
      expect(html).toContain('id="' + id + '"');
    for (const action of ["tunnel_invite", "apk_download_qr", "qr_heartbeat", "tunnel_list", "tunnel_pair_request", "tunnel_revoke"])
      expect(native).toContain('"' + action + '"');
    expect(script).toContain('invoke("tunnel_invite")');
    expect(script).toContain('invoke("apk_download_qr")');
    expect(script).toContain('invoke("qr_heartbeat"');
    expect(script).toContain("const QR_HEARTBEAT_MS = 5000");
    expect(script).toContain("const QR_REFRESH_AHEAD_MS = 30000");
    expect(script).toContain("requestQrRefresh(kind");
    expect(script).toContain('lan-apk-qr');
        expect(script).toContain('drawQrMatrix(qr, qrMatrix)');
    expect(script).toContain('canvas.getContext("2d", { alpha: false })');
    expect(script).toContain('ctx.fillRect');
    expect(script).toContain('navigator.clipboard.writeText(setup)');
    expect(script).toContain('invoke("tunnel_pair_request"');
    expect(script).toContain('request.transport === "tunnel"');
  });
});

describe("QR heartbeat behavior", () => {
  it("automatically refreshes a connect QR when less than 30 seconds remain", async () => {
    const ui = setup();
    await flush();
    await click(ui.get("lan-tunnel-invite"));
    expect(ui.requests.filter((r) => r.action === "tunnel_invite")).toHaveLength(1);
    ui.heartbeat();
    await flush();
    expect(ui.requests.some((r) => r.action === "qr_heartbeat" && r.payload.kind === "connect")).toBe(true);
    expect(ui.requests.filter((r) => r.action === "tunnel_invite")).toHaveLength(2);
  });

  it("automatically refreshes an APK QR when less than 30 seconds remain", async () => {
    const ui = setup();
    await flush();
    await click(ui.get("lan-apk-download-qr"));
    expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(1);
    ui.heartbeat();
    await flush();
    expect(ui.requests.some((r) => r.action === "qr_heartbeat" && r.payload.kind === "apk")).toBe(true);
    expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(2);
  });
});

describe("APK build auto-sync through QR heartbeat", () => {
  it("automatically replaces the QR and metadata when an APK rebuild is detected", async () => {
    const ui = setup();
    await flush();
    await click(ui.get("lan-apk-download-qr"));
    expect(ui.get("lan-apk-meta").textContent).toContain("SuperAgent-Android-test.apk");
    ui.setApkVersion("0.10.1-updated");
    ui.setApkHeartbeat({ valid: false, reason: "artifact_changed", remainingMs: 300_000 });
    ui.heartbeat();
    await flush();
    expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(2);
    expect(ui.get("lan-apk-meta").textContent).toContain("SuperAgent-Android-0.10.1-updated.apk");
    expect(ui.get("lan-apk-meta").textContent).not.toContain("SuperAgent-Android-test.apk");
    expect(ui.get("lan-apk-qr-card").hidden).toBe(false);
  });

  it("hides an invalid QR and old build identity if its replacement cannot be created", async () => {
    const ui = setup();
    await flush();
    await click(ui.get("lan-apk-download-qr"));
    ui.setApkQrFailure(true);
    ui.setApkHeartbeat({ valid: false, reason: "artifact_unavailable", remainingMs: 300_000 });
    ui.heartbeat();
    await flush();
    expect(ui.get("lan-apk-qr-card").hidden).toBe(true);
    expect(ui.get("lan-apk-meta").textContent).toBe("");
    expect(ui.get("lan-apk-status").textContent).toContain("Cannot create Android APK download QR");
  });
  it("retries an unavailable APK build after a bounded interval and recovers without manual clicks", async () => {
    const ui = setup();
    await flush();
    await click(ui.get("lan-apk-download-qr"));
    ui.setApkQrFailure(true);
    ui.setApkHeartbeat({ valid: false, reason: "artifact_unavailable", remainingMs: 300_000 });
    ui.heartbeat();
    await flush();
    expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(2);
    expect(ui.get("lan-apk-qr-card").hidden).toBe(true);

    ui.heartbeat();
    await flush();
    expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(2);

    ui.setApkQrFailure(false);
    ui.setApkVersion("0.10.2-rebuilt");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16_000);
    try {
      ui.heartbeat();
      await flush();
      expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(3);
      expect(ui.get("lan-apk-meta").textContent).toContain("0.10.2-rebuilt.apk");
      expect(ui.get("lan-apk-qr-card").hidden).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("never retries an ambiguous timed-out QR request automatically", async () => {
    const ui = setup();
    await flush();
    await click(ui.get("lan-apk-download-qr"));
    ui.setApkQrFailure("timeout");
    ui.setApkHeartbeat({ valid: false, reason: "artifact_changed", remainingMs: 300_000 });
    ui.heartbeat();
    await flush();
    expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(2);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      ui.heartbeat();
      await flush();
      expect(ui.requests.filter((r) => r.action === "apk_download_qr")).toHaveLength(2);
      expect(ui.get("lan-apk-qr-card").hidden).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});

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
