/** Detached-task-only pre-execution barrier.
 * No global permission changes. Generic agents and Muse have no registered
 * gate; a registered detached worker must durably log before tool.execute.
 */
export type DetachedToolPreflight = (call: { id: string; name: string }) => Promise<void>;
const gates = new WeakMap<object, DetachedToolPreflight>();

export function setDetachedToolPreflight(agent: object, gate: DetachedToolPreflight): () => void {
  if (gates.has(agent)) throw Error("Detached execution preflight already registered");
  gates.set(agent, gate);
  return () => { gates.delete(agent); };
}
export async function runDetachedToolPreflight(
  agent: object | null | undefined, call: { id: string; name: string },
): Promise<void> {
  if (!agent) return;
  const gate = gates.get(agent);
  if (gate) await gate(call);
}
