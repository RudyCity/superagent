/**
 * Conservative rolling-generation policy. A previous worker is NOT destroyed
 * by this module: session affinity and untracked external tasks may still
 * depend on it. Generation cleanup needs a separate verified ownership lease.
 */
export const MAX_RETAINED_CORE_WORKERS = 4;

export interface CoreGenerationIdentity {
  pid: number;
  port: number;
  since: number;
}

export function mayCreateCoreGeneration(retainedCount: number): boolean {
  return Number.isSafeInteger(retainedCount) && retainedCount >= 0 &&
    retainedCount < MAX_RETAINED_CORE_WORKERS;
}

export function rollbackCandidates<T extends CoreGenerationIdentity>(
  retained: readonly T[],
  currentPid: number,
): T[] {
  return retained.filter(item => item.pid !== currentPid).slice().reverse();
}

export function applyCoreRollback<T extends CoreGenerationIdentity>(
  active: T,
  retained: readonly T[],
  candidatePid: number,
  activeAlive: boolean,
): { active: T; retained: T[] } | undefined {
  const candidate = retained.find(item => item.pid === candidatePid);
  if (!candidate || candidate.pid === active.pid) return undefined;
  const nextRetained = retained.filter(item => item.pid !== candidate.pid);
  if (activeAlive && !nextRetained.some(item => item.pid === active.pid)) {
    nextRetained.push(active);
  }
  return { active: candidate, retained: nextRetained };
}
