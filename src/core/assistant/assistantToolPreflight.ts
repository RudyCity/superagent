/** Detached-task-only pre-execution barrier.
 * No global permission changes. Generic agents and Muse have no registered
 * gate; a registered detached worker must durably log before tool.execute.
 */
export type DetachedToolCall = { id: string; name: string };
export type DetachedToolPreflight = (call: DetachedToolCall) => Promise<void>;
export type DetachedToolReceipt = (call: DetachedToolCall & { isError: boolean }) => Promise<void>;
const gates = new WeakMap<object, {
  preflight: DetachedToolPreflight; receipt?: DetachedToolReceipt;
}>();

/** Receipt callback is bound to the same trusted detached Agent as preflight. */
export function setDetachedToolPreflight(agent: object, gate: DetachedToolPreflight,
  receipt?: DetachedToolReceipt): () => void {
  if (gates.has(agent)) throw Error("Detached execution preflight already registered");
  gates.set(agent, { preflight: gate, receipt });
  return () => { gates.delete(agent); };
}
export async function runDetachedToolPreflight(
  agent: object | null | undefined, call: DetachedToolCall,
): Promise<void> {
  if (!agent) return;
  const gate = gates.get(agent);
  if (gate) await gate.preflight(call);
}
/** Only after authorized adapter + hooks; not provider-confirmed remote effects. */
export async function runDetachedToolReceipt(
  agent: object | null | undefined, call: DetachedToolCall & { isError: boolean },
): Promise<void> {
  if (!agent) return;
  const gate = gates.get(agent);
  if (gate?.receipt) await gate.receipt(call);
}
