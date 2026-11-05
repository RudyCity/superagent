/** Explicit, durable Delegate lifecycle changes. Transient supervisor operations
 * require an internal inspection capability and never mutate user preferences.
 */
import { readDelegateListenerPreference, writeDelegateListenerPreference } from "./delegateListenerPreference.js";

export interface DelegateBridgeLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
  getStatus(): { running: boolean; pendingRequests: number };
  /** Must atomically block new RPC and reject if any RPC remains active. */
  quiesceForStop?(): void;
  /** Roll back only the acceptance barrier when Stop failed before completion. */
  resumeAfterRejectedStop?(): void;
}

const transitions = new WeakSet<DelegateBridgeLifecycle>();

export async function applyDelegateListenerAction(
  bridge: DelegateBridgeLifecycle,
  action: "start" | "stop",
  options: {
    transient?: boolean;
    recover?: () => Promise<void>;
    stopStale?: () => Promise<void>;
  } = {},
): Promise<void> {
  if (action !== "start" && action !== "stop")
    throw new Error("DELEGATE_LISTENER_INVALID_ACTION");
  if (transitions.has(bridge)) throw new Error("DELEGATE_LISTENER_TRANSITION_BUSY");
  transitions.add(bridge);
  let quiesced = false;
  try {
    const before = options.transient ? undefined : readDelegateListenerPreference();
    try {
      if (action === "stop") {
        if (bridge.quiesceForStop) {
          bridge.quiesceForStop(); // synchronous, before any awaited work
          quiesced = true;
        } else if (bridge.getStatus().pendingRequests > 0) {
          throw new Error("DELEGATE_BRIDGE_BUSY");
        }
      }
      if (!options.transient) writeDelegateListenerPreference(action === "start");
      if (action === "stop") {
        if (!bridge.getStatus().running && !options.transient && options.stopStale)
          await options.stopStale();
        await bridge.close();
        quiesced = false;
      } else {
        try { await bridge.start(); }
        catch (error) {
          if (!options.transient && options.recover &&
              /DELEGATE_BRIDGE_BIND_FAILED|EADDRINUSE|address already in use/i.test(String(error)))
            await options.recover();
          else throw error;
        }
      }
    } catch (error) {
      if (quiesced) bridge.resumeAfterRejectedStop?.();
      if (before !== undefined) {
        try { writeDelegateListenerPreference(before); }
        catch { throw new Error("DELEGATE_LISTENER_ACTION_AND_PREFERENCE_ROLLBACK_FAILED"); }
      }
      throw error;
    }
  } finally {
    transitions.delete(bridge);
  }
}
