import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { delegateBridge } from "../src/core/delegate/bridge.js";

const delegateJs = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/delegate.js"),
  "utf8"
);

function mountDelegateUi(mockStatus?: any, options: { startError?: string; statusError?: string } = {}) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: any) => any>();
  const invokeCalls: Array<{ action: string; payload: any }> = [];

  const defaultMockStatus = {
    running: true,
    port: 17341,
    endpoint: "ws://127.0.0.1:17341",
    activeProfiles: [
      {
        clientId: "client-alpha",
        label: "Profile 1 - Work",
        extensionId: "chrome-extension://abcdefghijklmnop",
        connectedAt: Date.now() - 60000,
      },
    ],
    openSockets: 1,
    pairingCode: "ABCD-EFGH",
    pairingExpiresAt: Date.now() + 600000,
    pairingTtlMs: 600000,
    authMode: "pairing_required",
  };

  const statusData = mockStatus ?? defaultMockStatus;

  function getOrCreateElement(id: string) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: "",
        innerHTML: "",
        className: "",
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
          toggle: vi.fn(),
        },
        dataset: {},
        disabled: false,
        hidden: false,
        value: "",
        addEventListener: (event: string, handler: (e: any) => any) => {
          listeners.set(`${id}:${event}`, handler);
        },
        dispatchEvent: (event: any) => {
          const handler = listeners.get(`${id}:${event.type}`);
          return handler ? handler(event) : true;
        },
        closest: (selector: string) => {
          if (selector === ".client-disconnect-btn") {
            return elements.get(id);
          }
          return null;
        },
      });
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
    location: { hash: "#delegate" },
    history: { replaceState: vi.fn() },
    confirm: vi.fn(() => true),
    alert: vi.fn(),
    Event: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    __TAURI__: {
      core: {
        invoke: vi.fn(async (cmd: string, args: any) => {
          if (cmd === "get_delegate_status") {
            invokeCalls.push({ action: "status", payload: null });
            if (options.statusError) throw new Error(options.statusError);
            return statusData;
          }
          if (cmd === "delegate_action") {
            invokeCalls.push({ action: args.action, payload: args.payload });
            if (args.action === "renew-code") {
              return {
                code: "WXYZ-9876",
                expiresAt: Date.now() + 600000,
                ttlRemainingMs: 600000,
              };
            }
            if (args.action === "disconnect") {
              return { success: true };
            }
            if (args.action === "start" || args.action === "stop") {
              if (args.action === "start" && options.startError) throw new Error(options.startError);
              statusData.running = args.action === "start";
              return { success: true, running: statusData.running };
            }
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
    Event: windowMock.Event,
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

  vm.runInContext(delegateJs, context);

  return {
    windowMock,
    elements,
    listeners,
    invokeCalls,
    clipboard,
    getOrCreateElement,
  };
}

describe("DelegateBridge backend methods", () => {
  it("provides status inspection and pairing lifecycle without crashing", () => {
    const status = delegateBridge.getStatus();
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("port");
    expect(status).toHaveProperty("endpoint");
    expect(status).toHaveProperty("activeProfiles");
    expect(status).toHaveProperty("authMode");
    expect(status.port).toBe(17341);

    const isRunning = delegateBridge.isRunning();
    expect(typeof isRunning).toBe("boolean");

    // A stopped listener must never issue a misleading, unusable pairing code.
    expect(() => delegateBridge.renewPairingCode()).toThrow("DELEGATE_LISTENER_NOT_RUNNING");
    expect(delegateBridge.getPairingCode()).toBeNull();

    const disc = delegateBridge.disconnectClient("non-existent-client");
    expect(disc).toBe(false);
  });
});

describe("Desktop Delegate UI Controller", () => {
  it("refreshes status and updates UI counters, pairing code, and profile table", async () => {
    const mounted = mountDelegateUi();
    await mounted.windowMock.__superagentDelegateRefresh();

    expect(mounted.invokeCalls.length).toBeGreaterThanOrEqual(1);
    expect(mounted.invokeCalls[0].action).toBe("status");

    const statClients = mounted.getOrCreateElement("delegate-stat-clients");
    const statSockets = mounted.getOrCreateElement("delegate-stat-sockets");
    const statAuth = mounted.getOrCreateElement("delegate-stat-authmode");
    const endpointEl = mounted.getOrCreateElement("delegate-endpoint-val");
    const statusText = mounted.getOrCreateElement("delegate-status-text");
    const pairCode = mounted.getOrCreateElement("delegate-pair-code");
    const tbody = mounted.getOrCreateElement("delegate-profiles-tbody");

    expect(statClients.textContent).toBe("1");
    expect(statSockets.textContent).toBe("1");
    expect(statAuth.textContent).toBe("Pairing Protected");
    expect(endpointEl.textContent).toBe("ws://127.0.0.1:17341");
    expect(statusText.textContent).toBe("Listener Active");
    expect(pairCode.textContent).toBe("ABCD-EFGH");
    expect(tbody.innerHTML).toContain("client-alpha");
    expect(tbody.innerHTML).toContain("Profile 1 - Work");
  });

  it("handles pairing code renewal and updates code display", async () => {
    const mounted = mountDelegateUi();
    await mounted.windowMock.__superagentDelegateRefresh();

    const renewHandler = mounted.listeners.get("delegate-pair-renew:click");
    expect(renewHandler).toBeDefined();

    await renewHandler!({});

    const renewCalls = mounted.invokeCalls.filter((c) => c.action === "renew-code");
    expect(renewCalls.length).toBe(1);

    const pairCode = mounted.getOrCreateElement("delegate-pair-code");
    expect(pairCode.textContent).toBe("WXYZ-9876");
  });

  it("copies pairing code to clipboard on button click", async () => {
    const mounted = mountDelegateUi();
    await mounted.windowMock.__superagentDelegateRefresh();

    const copyHandler = mounted.listeners.get("delegate-pair-copy:click");
    expect(copyHandler).toBeDefined();

    await copyHandler!({});
    expect(mounted.clipboard.written).toBe("ABCD-EFGH");
  });

  it("renders empty state table when no Chrome profiles are active", async () => {
    const mounted = mountDelegateUi({
      running: true,
      port: 17341,
      endpoint: "ws://127.0.0.1:17341",
      activeProfiles: [],
      openSockets: 0,
      pairingCode: null,
      authMode: "pairing_required",
    });

    await mounted.windowMock.__superagentDelegateRefresh();

    const tbody = mounted.getOrCreateElement("delegate-profiles-tbody");
    expect(tbody.innerHTML).toContain("No Chrome extensions currently connected");
  });

  it("starts the real listener only when Core confirms running and refreshes UI", async () => {
    const mounted = mountDelegateUi({
      running: false, port: 17341, endpoint: "ws://127.0.0.1:17341",
      activeProfiles: [], openSockets: 0, pairingCode: null,
    });
    await mounted.windowMock.__superagentDelegateRefresh();
    const click = mounted.listeners.get("delegate-listener-toggle:click");
    expect(click).toBeDefined();
    await click!({});
    expect(mounted.invokeCalls.some(call => call.action === "start")).toBe(true);
    expect(mounted.getOrCreateElement("delegate-status-text").textContent).toBe("Listener Active");
    expect(mounted.getOrCreateElement("delegate-listener-toggle").textContent).toBe("Stop Listener");
    expect(mounted.getOrCreateElement("delegate-listener-feedback").textContent).toContain("Listener aktif");
    expect(mounted.getOrCreateElement("delegate-listener-toggle").disabled).toBe(false);
  });

  it("explains stale worker EADDRINUSE visibly and never claims start succeeded", async () => {
    const mounted = mountDelegateUi({
      running: false, port: 17341, activeProfiles: [], openSockets: 0, pairingCode: null,
    }, { startError: "Core HTTP 400: DELEGATE_BRIDGE_BIND_FAILED: EADDRINUSE port 17341" });
    await mounted.windowMock.__superagentDelegateRefresh();
    await mounted.listeners.get("delegate-listener-toggle:click")!({});
    expect(mounted.getOrCreateElement("delegate-listener-feedback").textContent).toContain("worker Core lama");
    expect(mounted.getOrCreateElement("delegate-status-text").textContent).toBe("Listener Stopped");
    expect(mounted.getOrCreateElement("delegate-listener-toggle").disabled).toBe(false);
    expect(mounted.windowMock.alert).not.toHaveBeenCalled();
  });

  it("distinguishes an unreachable Core from a stopped listener and refuses unsafe toggle", async () => {
    const mounted = mountDelegateUi(undefined, { statusError: "Core offline" });
    await mounted.windowMock.__superagentDelegateRefresh();
    expect(mounted.getOrCreateElement("delegate-status-text").textContent).toBe("Core Unreachable");
    await mounted.listeners.get("delegate-listener-toggle:click")!({});
    expect(mounted.invokeCalls.some(call => call.action === "start")).toBe(false);
    expect(mounted.getOrCreateElement("delegate-listener-feedback").textContent).toContain("Core tidak terjangkau");
  });

  it("disables Renew Pairing Code while listener is stopped", async () => {
    const mounted = mountDelegateUi({
      running: false, desiredEnabled: false,
      port: 17341, endpoint: "ws://127.0.0.1:17341",
      activeProfiles: [], openSockets: 0, pairingCode: null,
    });
    await mounted.windowMock.__superagentDelegateRefresh();
    expect(mounted.getOrCreateElement("delegate-pair-renew").disabled).toBe(true);
    await mounted.listeners.get("delegate-pair-renew:click")!({});
    expect(mounted.invokeCalls.filter(call => call.action === "renew-code")).toHaveLength(0);
    expect(mounted.getOrCreateElement("delegate-listener-feedback").textContent).toContain("Start Listener dahulu");
  });

  it("disconnects an active client when disconnect button is clicked", async () => {
    const mounted = mountDelegateUi();
    await mounted.windowMock.__superagentDelegateRefresh();

    const tableHandler = mounted.listeners.get("delegate-profiles-tbody:click");
    expect(tableHandler).toBeDefined();

    const disconnectBtn = mounted.getOrCreateElement("btn-disc");
    disconnectBtn.dataset.clientId = "client-alpha";
    disconnectBtn.classList.add("client-disconnect-btn");

    await tableHandler!({
      target: disconnectBtn,
    });

    const discCalls = mounted.invokeCalls.filter((c) => c.action === "disconnect");
    expect(discCalls.length).toBe(1);
    expect(discCalls[0].payload).toEqual({ clientId: "client-alpha" });
  });
});
