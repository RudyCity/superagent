import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const componentSource = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/action-menu.js"), "utf8",
);

function setupComponent() {
  const win: any = {
    innerWidth: 360, innerHeight: 720,
    addEventListener: vi.fn(),
  };
  vm.runInNewContext(componentSource, { window: win });
  return win.SuperAgentActionMenu;
}

function makeMenuHarness() {
  const component = setupComponent();
  const handlers: Record<string, (event: any) => void> = {};
  const doc: any = {
    activeElement: null,
    documentElement: { clientWidth: 360, clientHeight: 720 },
    addEventListener: vi.fn((event, fn) => { handlers[event] = fn; }),
  };
  const win: any = { innerWidth: 360, innerHeight: 720, addEventListener: vi.fn() };
  const item1: any = { focus: vi.fn(() => { doc.activeElement = item1; }) };
  const item2: any = { focus: vi.fn(() => { doc.activeElement = item2; }) };
  const menu: any = {
    hidden: true,
    style: { left: "", top: "" },
    offsetWidth: 220,
    offsetHeight: 300,
    querySelector: vi.fn(() => item1),
    querySelectorAll: vi.fn(() => [item1, item2]),
  };
  const owner: any = { querySelector: vi.fn(() => menu) };
  const trigger: any = {
    state: "false",
    setAttribute: vi.fn((name, value) => { if (name === "aria-expanded") trigger.state = value; }),
    focus: vi.fn(() => { doc.activeElement = trigger; }),
    getBoundingClientRect: () => ({
      left: 304, right: 340, top: 685, bottom: 719,
    }),
    closest: (selector: string) =>
      selector === ".sa-action-menu-trigger" ? trigger :
      selector === ".sa-action-menu" ? owner : null,
  };
  const itemTarget = {
    closest: (selector: string) => selector === ".sa-action-menu-item" ? item1 : null,
  };
  const outside = { closest: () => null };
  const controller = component.createController(doc, win);
  return { controller, handlers, win, doc, trigger, owner, menu, item1, item2, itemTarget, outside };
}

describe("reusable Tray action menu", () => {
  it("renders one accessible ellipsis trigger and hidden menu per task", () => {
    const component = setupComponent();
    const html = component.render({
      id: "external-win-31777",
      label: 'python <server> "A"',
      items: [
        { label: "Logs unavailable", disabled: true, className: "terminal-unavailable-btn",
          title: 'Unavailable "outside"' },
        { separator: true },
        { label: "Stop", danger: true, className: "terminal-external-btn",
          data: { "task-id": "external-win-31777", action: "stop" } },
      ],
      note: "External · confirm before stopping",
    });
    expect(html).toContain('class="sa-action-menu-trigger"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Actions for python &lt;server&gt; &quot;A&quot;"');
    expect(html).toContain('class="sa-action-menu-popover"');
    expect(html).toContain("hidden");
    expect(html).toContain("disabled aria-disabled");
    expect(html).toContain('data-task-id="external-win-31777" data-action="stop"');
    expect(html).toContain("sa-action-menu-item terminal-external-btn is-danger");
    expect(html).toContain('role="separator"');
    expect(html).toContain("External · confirm before stopping");
    expect(html).not.toContain("<server>");
  });

  it("opens above the bottom row, clamps horizontally, and restores focus on Escape", () => {
    const h = makeMenuHarness();
    const event = { target: h.trigger, preventDefault: vi.fn() };
    expect(h.controller.handleClick(event)).toBe(true);
    expect(h.controller.isOpen()).toBe(true);
    expect(h.trigger.state).toBe("true");
    expect(h.menu.hidden).toBe(false);
    expect(Number.parseInt(h.menu.style.left, 10)).toBeGreaterThanOrEqual(8);
    expect(Number.parseInt(h.menu.style.left, 10)).toBeLessThanOrEqual(132);
    expect(Number.parseInt(h.menu.style.top, 10)).toBeLessThan(685);
    expect(h.item1.focus).toHaveBeenCalledOnce();

    const move = { target: h.itemTarget, key: "ArrowDown", preventDefault: vi.fn() };
    h.handlers.keydown(move);
    expect(move.preventDefault).toHaveBeenCalledOnce();
    expect(h.item2.focus).toHaveBeenCalledOnce();

    const escape = { target: h.itemTarget, key: "Escape", preventDefault: vi.fn() };
    h.handlers.keydown(escape);
    expect(h.controller.isOpen()).toBe(false);
    expect(h.menu.hidden).toBe(true);
    expect(h.menu.style.left).toBe("");
    expect(h.trigger.state).toBe("false");
    expect(h.trigger.focus).toHaveBeenCalledOnce();
  });

  it("closes on outside click and on selected item without swallowing caller actions", () => {
    const h = makeMenuHarness();
    h.controller.handleClick({ target: h.trigger });
    expect(h.controller.handleClick({ target: h.itemTarget })).toBe(false);
    expect(h.controller.isOpen()).toBe(false);
    h.controller.handleClick({ target: h.trigger });
    h.handlers.click({ target: h.outside });
    expect(h.controller.isOpen()).toBe(false);
    h.controller.handleClick({ target: h.trigger });
    h.handlers.keydown({ target: h.itemTarget, key: "Tab" });
    expect(h.controller.isOpen()).toBe(false);
  });

  it("portals the popup beyond overflow-hidden panels and restores it on close", () => {
    const h = makeMenuHarness();
    h.doc.body = { appendChild: vi.fn() };
    h.owner.appendChild = vi.fn();
    expect(h.controller.handleClick({ target: h.trigger })).toBe(true);
    expect(h.doc.body.appendChild).toHaveBeenCalledWith(h.menu);
    expect(h.controller.isOpen()).toBe(true);
    expect(h.controller.handleClick({ target: h.itemTarget })).toBe(false);
    expect(h.owner.appendChild).toHaveBeenCalledWith(h.menu);
    expect(h.menu.hidden).toBe(true);
    expect(h.trigger.focus).toHaveBeenCalledOnce();
  });

  it("toggles the same trigger without losing its portaled popup", () => {
    const h = makeMenuHarness();
    h.doc.body = { appendChild: vi.fn() };
    h.owner.appendChild = vi.fn();
    h.controller.handleClick({ target: h.trigger });
    h.controller.handleClick({ target: h.trigger });
    expect(h.controller.isOpen()).toBe(false);
    expect(h.owner.appendChild).toHaveBeenCalledWith(h.menu);
    expect(h.trigger.state).toBe("false");
  });

  it("ships the component before terminal controller and uses fixed positioning", () => {
    const html = fs.readFileSync(
      path.resolve("apps/superagent-tray/ui/index.html"), "utf8",
    );
    const css = fs.readFileSync(
      path.resolve("apps/superagent-tray/ui/styles.css"), "utf8",
    );
    expect(html.indexOf('src="./action-menu.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="./action-menu.js"'))
      .toBeLessThan(html.indexOf('src="./terminal.js"'));
    expect(css).toMatch(/\.sa-action-menu-popover\s*\{[^}]*position:\s*fixed/s);
    expect(css).toContain(".sa-action-menu-popover[hidden]");
  });
});
