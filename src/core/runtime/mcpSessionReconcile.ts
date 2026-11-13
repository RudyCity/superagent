/**
 * Fail-closed reconciliation of private MCP owner session affinity.
 * Worker session IDs are exchanged only over authenticated local child IPC.
 * Never create sessions, reroute tool calls or retry an HTTP request here.
 */
export function findOrphanedMcpAffinities(input: {
  ownerIds: readonly string[];
  workerIds: unknown;
  workerCount: number;
  registeredAt: ReadonlyMap<string, number>;
  inFlight: ReadonlyMap<string, number>;
  snapshotAt: number;
  graceMs?: number;
}): string[] {
  const {ownerIds, workerIds, workerCount, registeredAt, inFlight, snapshotAt} = input;
  if (!Number.isSafeInteger(workerCount) || workerCount < 0 || workerCount > 32 ||
      !Number.isSafeInteger(snapshotAt) || snapshotAt <= 0 ||
      !Array.isArray(workerIds) || workerIds.length !== workerCount ||
      new Set(workerIds).size !== workerIds.length ||
      !workerIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 256)) {
    return [];
  }
  const graceMs = input.graceMs ?? 1500;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) return [];
  const active = new Set<string>(workerIds);
  return ownerIds.filter(id => {
    if (active.has(id) || (inFlight.get(id) ?? 0) > 0) return false;
    const added = registeredAt.get(id);
    // Missing identity age is uncertain; never infer an orphan from it.
    return added !== undefined && Number.isSafeInteger(added) &&
      snapshotAt - added >= graceMs;
  });
}
