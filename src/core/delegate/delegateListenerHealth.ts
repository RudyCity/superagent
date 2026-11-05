/** Bounded read-only loopback TCP inspection.
 * A successful connection proves only port occupation, NEVER ownership.
 */
import net from "node:net";

export type DelegatePortProbe = "occupied" | "free" | "unknown";

export async function probeDelegateListenerPort(port = 17341, timeoutMs = 500): Promise<DelegatePortProbe> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 2000)
    throw new Error("DELEGATE_PORT_PROBE_INVALID_ARGUMENT");
  return new Promise<DelegatePortProbe>(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (state: DelegatePortProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "free" : "unknown"));
    socket.setTimeout(timeoutMs, () => finish("unknown"));
  });
}

export async function inspectDelegateListenerHealth(
  running: boolean, desiredEnabled: boolean,
  probe: () => Promise<DelegatePortProbe> = () => probeDelegateListenerPort(),
) {
  const portState = running ? "occupied" : await probe();
  const portOccupied = portState === "occupied";
  const ownerMismatch = !running && portOccupied;
  return {
    desiredEnabled,
    healthy: running === desiredEnabled &&
      (running || portState === "free"),
    portProbe: portState,
    portOwnerUnknown: ownerMismatch,
  };
}
