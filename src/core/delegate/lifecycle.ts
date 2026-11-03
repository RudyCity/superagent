import { delegateBridge } from "./bridge.js";

/**
 * Start the fixed loopback endpoint in the same process that executes delegate
 * tools. The browser extension is a client: it cannot create this listener.
 *
 * Startup is idempotent within the process. Do not bind it in unit tests or
 * when deliberately disabled by the operator.
 */
export async function startDelegateBridgeForAgentHost(
  report: (message: string) => void = (message) => console.warn(message),
): Promise<boolean> {
  if (
    process.env.VITEST ||
    process.env.NODE_ENV === "test" ||
    process.env.SUPERAGENT_DELEGATE_BRIDGE === "0"
  ) {
    return false;
  }
  try {
    await delegateBridge.start();
    return true;
  } catch (error) {
    report(
      "[Delegate] Unable to bind ws://127.0.0.1:17341: " +
      (error instanceof Error ? error.message : String(error)) +
      ". Another SuperAgent process may own the port. " +
      "This process cannot serve delegate calls until the conflict is resolved.",
    );
    return false;
  }
}
