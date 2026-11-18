import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync("apps/superagent-tray/ui/feedback.js", "utf8");

function setup() {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const elements: any[] = [];
  function node() {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el: any = {
      children: [] as any[], textContent: "", hidden: true, disabled: false,
      className: "", type: "",
      listeners: new Map<string, (...args: any[]) => void>(),
      classList: { add: (x: string) => classes.add(x), remove: (x: string) => classes.delete(x),
        contains: (x: string) => classes.has(x) },
      append(...items: any[]) {
        for (const item of items) { item.parent = el; el.children.push(item); }
      },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((x: any) => x !== el); },
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      getAttribute: (name: string) => attrs.get(name) ?? null,
      removeAttribute: (name: string) => attrs.delete(name),
      addEventListener: (name: string, cb: (...args: any[]) => void) => el.listeners.set(name, cb),
    };
    elements.push(el);
    return el;
  }
  const host = node();
  const writeTextMock = vi.fn().mockResolvedValue(undefined);
  const context: any = {
    document: { getElementById: (key: string) => key === "toast" ? host : null, createElement: node },
    window: {}, Date, String, Error, Number, Map, Set, Object,
    setTimeout: (cb: () => void) => { timers.set(nextTimer, cb); return nextTimer++; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  context.navigator = { clipboard: { writeText: writeTextMock } };
  context.window.navigator = context.navigator;
  vm.runInNewContext(script, context);
  return { feedback: context.window.TrayFeedback as any, host, timers, node, elements, writeTextMock, window: context.window };
}

describe("Tray shared loading and toast", () => {
  it("restores original label/disabled/ARIA and locks duplicate actions", async () => {
    const { feedback, node } = setup();
    const button = node();
    button.textContent = "Create connect QR";
    const first = feedback.begin({ key: "qr-connect", button, label: "Creating connect QR…" });
    expect(first).not.toBeNull();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Creating connect QR…");
    expect(button.classList.contains("tray-action-loading")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(feedback.isPending("qr-connect")).toBe(true);
    expect(feedback.begin({ key: "qr-connect", button, label: "Duplicate" })).toBeNull();
    first.end();
    first.end();
    expect(button.textContent).toBe("Create connect QR");
    expect(button.disabled).toBe(false);
    expect(button.classList.contains("tray-action-loading")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(feedback.isPending("qr-connect")).toBe(false);
  });

  it("caps notifications, uses text nodes, closes and clears scoped toasts", () => {
    const { feedback, host } = setup();
    const malicious = "<img src=x onerror=alert(1)>";
    expect(feedback.notify({ kind: "success", message: malicious, scope: "test" })).toBe(true);
    expect(host.children[0].children[0].textContent).toBe(malicious);
    expect(host.children[0].getAttribute("role")).toBe("status");
    feedback.notify({ kind: "error", message: "failed", scope: "test" });
    expect(host.children[1].getAttribute("role")).toBe("alert");
    feedback.notify({ kind: "warning", message: "unknown", scope: "persist", sticky: true });
    feedback.notify({ kind: "info", message: "info", scope: "test" });
    expect(host.children).toHaveLength(3);
    feedback.clearScope("test");
    expect(host.children).toHaveLength(1);
    expect(host.hidden).toBe(false);
    host.children[0].children[1].listeners.get("click")();
    expect(host.children).toHaveLength(0);
    expect(host.hidden).toBe(true);
  });

  it("deduplicates repeated polling messages and exposes true verified outcomes", async () => {
    const { feedback, host, node } = setup();
    expect(feedback.notify({ kind: "info", message: "Scanning", dedupeKey: "poll" })).toBe(true);
    expect(feedback.notify({ kind: "info", message: "Scanning", dedupeKey: "poll" })).toBe(false);
    const button = node();
    button.textContent = "Save";
    let resolve!: (value: unknown) => void;
    const task = feedback.run({
      key: "save", button, label: "Saving…", scope: "test",
      operation: () => new Promise((r) => { resolve = r; }),
      verify: (v: any) => v?.success === true, success: "Saved",
      failure: "Not saved",
    });
    expect(feedback.isPending("save")).toBe(true);
    expect(button.disabled).toBe(true);
    expect((await feedback.run({
      key: "save", button, operation: () => { throw Error("must not run"); },
    })).status).toBe("duplicate");
    resolve({ success: true });
    expect((await task).status).toBe("success");
    expect(button.disabled).toBe(false);
    expect(host.children.some((item: any) => item.children[0].textContent === "Saved")).toBe(true);
  });

  it("shows unknown status without leaking thrown errors or falsely claiming success", async () => {
    const { feedback, host } = setup();
    const result = await feedback.run({
      key: "restart", scope: "runtime", operation: async () => {
        throw Error("https://sensitive.test/?token=secret");
      },
      uncertain: () => true, warning: "Restart result unknown. Reconcile original operation ID.",
      failure: "Restart failed",
    });
    expect(result.status).toBe("uncertain");
    expect(host.children[0].children[0].textContent).toContain("unknown");
    expect(host.children[0].children[0].textContent).not.toContain("secret");
    expect(host.children[0].getAttribute("role")).toBe("alert");
  });

  it("restores button after rejected work and leaves background refresh silent", async () => {
    const { feedback, host, node } = setup();
    const button = node();
    button.textContent = "Create";
    const result = await feedback.run({
      key: "qr", button, label: "Creating…", scope: "qr",
      operation: async () => { throw Error("bad request"); },
      failure: "Cannot create QR.",
    });
    expect(result.status).toBe("error");
    expect(button.textContent).toBe("Create");
    expect(button.disabled).toBe(false);
    expect(host.children).toHaveLength(1);
    const quiet = await feedback.run({
      key: "refresh", background: true,
      operation: async () => ({ ok: true }),
      success: "This must not be displayed",
    });
    expect(quiet.status).toBe("success");
    expect(host.children).toHaveLength(1);
  });

  it("routes a warning toast using only an allowlisted source and never its message", () => {
    const { feedback, host, window } = setup();
    const opened = vi.fn(() => true);
    window.__superagentNotificationDefaultRoute = (scope: string) =>
      scope === "runtime" ? "runtime:core" : null;
    window.__superagentNotificationOpenScope = opened;
    expect(feedback.notify({
      kind: "warning", scope: "runtime", message: "https://evil.invalid/no-navigation",
    })).toBe(true);
    const warning = host.children[0];
    expect(warning.children).toHaveLength(4);
    const review = warning.children[3];
    expect(review.textContent).toBe("Review");
    review.listeners.get("click")();
    expect(opened).toHaveBeenCalledWith("runtime");
    expect(host.children).toHaveLength(0);
    feedback.notify({ kind: "error", scope: "unknown", message: "No native route" });
    expect(host.children[0].children).toHaveLength(3);
  });

  it("provides copy button on toast to copy message text and display feedback", async () => {
    const { feedback, host, writeTextMock, timers } = setup();
    expect(feedback.notify({ kind: "info", message: "Schedule status updated.", scope: "test" })).toBe(true);
    const item = host.children[0];
    expect(item).toBeDefined();
    expect(item.children).toHaveLength(3);
    const label = item.children[0];
    const dismiss = item.children[1];
    const copy = item.children[2];
    expect(label.textContent).toBe("Schedule status updated.");
    expect(dismiss.className).toBe("tray-toast-dismiss");
    expect(copy.className).toBe("tray-toast-copy");
    expect(copy.getAttribute("title")).toBe("Copy message");
    expect(copy.getAttribute("aria-label")).toBe("Copy notification message");

    await copy.listeners.get("click")();
    expect(writeTextMock).toHaveBeenCalledWith("Schedule status updated.");
    expect(copy.classList.contains("copied")).toBe(true);
    expect(copy.getAttribute("title")).toBe("Copied!");
    expect(copy.getAttribute("aria-label")).toBe("Message copied to clipboard");

    // Execute the timeout to reset copy button (last timer registered)
    const allTimers = [...timers.values()];
    const copyResetTimer = allTimers[allTimers.length - 1];
    if (copyResetTimer) copyResetTimer();
    expect(copy.classList.contains("copied")).toBe(false);
    expect(copy.getAttribute("title")).toBe("Copy message");
  });
});
