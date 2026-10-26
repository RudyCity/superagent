/** T-Line-only, in-memory pending approval lifecycle.
 * The owning Core prompt remains the authority; these records are observations.
 * Never persist raw tool arguments, approval IDs or description in the journal.
 */
export type ApprovalState = 'pending' | 'approved' | 'approved_session' | 'denied' | 'expired' | 'cancelled';
export type ApprovalRecord = {
  permissionId: string; sessionId: string; workspace: string;
  state: ApprovalState; requestedAt: number; updatedAt: number; expiresAt: number;
};
const entries = new Map<string, ApprovalRecord>();
const ttl = 5 * 60_000;
const keepResolved = 10 * 60_000;
export function registerTlineApproval(permissionId: string, sessionId: string, workspace: string,
  onExpire: () => void, now = Date.now()): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(permissionId) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !workspace) return;
  const record: ApprovalRecord = {
    permissionId, sessionId, workspace, state: 'pending',
    requestedAt: now, updatedAt: now, expiresAt: now + ttl,
  };
  entries.set(permissionId, record);
  const timer = setTimeout(() => {
    const current = entries.get(permissionId);
    if (current === record && current.state === 'pending') {
      current.state = 'expired'; current.updatedAt = Date.now();
      onExpire();
    }
  }, ttl);
  timer.unref?.();
  pruneTlineApprovals();
}
export function decideTlineApproval(permissionId: string, sessionId: string, workspace: string,
  decision: 'approved' | 'approved_session' | 'denied' | 'cancelled'): ApprovalRecord | null {
  const record = entries.get(permissionId);
  if (!record || record.sessionId !== sessionId ||
      record.workspace.toLowerCase() !== workspace.toLowerCase() ||
      record.state !== 'pending') return null;
  if (record.expiresAt <= Date.now()) { record.state = 'expired'; return null; }
  record.state = decision; record.updatedAt = Date.now();
  return { ...record };
}
// Aborting a session settles historical UI state; it never resolves/executes a
// pending tool itself (the owning server does that independently).
export function cancelTlineApproval(permissionId: string, sessionId?: string,
  workspace?: string): boolean {
  return !!sessionId && !!workspace &&
    !!decideTlineApproval(permissionId, sessionId, workspace, 'cancelled');
}
export function getTlineApproval(permissionId: string) { return entries.get(permissionId); }
export function listTlineApprovals(sessionId: string, workspace: string) {
  pruneTlineApprovals();
  return [...entries.values()].filter(e =>
    e.sessionId === sessionId && e.workspace.toLowerCase() === workspace.toLowerCase())
    .slice(-40).map(({ permissionId, state, requestedAt, updatedAt, expiresAt }) =>
      ({ permissionId, state, requestedAt, updatedAt, expiresAt }));
}
function pruneTlineApprovals() {
  const now = Date.now();
  for (const [id, record] of entries)
    if (record.state !== 'pending' && now - record.updatedAt > keepResolved)
      entries.delete(id);
}
