import { describe, it, expect } from "vitest";
import {
  buildSelectOptionJs,
  buildCheckFormJs,
  executeSelectOptionCommand,
  executeCheckFormCommand,
} from "../src/core/tools/chromeCdpForm.js";
import { snapshotStore } from "../src/core/tools/chromeCdpHelpers.js";

describe("chromeCdpForm", () => {
  const dummyTarget = {
    id: "tab-test-1",
    type: "page",
    title: "Checkout",
    url: "https://example.com/checkout",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab-test-1",
  };

  it("buildSelectOptionJs generates valid script with selector and target option", () => {
    const js = buildSelectOptionJs("#plan-select", "Paket Pro", false, 1500);
    expect(js).toContain("#plan-select");
    expect(js).toContain("Paket Pro");
    expect(js).toContain("options");
    expect(js).toContain("aria-expanded");
  });

  it("buildCheckFormJs generates valid form auditing script", () => {
    const js = buildCheckFormJs("form.checkout-form");
    expect(js).toContain("form.checkout-form");
    expect(js).toContain("missingRequired");
    expect(js).toContain("submitButtons");
    expect(js).toContain("readyToSubmit");
  });

  it("executeSelectOptionCommand succeeds when option matches", async () => {
    snapshotStore.set("tab-test-1", [
      { index: 0, tag: "button", text: "Select Plan", selector: "#plan-select", role: "combobox" },
    ]);

    const mockCdpSend = async () => {
      return {
        result: {
          value: JSON.stringify({
            ok: true,
            type: "custom",
            selected: "Paket Pro",
            availableCount: 3,
          }),
        },
      };
    };

    const res = await executeSelectOptionCommand(mockCdpSend as any, dummyTarget, {
      index: 0,
      option: "Paket Pro",
    });

    expect(res).toContain('selected option "Paket Pro" via custom dropdown');
    expect(res).toContain("3 options available");
  });

  it("executeSelectOptionCommand lists available options when option is not found", async () => {
    snapshotStore.set("tab-test-1", [
      { index: 0, tag: "button", text: "Select Plan", selector: "#plan-select", role: "combobox" },
    ]);

    const mockCdpSend = async () => {
      return {
        result: {
          value: JSON.stringify({
            ok: false,
            reason: "Option 'Paket Ultra' not found in dropdown.",
            availableOptions: ["Paket Basic", "Paket Pro"],
          }),
        },
      };
    };

    const res = await executeSelectOptionCommand(mockCdpSend as any, dummyTarget, {
      index: 0,
      option: "Paket Ultra",
    });

    expect(res).toContain("select_option failed");
    expect(res).toContain('Available options: "Paket Basic", "Paket Pro"');
  });

  it("executeCheckFormCommand provides clear readiness audit and missing fields", async () => {
    const mockCdpSend = async () => {
      return {
        result: {
          value: JSON.stringify({
            ok: true,
            status: "INCOMPLETE",
            readyToSubmit: false,
            fieldCount: 4,
            filledCount: 2,
            missingRequiredCount: 2,
            missingRequired: [
              { tag: "input", type: "email", label: "Email Address", isEmpty: true },
              { tag: "input", type: "tel", label: "WhatsApp Number", isEmpty: true },
            ],
            visibleErrors: ["Email is required"],
            submitButtons: [{ text: "Bayar Sekarang", disabled: true }],
          }),
        },
      };
    };

    const res = await executeCheckFormCommand(mockCdpSend as any, dummyTarget, {});
    expect(res).toContain("[Form Readiness Check] Status: INCOMPLETE");
    expect(res).toContain('"Email Address": EMPTY');
    expect(res).toContain('"WhatsApp Number": EMPTY');
    expect(res).toContain('"Bayar Sekarang": DISABLED');
    expect(res).toContain("Verdict: Form is not ready.");
  });

  it("executeCheckFormCommand reports ready when all required fields are filled", async () => {
    const mockCdpSend = async () => {
      return {
        result: {
          value: JSON.stringify({
            ok: true,
            status: "READY",
            readyToSubmit: true,
            fieldCount: 3,
            filledCount: 3,
            missingRequiredCount: 0,
            missingRequired: [],
            visibleErrors: [],
            submitButtons: [{ text: "Bayar Sekarang", disabled: false }],
          }),
        },
      };
    };

    const res = await executeCheckFormCommand(mockCdpSend as any, dummyTarget, {});
    expect(res).toContain("[Form Readiness Check] Status: READY");
    expect(res).toContain("All required fields are completed.");
    expect(res).toContain('"Bayar Sekarang": ENABLED (Ready to click)');
    expect(res).toContain("Verdict: Form is completely filled and ready for submission.");
  });
});
