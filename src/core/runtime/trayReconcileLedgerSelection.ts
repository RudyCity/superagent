/** Selects the exactly matching journal for an explicit Tray reconciliation.
 * Upgrade and rollback share a release journal, never the lifecycle journal.
 */
export function trayReconcileLedgerPort(
  targetAction: "upgrade" | "rollback" | "start" | "stop" | "restart" | "drain" | "reload" | "recycle" | undefined,
): 45321 | 45322 {
  return targetAction === "upgrade" || targetAction === "rollback" ? 45322 : 45321;
}
