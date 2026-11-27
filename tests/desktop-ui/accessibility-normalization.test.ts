import { describe, expect, it } from "vitest";
import {
  ACCESSIBILITY_ELEMENT_LIMIT,
  normalizeAccessibilityElements,
} from "../../src/core/desktopUi/adapters/windowsAccessibilityHost.js";

/**
 * The Windows carrier emits raw UIA signals; these tests pin the pure
 * normalization contract that decides retention and the security-relevant
 * `actionable` flag. No PowerShell is executed here.
 */

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "button",
    label: "OK",
    description: "",
    value: "",
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    enabled: true,
    offscreen: false,
    focusable: false,
    expandable: false,
    focused: false,
    automationId: "",
    runtimeId: "42.7",
    ...overrides,
  };
}

describe("accessibility element normalization", () => {
  it("normalizes role casing and the ControlType prefix, and nullifies blank text", () => {
    const [element] = normalizeAccessibilityElements([
      raw({ role: "ControlType.HYPERLINK", label: "  ", description: "Opens docs", value: "" }),
    ]);
    expect(element.role).toBe("hyperlink");
    expect(element.label).toBeNull();
    expect(element.description).toBe("Opens docs");
    expect(element.value).toBeNull();
  });

  it("strips control characters from text instead of leaking them into the snapshot", () => {
    const [element] = normalizeAccessibilityElements([
      raw({ label: "Sa\u0000ve\u007f", description: "A\u0007rea" }),
    ]);
    expect(element.label).toBe("Save");
    expect(element.description).toBe("Area");
  });

  it("drops records without a usable rectangle", () => {
    const elements = normalizeAccessibilityElements([
      raw({ bounds: undefined }),
      raw({ bounds: { x: 0, y: 0, width: 0, height: 40 } }),
      raw({ bounds: { x: 0, y: 0, width: 30, height: -1 } }),
      raw({ bounds: { x: 0, y: 0, width: Number.NaN, height: 40 } }),
      raw({ bounds: { x: "10", y: 20, width: 30, height: 40 } }),
      raw({ bounds: { x: 1, y: 2, width: 3, height: 4 } }),
    ]);
    expect(elements).toHaveLength(1);
    expect(elements[0].bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("derives the center from bounds and ignores any supplied center", () => {
    const [element] = normalizeAccessibilityElements([
      raw({ bounds: { x: 100, y: 200, width: 20, height: 10 }, center: { x: 0, y: 0 } }),
    ]);
    expect(element.center).toEqual({ x: 110, y: 205 });
  });

  it("marks enabled, on-screen interactive roles actionable", () => {
    const elements = normalizeAccessibilityElements([
      raw({ role: "button" }),
      raw({ role: "edit", runtimeId: "42.8" }),
      raw({ role: "listitem", runtimeId: "42.9" }),
    ]);
    expect(elements.map((element) => element.actionable)).toEqual([true, true, true]);
  });

  it("never marks disabled, offscreen, or non-interactive roles actionable", () => {
    const elements = normalizeAccessibilityElements([
      raw({ enabled: false }),
      raw({ offscreen: true, runtimeId: "42.8" }),
      raw({ role: "pane", runtimeId: "42.9", focusable: true }),
      raw({ role: "text", runtimeId: "42.10", label: "Body copy" }),
      raw({ role: "group", runtimeId: "42.11", focusable: true }),
    ]);
    expect(elements.map((element) => element.actionable)).toEqual([false, false, false, false, false]);
  });

  it("treats an expandable Chromium custom widget as actionable but not a plain container", () => {
    const elements = normalizeAccessibilityElements([
      raw({ role: "custom", label: "Accordion", expandable: true }),
      raw({ role: "custom", label: "Decoration", expandable: false, runtimeId: "42.8" }),
      raw({ role: "pane", label: "Layout", expandable: true, runtimeId: "42.9" }),
    ]);
    expect(elements.map((element) => element.actionable)).toEqual([true, false, false]);
  });

  it("keeps labeled offscreen content as read-only context and drops unlabeled structure", () => {
    const elements = normalizeAccessibilityElements([
      raw({ role: "text", label: "Scrolled out line", offscreen: true }),
      raw({ role: "pane", label: "", offscreen: true, runtimeId: "42.8" }),
      raw({ role: "button", label: "Hidden submit", offscreen: true, runtimeId: "42.9" }),
      raw({ role: "text", label: "Disabled hidden text", offscreen: true, enabled: false, runtimeId: "42.10" }),
    ]);
    expect(elements.map((element) => element.label)).toEqual(["Scrolled out line", "Hidden submit"]);
    expect(elements.every((element) => element.actionable === false)).toBe(true);
  });

  it("drops offscreen content entirely when the caller opts out", () => {
    const elements = normalizeAccessibilityElements(
      [raw({ role: "text", label: "Scrolled out line", offscreen: true }), raw({ runtimeId: "42.8" })],
      { retainOffscreen: false },
    );
    expect(elements).toHaveLength(1);
    expect(elements[0].actionable).toBe(true);
  });

  it("preserves the legacy one-shot actionable flag when raw signals are absent but still enforces the role allowlist", () => {
    const elements = normalizeAccessibilityElements([
      {
        role: "button",
        label: "Legacy",
        actionable: true,
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        nativeRef: "automationId:Legacy",
      },
      {
        role: "button",
        label: "Legacy offscreen",
        actionable: true,
        offscreen: true,
        bounds: { x: 0, y: 20, width: 10, height: 10 },
      },
      {
        role: "pane",
        label: "Legacy pane",
        actionable: true,
        bounds: { x: 0, y: 40, width: 10, height: 10 },
      },
      {
        role: "button",
        label: "Legacy not actionable",
        actionable: false,
        bounds: { x: 0, y: 60, width: 10, height: 10 },
      },
    ]);
    expect(elements.map((element) => element.actionable)).toEqual([true, false, false, false]);
  });

  it("builds nativeRef from AutomationId first, then RuntimeId, then the legacy value", () => {
    const elements = normalizeAccessibilityElements([
      raw({ automationId: "SaveButton", runtimeId: "1.2" }),
      raw({ automationId: "", runtimeId: "7.9", label: "Runtime only" }),
      raw({ automationId: "", runtimeId: "", nativeRef: "automationId:Legacy", label: "Legacy" }),
      raw({ automationId: "", runtimeId: "", nativeRef: "bad\u0000ref", label: "Broken" }),
    ]);
    expect(elements.map((element) => element.nativeRef)).toEqual([
      "automationId:SaveButton",
      "runtimeId:7.9",
      "automationId:Legacy",
      undefined,
    ]);
  });

  it("deduplicates merged ControlView and RawView records, keeping the primary view", () => {
    const control = raw({ runtimeId: "9.1", description: "from control view", actionable: undefined });
    const rawDuplicate = raw({ runtimeId: "9.1", description: "from raw view", actionable: undefined });
    const elements = normalizeAccessibilityElements([control, rawDuplicate]);
    expect(elements).toHaveLength(1);
    expect(elements[0].description).toBe("from control view");
  });

  it("deduplicates geometry-only records when no native reference exists", () => {
    const elements = normalizeAccessibilityElements([
      raw({ runtimeId: "", automationId: "", label: "Same" }),
      raw({ runtimeId: "", automationId: "", label: "Same" }),
      raw({ runtimeId: "", automationId: "", label: "Same", bounds: { x: 0, y: 0, width: 5, height: 5 } }),
    ]);
    expect(elements).toHaveLength(2);
  });

  it("bounds the merged snapshot while preserving actionable and focused controls in document order", () => {
    const records: Record<string, unknown>[] = [];
    for (let index = 0; index < 10; index++) {
      records.push(raw({
        role: "text",
        label: `line ${index}`,
        runtimeId: `bound.${index}`,
        actionable: undefined,
        enabled: undefined,
        offscreen: undefined,
        focused: index === 9,
      }));
    }
    records[9] = raw({
      role: "button",
      label: "critical",
      runtimeId: "bound.9",
      focused: true,
      actionable: true,
    });
    const elements = normalizeAccessibilityElements(records, { maxElements: 4 });
    expect(elements).toHaveLength(4);
    expect(elements.map((element) => element.label)).toEqual(["line 0", "line 1", "line 2", "critical"]);
    expect(elements[3].actionable).toBe(true);
  });

  it("keeps a keyboard-focusable control when the bound would otherwise truncate it", () => {
    const records: Record<string, unknown>[] = [];
    for (let index = 0; index < 6; index++) {
      records.push(raw({
        role: "text",
        label: `body ${index}`,
        runtimeId: `focus.${index}`,
        focusable: false,
      }));
    }
    records.push(raw({
      role: "text",
      label: "focusable inline link target",
      runtimeId: "focus.6",
      focusable: true,
    }));
    const elements = normalizeAccessibilityElements(records, { maxElements: 3 });
    expect(elements.map((element) => element.label)).toEqual(["body 0", "body 1", "focusable inline link target"]);
  });

  it("defaults to the documented hard element bound", () => {
    expect(ACCESSIBILITY_ELEMENT_LIMIT).toBe(2000);
    const records = Array.from({ length: ACCESSIBILITY_ELEMENT_LIMIT + 25 }, (_, index) =>
      raw({ role: "text", label: `n${index}`, runtimeId: `default.${index}`, actionable: undefined }));
    expect(normalizeAccessibilityElements(records)).toHaveLength(ACCESSIBILITY_ELEMENT_LIMIT);
  });

  it("emits exactly the public snapshot element shape", () => {
    const [complete] = normalizeAccessibilityElements([
      raw({ automationId: "Id", focused: true }),
    ]);
    expect(Object.keys(complete).sort()).toEqual([
      "actionable", "bounds", "center", "description", "focused", "label", "nativeRef", "role", "value",
    ]);
    const [sparse] = normalizeAccessibilityElements([
      { role: "text", bounds: { x: 0, y: 0, width: 2, height: 2 } },
    ]);
    expect(Object.keys(sparse).sort()).toEqual([
      "actionable", "bounds", "center", "description", "label", "role", "value",
    ]);
  });

  it("ignores malformed records instead of throwing", () => {
    const elements = normalizeAccessibilityElements([
      null,
      undefined,
      "button",
      42,
      [],
      {},
      { role: 42, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      raw({ bounds: null }),
    ]);
    expect(elements).toEqual([]);
  });

  it("skips records whose role is an empty string", () => {
    expect(normalizeAccessibilityElements([raw({ role: "  " })])).toEqual([]);
  });
});
