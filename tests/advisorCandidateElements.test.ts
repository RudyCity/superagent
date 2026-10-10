import { describe, it, expect, beforeEach } from "vitest";
import {
  getCandidateBrowserElements,
  generateCycleSuggestion,
  generateRecoverySuggestion,
} from "../src/core/advisorHelpers.js";
import { snapshotStore } from "../src/core/tools/chromeCdpHelpers.js";

describe("advisor candidate elements recommendation", () => {
  beforeEach(() => {
    snapshotStore.clear();
    snapshotStore.set("target-1", [
      { index: 15, tag: "input", text: "", placeholder: "Email", selector: "#email", type: "email" },
      { index: 31, tag: "button", text: "Tidak ada upsell", selector: "#upsell-btn", role: "button" },
      { index: 32, tag: "button", text: "Bayar Sekarang", selector: "#submit-btn", role: "button" },
      { index: 40, tag: "a", text: "Syarat & Ketentuan", selector: "a.terms", role: "link" },
    ]);
  });

  it("extracts candidate elements excluding the stuck target element", () => {
    const candidates = getCandidateBrowserElements("element [31]", 3);
    expect(candidates).toHaveLength(3);
    // Element 31 should be excluded
    expect(candidates.some((c) => c.includes("[31]"))).toBe(false);
    // Candidates should include element 15, 32, 40
    expect(candidates.some((c) => c.includes("[15]"))).toBe(true);
    expect(candidates.some((c) => c.includes("[32]"))).toBe(true);
    expect(candidates.some((c) => c.includes("[40]"))).toBe(true);
  });

  it("generateCycleSuggestion includes alternative elements and check_form recommendation", () => {
    const msg = generateCycleSuggestion(["control_chrome_cdp"], "element [31]");
    expect(msg).toContain("Do not alternate between the same repeated browser actions on element [31]");
    expect(msg).toContain("Candidate alternative elements:");
    expect(msg).toContain("[32] <button> \"Bayar Sekarang\"");
    expect(msg).toContain("run 'check_form'");
  });

  it("generateRecoverySuggestion includes alternative elements and form diagnostic suggestion", () => {
    const msg = generateRecoverySuggestion(["control_chrome_cdp"], false, "element [31]");
    expect(msg).toContain("Page content or state has not changed after interacting with element [31]");
    expect(msg).toContain("Candidate alternative elements:");
    expect(msg).toContain("check_form");
  });
});
