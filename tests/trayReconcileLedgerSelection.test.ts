import { describe, expect, it } from "vitest";
import { trayReconcileLedgerPort } from "../src/core/runtime/trayReconcileLedgerSelection.js";

describe("Tray reconciliation ledger route", () => {
  it("uses the release journal for upgrade AND rollback", () => {
    expect(trayReconcileLedgerPort("upgrade")).toBe(45322);
    expect(trayReconcileLedgerPort("rollback")).toBe(45322);
  });
  it("uses lifecycle journal for native start/stop/restart", () => {
    expect(trayReconcileLedgerPort("start")).toBe(45321);
    expect(trayReconcileLedgerPort("stop")).toBe(45321);
    expect(trayReconcileLedgerPort("restart")).toBe(45321);
    expect(trayReconcileLedgerPort(undefined)).toBe(45321);
  });
});
