import { describe, it, expect } from "vitest";
import { formatSnapshotEntry, type SnapshotEntry } from "../src/core/tools/chromeCdpHelpers.js";

describe("chromeCdpHelpers - formatSnapshotEntry Accessibility & Form Attributes", () => {
  it("formats standard compact button with id and label", () => {
    const entry: SnapshotEntry = {
      index: 10,
      tag: "button",
      text: "Submit",
      id: "submit-btn",
      selector: "#submit-btn",
    };
    expect(formatSnapshotEntry(entry, true)).toBe('[10] <button> [id="submit-btn"] "Submit"');
  });

  it("formats compact dropdown button with collapsed state and role", () => {
    const entry: SnapshotEntry = {
      index: 31,
      tag: "button",
      text: "Tidak ada upsell",
      id: "upsell-product-select",
      role: "combobox",
      ariaExpanded: false,
      selector: "#upsell-product-select",
    };
    expect(formatSnapshotEntry(entry, true)).toBe('[31] <button> [role="combobox" id="upsell-product-select" collapsed] "Tidak ada upsell"');
  });

  it("formats compact dropdown button with expanded state and disabled attribute", () => {
    const entry: SnapshotEntry = {
      index: 32,
      tag: "button",
      text: "Options",
      disabled: true,
      ariaExpanded: true,
      selector: "button.dropdown",
    };
    expect(formatSnapshotEntry(entry, true)).toBe('[32] <button> [disabled expanded] "Options"');
  });

  it("formats full snapshot entry with accessibility attributes", () => {
    const entry: SnapshotEntry = {
      index: 5,
      tag: "div",
      text: "Option A",
      role: "option",
      disabled: false,
      ariaExpanded: false,
      id: "opt-a",
      selector: "#opt-a",
    };
    expect(formatSnapshotEntry(entry, false)).toBe('[5] <div role="option" id="opt-a" aria-expanded="false"> "Option A"');
  });
});
