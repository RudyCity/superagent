/**
 * Read-only activation preflight. Never terminates, starts, adopts or reloads
 * existing SuperAgent, MCP, Chrome or tunnel processes.
 */
import net from "node:net";
import { requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";
import { assessCoreCutover } from "../src/core/runtime/chatRuntimeCutover.js";

async function occupied(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}
const requested = Number(process.argv[2] || "7888");
if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
  console.error("[chat-cutover] Valid port required.");
  process.exitCode = 2;
} else {
  let supervisor;
  try { supervisor = await requestCoreSupervisor("status", requested, 2500); }
  catch { /* Absence of verified supervisor is explicitly a blocker. */ }
  const current = await occupied(requested);
  const decision = assessCoreCutover({
    supervised: Boolean(supervisor),
    portOccupied: current,
    activeWorker: Boolean(supervisor?.active?.pid),
    retainedWorkers: supervisor?.retained?.length ?? 0,
    retainedLimit: supervisor?.maxRetainedWorkers ?? 4,
  });
  console.log("[chat-cutover] publicPort=" + requested +
    " supervisorVerified=" + Boolean(supervisor) +
    " portOccupied=" + current +
    " retained=" + (supervisor?.retained?.length ?? 0));
  console.log("[chat-cutover] " + (decision.approved ? "SAFE TO REQUEST MANAGED RESTART" : "BLOCKED"));
  for (const reason of decision.blockers) console.log("[chat-cutover] blocker: " + reason);
  console.log("[chat-cutover] " + decision.action);
  if (!decision.approved) process.exitCode = 2;
}
