/** Conservative, read-only gate for replacing the API chat core. */
export interface CoreCutoverSnapshot {
  supervised: boolean;
  portOccupied: boolean;
  activeWorker: boolean;
  retainedWorkers: number;
  retainedLimit: number;
}
export interface CoreCutoverDecision {
  approved: boolean;
  blockers: string[];
  action: string;
}
export function assessCoreCutover(state: CoreCutoverSnapshot): CoreCutoverDecision {
  const blockers: string[] = [];
  if (!state.supervised) blockers.push(
    state.portOccupied
      ? "Public core port is occupied by an unmanaged process; never kill or adopt it implicitly."
      : "Core Supervisor is not registered on this port.");
  if (state.supervised && !state.activeWorker) {
    blockers.push("Supervisor has no verified active core worker.");
  }
  if (state.supervised &&
      (!Number.isSafeInteger(state.retainedWorkers) || !Number.isSafeInteger(state.retainedLimit) ||
      state.retainedWorkers < 0 || state.retainedLimit < 1 ||
      state.retainedWorkers >= state.retainedLimit)) {
    blockers.push("Retained worker limit reached or unknown: verified drain is required.");
  }
  return {
    approved: blockers.length === 0,
    blockers,
    action: blockers.length === 0
      ? "A supervisor-managed core restart can be requested; verify clients and rollback after rollout."
      : "Do not restart the existing process. Test a separate supervised endpoint before planning a maintenance cutover.",
  };
}
