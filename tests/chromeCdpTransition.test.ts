import { describe, test, expect } from "vitest";
import {
  computeTransitionDiff,
  formatTransitionSummary,
  DomStateSnapshot,
} from "../src/core/tools/chromeCdpTransition.js";
import { formatContextHeader, PageOverview } from "../src/core/tools/chromeCdpHelpers.js";

describe("chromeCdpTransition", () => {
  const baseState: DomStateSnapshot = {
    url: "http://localhost:7002/admin/coupons",
    pathname: "/admin/coupons",
    search: "",
    title: "Kupon Admin",
    viewMode: "table_list_view",
    hasModal: false,
    hasDrawer: false,
    hasForm: false,
    formInputsCount: 0,
    formFields: [],
    hasTable: true,
    tableRowsCount: 5,
    headings: ["Manajemen Kupon"],
    alerts: [],
  };

  test("detects full_page_form transition when table view transitions to form view", () => {
    const formState: DomStateSnapshot = {
      ...baseState,
      viewMode: "form_view",
      hasForm: true,
      formInputsCount: 6,
      formFields: ["input:code", "select:discount_type", "input:amount"],
      hasTable: false,
      tableRowsCount: 0,
      headings: ["Tambah Kupon Baru"],
    };

    const diff = computeTransitionDiff(baseState, formState);
    expect(diff.type).toBe("full_page_form");
    expect(diff.formOpened).toBe(true);
    expect(diff.formFields).toEqual(["input:code", "select:discount_type", "input:amount"]);

    const summary = formatTransitionSummary(diff);
    expect(summary).toContain("[FULL_PAGE_FORM]");
    expect(summary).toContain("View Mode: table_list_view -> form_view");
    expect(summary).toContain("Form Fields: input:code, select:discount_type, input:amount");
  });

  test("detects modal_dialog transition when modal opens", () => {
    const modalState: DomStateSnapshot = {
      ...baseState,
      hasModal: true,
      modalTitle: "Status Berlangganan",
      viewMode: "modal_view",
    };

    const diff = computeTransitionDiff(baseState, modalState);
    expect(diff.type).toBe("modal_dialog");
    expect(diff.modalOpened).toBe(true);
    expect(diff.modalTitle).toBe("Status Berlangganan");

    const summary = formatTransitionSummary(diff);
    expect(summary).toContain("[MODAL_DIALOG]");
    expect(summary).toContain('modal dialog opened ("Status Berlangganan")');
  });

  test("detects query_change transition when search params mutate to ?action=create", () => {
    const queryState: DomStateSnapshot = {
      ...baseState,
      url: "http://localhost:7002/admin/coupons?action=create",
      search: "?action=create",
    };

    const diff = computeTransitionDiff(baseState, queryState);
    expect(diff.type).toBe("query_change");
    expect(diff.urlChanged).toBe(true);
    expect(diff.description).toContain("?action=create");
  });

  test("detects drawer_panel transition when slide-over sheet opens", () => {
    const drawerState: DomStateSnapshot = {
      ...baseState,
      hasDrawer: true,
      viewMode: "drawer_view",
    };

    const diff = computeTransitionDiff(baseState, drawerState);
    expect(diff.type).toBe("drawer_panel");
    expect(diff.description).toContain("drawer panel opened");
  });

  test("detects navigation transition when pathname changes", () => {
    const navState: DomStateSnapshot = {
      ...baseState,
      url: "http://localhost:7002/admin/partners",
      pathname: "/admin/partners",
    };

    const diff = computeTransitionDiff(baseState, navState);
    expect(diff.type).toBe("navigation");
    expect(diff.description).toContain("route navigated from '/admin/coupons' to '/admin/partners'");
  });

  test("detects toast_notification transition when new alert appears", () => {
    const alertState: DomStateSnapshot = {
      ...baseState,
      alerts: ["Kupon berhasil disimpan"],
    };

    const diff = computeTransitionDiff(baseState, alertState);
    expect(diff.type).toBe("toast_notification");
    expect(diff.description).toContain("Kupon berhasil disimpan");
  });

  test("formatContextHeader includes View Mode when present", () => {
    const overview: PageOverview = {
      title: "Admin",
      viewMode: "form_view",
      headings: [{ tag: "h1", text: "Buat Paket" }],
      alerts: ["Siap disimpan"],
    };

    const header = formatContextHeader(overview);
    expect(header).toContain("View Mode: [FORM_VIEW]");
    expect(header).toContain("[H1] Buat Paket");
    expect(header).toContain("[ALERT] Siap disimpan");
  });
});
