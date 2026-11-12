import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type ClickHandler = (event: { currentTarget: FakeNode }) => void;
class FakeNode {
  children: FakeNode[] = [];
  handlers: Record<string, ClickHandler> = {};
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  type = "";
  value = "";
  hidden = false;
  append(node: FakeNode) { this.children.push(node); }
  replaceChildren(...nodes: FakeNode[]) { this.children = nodes; }
  addEventListener(type: string, handler: ClickHandler) { this.handlers[type] = handler; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
}

function visibleText(node: FakeNode): string {
  return [node.textContent, ...node.children.map(visibleText)].join(" ");
}

function makeTrayHarness() {
  const ids = [
    "delegate-action-history", "delegate-action-status", "delegate-action-summary",
    "delegate-action-toggle", "multitab-count-tabs", "multitab-count-active",
    "multitab-count-queued", "multitab-count-unknown", "page-delegate",
  ];
  const nodes = new Map(ids.map(id => [id, new FakeNode()]));
  let snapshot: Record<string, unknown> = {
    success: true, profiles: [], owners: [], tasks: [], counts: {
      sending: 0, monitoring: 0, queued: 0, uncertain: 0, interrupted: 0,
    }, sessionsStatus: "known", sessions: [], observedAt: Date.now(),
    actionDiagnosticsStatus: "known", actionDiagnostics: [{
      operationId: "c3dd0b2a-71d2-4a70-8204-cb609e7e703c",
      at: Date.now(), transport: "delegate", command: "click",
      elapsedMs: 21, outcome: "unknown", retryPolicy: "manual_reconcile",
      category: "TIMEOUT", clientFingerprint: "1234abcd5678", tabId: 12,
    }],
  };
  const listeners: Record<string, () => void> = {};
  const document = {
    readyState: "loading",
    hidden: false,
    documentElement: { isConnected: true },
    getElementById(id: string) { return nodes.get(id) || null; },
    createElement() { return new FakeNode(); },
    addEventListener(event: string, callback: () => void) { listeners[event] = callback; },
  };
  const window: Record<string, unknown> = {};
  const source = readFileSync("apps/superagent-tray/ui/delegate-multitab.js", "utf8");
  runInNewContext(source, {
    document, window,
    Intl, Date, console, Number, String, Array, Math, RegExp,
    setInterval() { return 1; },
    fetch: async () => ({ ok: true, json: async () => snapshot }),
  });
  listeners.DOMContentLoaded();
  return {
    nodes,
    async refresh() {
      await (window.__superagentMultiTabRefresh as () => Promise<void>)();
    },
    show() {
      const button = nodes.get("delegate-action-toggle")!;
      button.handlers.click({ currentTarget: button });
    },
    change(next: Record<string, unknown>) { snapshot = { ...snapshot, ...next }; },
  };
}

describe("Delegate action Tray UI behavior", () => {
  it("requires explicit Show activity and never equates an uncertain click to publication", async () => {
    const app = makeTrayHarness();
    await app.refresh();
    expect(visibleText(app.nodes.get("delegate-action-history")!))
      .toContain("Select Show activity");
    expect(visibleText(app.nodes.get("delegate-action-history")!)).not.toContain("click");
    app.show();
    const history = visibleText(app.nodes.get("delegate-action-history")!);
    expect(history).toContain("click · unknown");
    expect(history).toContain("Website outcome not verified");
    expect(history).toContain("TIMEOUT");
    expect(app.nodes.get("delegate-action-toggle")!.attrs["aria-pressed"]).toBe("true");
    app.show();
    expect(visibleText(app.nodes.get("delegate-action-history")!)).not.toContain("click");
  });

  it("fails closed when telemetry is stale or unavailable", async () => {
    const app = makeTrayHarness();
    app.show();
    app.change({ observedAt: Date.now() - 60_000 });
    await app.refresh();
    expect(visibleText(app.nodes.get("delegate-action-history")!))
      .toContain("unavailable or stale");
    expect(app.nodes.get("delegate-action-status")!.textContent).toBe("Status unknown");
    app.change({ observedAt: Date.now(), actionDiagnosticsStatus: "unknown", actionDiagnostics: [] });
    await app.refresh();
    expect(visibleText(app.nodes.get("delegate-action-history")!))
      .toContain("unavailable or stale");
  });
});
